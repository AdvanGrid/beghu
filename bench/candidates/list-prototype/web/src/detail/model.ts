// PROTOTYPE (beghu #54). The open issue as the detail sees it: the server's copy with this tab's
// pending writes applied on top, as "Write path" decided.
//
// - Every write is one op with an op_id, sent while the request is open (no outbox).
// - A pending op shows at once and is marked pending in the UI.
// - A confirmed op stays applied until a fetch that started after its confirmation lands, so the
//   view never flickers back to the old value between the reply and the refetch.
// - A refused op is dropped (the view reverts visibly) and a toast says what was undone, except a
//   comment, which stays in the thread as "not sent" with Retry, because comments never retry on
//   their own.
import { createMemo, createSignal } from 'solid-js';
import { fetchComments, fetchIssue, getIssue, sendOp, WriteError, type Comment, type Detail, type Op, type RelItem } from '../api';
import { toast } from './toasts';
import { createHeld } from './live';

export type RelKind = 'parent' | 'child' | 'blocked_by' | 'blocking' | 'relates';

export type Pending = {
  op_id: string;
  issue: number;
  op: Op;
  /** For rel_add: the item to show until the server lists it. */
  item?: RelItem;
  status: 'sending' | 'confirmed' | 'failed';
  confirmedGen?: number;
  error?: string;
  at: string;
};

// Pending ops live per tab, keyed by issue, so leaving an issue and coming back keeps them.
const [ops, setOps] = createSignal<Pending[]>([]);
let gen = 0;

const newId = () => Math.random().toString(36).slice(2, 10);

/** A key per thing an op touches, so the UI can mark exactly that thing pending. */
export function opKey(op: Op): string {
  switch (op.op) {
    case 'label_add':
    case 'label_remove':
      return `label:${op.name}`;
    case 'assignee_add':
    case 'assignee_remove':
      return `assignee:${op.login}`;
    case 'rel_add':
    case 'rel_remove':
      return `rel:${op.kind}:${op.other}`;
    case 'sub_move':
      return `move:${op.child}`;
    default:
      return op.op;
  }
}

const describe = (op: Op): string => {
  switch (op.op) {
    case 'title':
      return 'rename the issue';
    case 'body':
      return 'save the description';
    case 'comment':
      return 'post the comment';
    case 'label_add':
      return `add label “${op.name}”`;
    case 'label_remove':
      return `remove label “${op.name}”`;
    case 'assignee_add':
      return `assign ${op.login}`;
    case 'assignee_remove':
      return `unassign ${op.login}`;
    case 'milestone':
      return op.title ? `set milestone ${op.title}` : 'clear the milestone';
    case 'state':
      return op.state === 'closed' ? 'close the issue' : 'reopen the issue';
    case 'rel_add':
      return `link ${op.kind.replace('_', ' ')}`;
    case 'rel_remove':
      return `unlink ${op.kind.replace('_', ' ')}`;
    case 'sub_move':
      return 'move the sub-issue';
  }
};

function relList(d: Detail, kind: RelKind): RelItem[] {
  const r = d.rels;
  return kind === 'child' ? r.children : kind === 'blocked_by' ? r.blocked_by : kind === 'blocking' ? r.blocking : kind === 'relates' ? r.relates : r.parent ? [r.parent] : [];
}

/** Applies pending ops over the server's copy. Idempotent: an op already reflected changes nothing. */
function apply(server: Detail, list: Pending[]): Detail & { pendingComments: (Comment & { p: Pending })[] } {
  const d: Detail = structuredClone(server);
  const pendingComments: (Comment & { p: Pending })[] = [];
  for (const p of list) {
    const op = p.op;
    switch (op.op) {
      case 'title':
        d.title = op.value;
        break;
      case 'body':
        d.body = op.value;
        break;
      case 'comment':
        // Once the copy on screen lists it, the confirmed op is only waiting to be dropped. (#66: the
        // copy on screen can be an older, held one, so check it rather than the op's status.)
        if (p.status !== 'confirmed' || !d.comments.some((c) => c.author === d.me && c.body === op.body)) pendingComments.push({ id: -1, author: d.me, body: op.body, created_at: p.at, p });
        break;
      case 'label_add': {
        const l = d.meta.labels.find((x) => x.name === op.name);
        if (l && !d.labels.some((x) => x.name === op.name)) d.labels.push(l);
        break;
      }
      case 'label_remove':
        d.labels = d.labels.filter((x) => x.name !== op.name);
        break;
      case 'assignee_add':
        if (!d.assignees.includes(op.login)) d.assignees.push(op.login);
        break;
      case 'assignee_remove':
        d.assignees = d.assignees.filter((x) => x !== op.login);
        break;
      case 'milestone':
        d.milestone = op.title;
        break;
      case 'state':
        d.state = op.state;
        d.state_reason = op.reason;
        break;
      case 'rel_add': {
        const kind = op.kind as RelKind;
        if (!p.item || relList(d, kind).some((x) => x.id === op.other)) break;
        if (kind === 'parent') d.rels.parent = p.item;
        else relList(d, kind).push(p.item);
        break;
      }
      case 'sub_move': {
        const list = d.rels.children;
        const from = list.findIndex((x) => x.id === op.child);
        if (from < 0) break;
        const [it] = list.splice(from, 1);
        const at = op.after === null ? 0 : list.findIndex((x) => x.id === op.after) + 1;
        list.splice(at, 0, it);
        break;
      }
      case 'rel_remove': {
        const kind = op.kind as RelKind;
        if (kind === 'parent') {
          if (d.rels.parent?.id === op.other) d.rels.parent = null;
        } else {
          const key = kind === 'child' ? 'children' : kind;
          d.rels[key] = d.rels[key].filter((x) => x.id !== op.other);
        }
        break;
      }
    }
  }
  return { ...d, pendingComments };
}

export type IssueModel = ReturnType<typeof issueModel>;

/** `server` is the async signal over the route's issue; `setServer` replaces it after a refetch. */
export function issueModel(server: () => Detail, setServer: (d: Detail) => void) {
  const mine = createMemo(() => ops().filter((p) => p.issue === server().id));
  const d = createMemo(() => apply(server(), mine().filter((p) => p.status !== 'failed' || p.op.op === 'comment')));

  // Comments the server folded away, once the user asks for them.
  const [extra, setExtra] = createSignal<{ id: number; comments: Comment[] } | undefined>(undefined);

  // #66: a refetch goes through the held layer, which shows what doesn't move layout at once and
  // holds the rest. Confirmed ops are dropped only once their refetch is the one on screen.
  const held = createHeld({
    get: server,
    set: setServer,
    view: (x) => apply(x, mine().filter((p) => p.status !== 'failed' || p.op.op === 'comment')),
    committed: (started) => setOps((all) => all.filter((p) => !(p.status === 'confirmed' && p.confirmedGen! < started))),
    scroller: () => document.querySelector<HTMLElement>('.detail') ?? undefined,
  });
  let heldFor = -1;

  async function refresh() {
    const id = server().id;
    const started = ++gen;
    const fresh = await fetchIssue(id);
    if (fresh.id !== server().id) return;
    if (heldFor !== id) (held.reset(), (heldFor = id));
    held.offer(fresh, started);
  }

  function send(op: Op, extras?: { item?: RelItem; onConflict?: (msg: string) => void; quiet?: boolean }) {
    const p: Pending = { op_id: newId(), issue: server().id, op, item: extras?.item, status: 'sending', at: new Date().toISOString() };
    setOps((all) => [...all, p]);
    run(p, extras);
    return p.op_id;
  }

  async function run(p: Pending, extras?: { onConflict?: (msg: string) => void }) {
    try {
      await sendOp(p.issue, p.op_id, p.op);
      setOps((all) => all.map((x) => (x.op_id === p.op_id ? { ...x, status: 'confirmed', confirmedGen: gen } : x)));
      if (p.issue === server().id) refresh();
    } catch (e) {
      const msg = e instanceof WriteError ? e.message : String(e);
      if (p.op.op === 'comment') {
        setOps((all) => all.map((x) => (x.op_id === p.op_id ? { ...x, status: 'failed', error: msg } : x)));
        return;
      }
      setOps((all) => all.filter((x) => x.op_id !== p.op_id));
      if (e instanceof WriteError && e.status === 409 && extras?.onConflict) return extras.onConflict(msg);
      toast({ text: `Couldn't ${describe(p.op)}: ${msg}. Undone.`, retry: () => send(p.op, { item: p.item }) });
    }
  }

  return {
    d,
    held,
    /** The held plan, only while it belongs to the issue on screen. */
    plan: () => (heldFor === server().id ? held.plan() : null),
    me: () => server().me,
    /** The server's own copy, for the body edit's conflict base. */
    server,
    /** Any op still on its way, so a list can mark what's moving. */
    sending: () => mine().filter((p) => p.status === 'sending'),
    pending: (key: string) => mine().some((p) => p.status === 'sending' && opKey(p.op) === key),
    send,
    retryComment: (op_id: string) => {
      const p = mine().find((x) => x.op_id === op_id)!;
      setOps((all) => all.map((x) => (x.op_id === op_id ? { ...x, status: 'sending', error: undefined } : x)));
      run(p);
    },
    discardComment: (op_id: string) => setOps((all) => all.filter((x) => x.op_id !== op_id)),
    refresh,
    extra: () => (extra()?.id === server().id ? extra()!.comments : undefined),
    loadHidden: async () => {
      const id = server().id;
      const more = await fetchComments(id, 1, server().hidden);
      setExtra({ id, comments: more });
    },
  };
}

export { getIssue };
