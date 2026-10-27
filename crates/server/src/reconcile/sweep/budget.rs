//! The wait for the installation's quota: sweeps pause while it's below a fifth.

use super::*;

impl Sweeper {
    /// Waits while the installation's quota for `resource` is below a fifth, asking
    /// `/rate_limit` (which costs nothing) when the last reading is old, and every tick while
    /// paused.
    pub(super) async fn wait_for_budget(&self, resource: Resource) {
        let mut paused = false;
        loop {
            let b = self.reconcile().budget(self.installation);
            if paused || b.read.is_none_or(|t| t.elapsed() >= BUDGET_FRESH) {
                self.read_budget().await;
            }
            let b: Budget = self.reconcile().budget(self.installation);
            let q = match resource {
                Resource::Core => b.core,
                Resource::Graphql => b.graphql,
            };
            let low = q.is_some_and(|q| q.low() && q.reset > crate::now());
            if !low {
                if paused {
                    eprintln!(
                        "reconcile: installation {}: quota back over a fifth; sweeps resume",
                        self.installation
                    );
                }
                return;
            }
            if !paused {
                eprintln!(
                    "reconcile: installation {}: {resource:?} quota below a fifth ({q:?}); sweeps pause",
                    self.installation
                );
                paused = true;
            }
            tokio::time::sleep(self.reconcile().cfg().tick).await;
        }
    }

    /// Asks GitHub for the installation's quotas; a failure leaves the last reading.
    pub(super) async fn read_budget(&self) {
        let installations = self.app.installations();
        let read = match installations.token(self.installation, Scope::Import).await {
            Ok(t) => self.app.github().rate_limit(&t).await,
            Err(e) => Err(e.into()),
        };
        match read {
            Ok((core, graphql)) => self.reconcile().set_budget(self.installation, |b| {
                b.core = Some(core);
                b.graphql = Some(graphql);
                b.read = Some(std::time::Instant::now());
            }),
            Err(e) => {
                eprintln!(
                    "reconcile: installation {}: reading its rate limit: {e}",
                    self.installation
                );
                self.reconcile().set_budget(self.installation, |b| {
                    b.read = Some(std::time::Instant::now());
                });
            }
        }
    }

    pub(super) fn note(&self, resource: Resource, q: Option<Quota>) {
        if let Some(q) = q {
            self.reconcile()
                .set_budget(self.installation, |b| match resource {
                    Resource::Core => b.core = Some(q),
                    Resource::Graphql => b.graphql = Some(q),
                });
        }
    }
}
