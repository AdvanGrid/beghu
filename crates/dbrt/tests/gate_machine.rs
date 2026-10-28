//! The per-account gate as a pure state machine: events in, effects out, time passed in.

use dbrt::gate::{Caller, Config, Effect, Event, Gate, Refusal, Status};
use dbrt::migrations::{Kind, MigError, Migration};
use std::time::Duration;

const fn m(version: u32, kind: Kind) -> Migration {
    Migration {
        version,
        name: "step",
        kind,
        sql: "",
    }
}
static V2: [Migration; 2] = [m(1, Kind::InPlace), m(2, Kind::InPlace)];
static V2_REBUILD: [Migration; 2] = [m(1, Kind::InPlace), m(2, Kind::Rebuild)];

const fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}
const fn s(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn gate(migs: &'static [Migration]) -> Gate {
    Gate::new(migs, Config::default())
}

fn request(id: u64) -> Event {
    Event::Use {
        id,
        caller: Caller::Request,
    }
}

fn webhook(id: u64) -> Event {
    Event::Use {
        id,
        caller: Caller::Webhook,
    }
}

fn still_updating(id: u64) -> Effect {
    Effect::Refuse {
        id,
        why: Refusal::StillUpdating { retry_after: s(2) },
    }
}

fn transient() -> Event {
    Event::Migrated(Err(MigError::Transient("disk I/O error".into())))
}

fn retrying(id: u64, retry_after: Duration) -> Effect {
    Effect::Refuse {
        id,
        why: Refusal::Retrying {
            error: "disk I/O error".into(),
            retry_after,
        },
    }
}

#[test]
fn the_first_use_opens_the_file_and_everyone_waits_for_that_one_check() {
    let mut g = gate(&V2);
    assert_eq!(g.handle(s(0), request(1)), [Effect::Open]);
    assert_eq!(g.handle(ms(5), webhook(2)), []);
    assert_eq!(
        g.handle(ms(10), Event::Opened(Ok(Some(2)))),
        [Effect::Serve { id: 1 }, Effect::Serve { id: 2 }]
    );
    assert_eq!(g.handle(ms(20), request(3)), [Effect::Serve { id: 3 }]);
}

#[test]
fn an_old_file_migrates_shows_updating_after_200_ms_and_turns_requests_away_at_10_s() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    assert_eq!(
        g.handle(s(0), Event::Opened(Ok(Some(1)))),
        [Effect::Migrate { from: 1, to: 2 }]
    );
    g.handle(s(1), webhook(2));

    assert_eq!(g.next_deadline(), Some(ms(200)));
    assert_eq!(
        g.handle(ms(200), Event::Tick),
        [Effect::Status(Some(Status::Updating))]
    );
    assert_eq!(g.next_deadline(), Some(s(10)));
    assert_eq!(g.handle(s(10), Event::Tick), [still_updating(1)]);
    assert_eq!(g.next_deadline(), None, "the webhook keeps waiting");

    assert_eq!(
        g.handle(s(30), Event::Migrated(Ok(()))),
        [Effect::Status(None), Effect::Serve { id: 2 }]
    );
}

#[test]
fn a_request_waiting_on_the_open_is_turned_away_at_10_s() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(1), webhook(2));
    assert_eq!(g.next_deadline(), Some(s(10)));
    assert_eq!(g.handle(s(10), Event::Tick), [still_updating(1)]);
    assert_eq!(
        g.handle(s(12), Event::Opened(Ok(Some(2)))),
        [Effect::Serve { id: 2 }]
    );
}

#[test]
fn a_request_waiting_on_a_new_mirror_is_turned_away_at_10_s() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    assert_eq!(
        g.handle(s(0), Event::Opened(Ok(None))),
        [Effect::Create {
            why: "no mirror file".into()
        }]
    );
    g.handle(s(1), webhook(2));
    assert_eq!(g.next_deadline(), Some(s(10)));
    assert_eq!(g.handle(s(10), Event::Tick), [still_updating(1)]);
    assert_eq!(
        g.handle(s(12), Event::Created(Ok(()))),
        [
            Effect::NeedsImport {
                why: "empty mirror created".into()
            },
            Effect::Serve { id: 2 }
        ]
    );
}

#[test]
fn a_pending_rebuild_migration_creates_an_empty_mirror() {
    let mut g = gate(&V2_REBUILD);
    g.handle(s(0), request(1));
    let fx = g.handle(s(0), Event::Opened(Ok(Some(1))));
    assert!(
        matches!(&fx[..], [Effect::Create { why }] if why.contains("0002_step")),
        "{fx:?}"
    );
}

#[test]
fn a_transient_failure_retries_on_the_next_use_after_30_s_then_60_s() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(Some(1))));
    g.handle(s(0), webhook(2));
    assert_eq!(
        g.handle(s(1), transient()),
        [
            Effect::Status(Some(Status::Failed {
                error: "disk I/O error".into(),
                retry_in: Some(s(30))
            })),
            retrying(1, s(30)),
            retrying(2, s(30)),
        ]
    );
    assert_eq!(
        g.next_deadline(),
        None,
        "the retry waits for a use, not a timer"
    );
    assert_eq!(g.handle(s(21), request(3)), [retrying(3, s(10))]);

    assert_eq!(
        g.handle(s(31), request(4)),
        [Effect::Status(None), Effect::Migrate { from: 1, to: 2 }]
    );
    assert_eq!(
        g.handle(s(32), transient()),
        [
            Effect::Status(Some(Status::Failed {
                error: "disk I/O error".into(),
                retry_in: Some(s(60))
            })),
            retrying(4, s(60))
        ]
    );
    assert_eq!(g.handle(s(91), request(5)), [retrying(5, s(1))]);
    assert_eq!(
        g.handle(s(92), request(6)),
        [Effect::Status(None), Effect::Migrate { from: 1, to: 2 }]
    );
    assert_eq!(
        g.handle(s(93), Event::Migrated(Ok(()))),
        [Effect::Serve { id: 6 }]
    );
}

#[test]
fn a_transient_failure_to_open_reopens_after_the_backoff() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(
        s(0),
        Event::Opened(Err(MigError::Transient("disk I/O error".into()))),
    );
    assert_eq!(g.handle(s(10), request(2)), [retrying(2, s(20))]);
    assert_eq!(
        g.handle(s(30), request(3)),
        [Effect::Status(None), Effect::Open]
    );
}

#[test]
fn a_failed_migration_refuses_everyone_until_a_new_build() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(Some(1))));
    let failed = Refusal::Failed {
        error: "0002_step: UNIQUE constraint failed".into(),
    };
    assert_eq!(
        g.handle(
            s(1),
            Event::Migrated(Err(MigError::Failed(
                "0002_step: UNIQUE constraint failed".into()
            )))
        ),
        [
            Effect::Status(Some(Status::Failed {
                error: "0002_step: UNIQUE constraint failed".into(),
                retry_in: None
            })),
            Effect::Refuse {
                id: 1,
                why: failed.clone()
            },
        ]
    );
    assert_eq!(
        g.handle(s(3600), webhook(2)),
        [Effect::Refuse { id: 2, why: failed }]
    );
}

#[test]
fn a_file_newer_than_the_build_is_refused() {
    let mut g = gate(&V2);
    g.handle(s(0), webhook(1));
    let too_new = Refusal::TooNew { db: 3, build: 2 };
    assert_eq!(
        g.handle(s(0), Event::Opened(Ok(Some(3)))),
        [Effect::Refuse {
            id: 1,
            why: too_new.clone()
        }]
    );
    assert_eq!(
        g.handle(s(1), request(2)),
        [Effect::Refuse {
            id: 2,
            why: too_new
        }]
    );
}

#[test]
fn a_transient_failure_to_create_the_mirror_reopens_and_creates_again_after_the_backoff() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(None)));
    assert_eq!(
        g.handle(
            s(1),
            Event::Created(Err(MigError::Transient("database or disk is full".into())))
        ),
        [
            Effect::Status(Some(Status::Failed {
                error: "database or disk is full".into(),
                retry_in: Some(s(30))
            })),
            Effect::Refuse {
                id: 1,
                why: Refusal::Retrying {
                    error: "database or disk is full".into(),
                    retry_after: s(30)
                }
            },
        ]
    );
    assert_eq!(
        g.handle(s(31), request(2)),
        [Effect::Status(None), Effect::Open]
    );
    assert_eq!(
        g.handle(s(31), Event::Opened(Ok(None))),
        [Effect::Create {
            why: "no mirror file".into()
        }]
    );
}

#[test]
fn a_retried_migration_shows_updating_again_after_200_ms() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(Some(1))));
    g.handle(s(1), transient());

    assert_eq!(
        g.handle(s(31), request(2)),
        [Effect::Status(None), Effect::Migrate { from: 1, to: 2 }]
    );
    assert_eq!(g.next_deadline(), Some(s(31) + ms(200)));
    assert_eq!(
        g.handle(s(31) + ms(200), Event::Tick),
        [Effect::Status(Some(Status::Updating))]
    );
}

// Deleting a mirror (an account that lost access): the gate deletes the file once nothing else
// is under way, refuses everyone until the account is revived, and a revived account's first use
// creates an empty mirror and asks for its import.

#[test]
fn a_deleted_mirror_refuses_everyone_until_revived_then_is_created_empty() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(Some(2))));

    assert_eq!(g.handle(s(1), Event::Delete { id: 7 }), [Effect::Delete]);
    assert_eq!(
        g.handle(s(1), webhook(2)),
        [Effect::Refuse {
            id: 2,
            why: Refusal::Deleted
        }]
    );
    assert_eq!(
        g.handle(s(2), Event::Deleted(Ok(()))),
        [Effect::Serve { id: 7 }]
    );
    assert_eq!(
        g.handle(s(3), request(3)),
        [Effect::Refuse {
            id: 3,
            why: Refusal::Deleted
        }]
    );

    assert_eq!(g.handle(s(4), Event::Revive), []);
    assert_eq!(g.handle(s(5), request(4)), [Effect::Open]);
    assert_eq!(
        g.handle(s(5), Event::Opened(Ok(None))),
        [Effect::Create {
            why: "no mirror file".into()
        }]
    );
    assert_eq!(
        g.handle(s(6), Event::Created(Ok(()))),
        [
            Effect::NeedsImport {
                why: "empty mirror created".into()
            },
            Effect::Serve { id: 4 }
        ]
    );
}

#[test]
fn a_delete_during_a_migration_waits_for_it_then_deletes() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(Some(1))));

    // The migration's job holds the file: the delete waits for it to end.
    assert_eq!(g.handle(s(1), Event::Delete { id: 7 }), []);
    assert_eq!(
        g.handle(s(2), Event::Migrated(Ok(()))),
        [
            Effect::Refuse {
                id: 1,
                why: Refusal::Deleted
            },
            Effect::Delete
        ]
    );
    // A second delete joins the one under way.
    assert_eq!(g.handle(s(2), Event::Delete { id: 8 }), []);
    assert_eq!(
        g.handle(s(3), Event::Deleted(Ok(()))),
        [Effect::Serve { id: 7 }, Effect::Serve { id: 8 }]
    );
}

#[test]
fn a_revive_during_the_delete_reopens_once_it_is_done() {
    let mut g = gate(&V2);
    assert_eq!(g.handle(s(0), Event::Delete { id: 7 }), [Effect::Delete]);
    assert_eq!(g.handle(s(0), Event::Revive), []);
    assert_eq!(
        g.handle(s(1), Event::Deleted(Ok(()))),
        [Effect::Serve { id: 7 }]
    );
    assert_eq!(g.handle(s(2), request(1)), [Effect::Open]);
}

#[test]
fn a_failed_delete_tells_whoever_asked_and_still_refuses_everyone() {
    let mut g = gate(&V2);
    g.handle(s(0), Event::Delete { id: 7 });
    assert_eq!(
        g.handle(s(1), Event::Deleted(Err("permission denied".into()))),
        [Effect::Refuse {
            id: 7,
            why: Refusal::Failed {
                error: "permission denied".into()
            }
        }]
    );
    assert_eq!(
        g.handle(s(2), webhook(1)),
        [Effect::Refuse {
            id: 1,
            why: Refusal::Deleted
        }]
    );
}

#[test]
fn a_revive_while_the_delete_waits_for_a_migration_reopens_once_it_is_done() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(Some(1))));

    // The delete waits behind the migration, and the account signs in again meanwhile.
    assert_eq!(g.handle(s(1), Event::Delete { id: 7 }), []);
    assert_eq!(g.handle(s(1), Event::Revive), []);
    g.handle(s(2), Event::Migrated(Ok(())));
    assert_eq!(
        g.handle(s(3), Event::Deleted(Ok(()))),
        [Effect::Serve { id: 7 }]
    );
    assert_eq!(g.handle(s(4), request(2)), [Effect::Open]);
}

#[test]
fn a_delete_after_a_revive_wins() {
    let mut g = gate(&V2);
    g.handle(s(0), request(1));
    g.handle(s(0), Event::Opened(Ok(Some(1))));

    g.handle(s(1), Event::Delete { id: 7 });
    g.handle(s(1), Event::Revive);
    g.handle(s(1), Event::Delete { id: 8 });
    g.handle(s(2), Event::Migrated(Ok(())));
    g.handle(s(3), Event::Deleted(Ok(())));
    assert_eq!(
        g.handle(s(4), request(2)),
        [Effect::Refuse {
            id: 2,
            why: Refusal::Deleted
        }]
    );
}
