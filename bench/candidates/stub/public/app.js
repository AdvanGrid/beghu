// Stub candidate client: fetches pages of rows from the server, renders them all (no windowing),
// loads more on scroll and refetches on server-sent events.
const PAGE = 100;
const view = { state: 'open', labels: new Set(), assignees: new Set(), q: '' };
const list = document.getElementById('list');
const detailEl = document.getElementById('detail');
let rows = [];
let generation = 0;
let loadingMore = false;
let exhausted = false;
let openId = null;

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
};

function query(offset, limit) {
  const p = new URLSearchParams({ state: view.state, offset, limit });
  for (const l of view.labels) p.append('label', l);
  for (const a of view.assignees) p.append('assignee', a);
  if (view.q) p.set('q', view.q);
  return fetch(`/api/issues?${p}`).then((r) => r.json());
}

function rowEl(r) {
  return el(
    'li',
    { dataset: { bench: 'row', id: r.id }, on: { click: () => openDetail(r.id) } },
    el('span', { class: 'repo' }, `${r.repo}#${r.number}`),
    el('span', { dataset: { bench: 'title' } }, r.title),
    el('span', { class: 'meta' }, r.labels.map((l) => l.name).join(' ')),
  );
}

function renderList() {
  list.replaceChildren(...rows.map(rowEl));
  list.toggleAttribute('data-bench-empty', rows.length === 0);
  list.setAttribute('data-bench-ready', '');
}

async function reload(keep = PAGE) {
  const gen = ++generation;
  const fresh = await query(0, Math.max(PAGE, keep));
  if (gen !== generation) return;
  rows = fresh;
  exhausted = fresh.length < Math.max(PAGE, keep);
  renderList();
}

async function loadMore() {
  if (loadingMore || exhausted) return;
  loadingMore = true;
  const gen = generation;
  const more = await query(rows.length, PAGE);
  loadingMore = false;
  if (gen !== generation) return;
  exhausted = more.length < PAGE;
  rows = rows.concat(more);
  list.append(...more.map(rowEl));
}

list.addEventListener('scroll', () => {
  if (list.scrollTop + list.clientHeight > list.scrollHeight - 1500) loadMore();
});

async function openDetail(id) {
  openId = id;
  const d = await fetch(`/api/issues/${id}`).then((r) => r.json());
  if (openId !== id) return;
  renderDetail(d);
}

function renderDetail(d) {
  const have = new Set(d.labels.map((l) => l.name));
  const chips = el('div', {}, ...d.labels.map((l) => el('span', { class: 'label', dataset: { bench: 'label', value: l.name } }, l.name)));
  const add = el(
    'div',
    {},
    'Add: ',
    ...d.repo_labels
      .filter((l) => !have.has(l.name))
      .map((l) =>
        el('button', { dataset: { bench: 'add-label', value: l.name }, on: { click: () => addLabel(d, l) } }, l.name),
      ),
  );
  detailEl.replaceChildren(
    el(
      'article',
      { dataset: { bench: 'detail', id: d.id } },
      el('h2', {}, el('span', { class: 'repo' }, `${d.repo}#${d.number} `), d.title),
      chips,
      add,
      el('pre', { dataset: { bench: 'body' } }, d.body),
      ...d.comments.map((c) =>
        el('div', { class: 'comment', dataset: { bench: 'comment' } }, el('div', { class: 'meta' }, `${c.author} · ${c.created_at}`), el('pre', {}, c.body)),
      ),
    ),
  );
}

async function addLabel(d, label) {
  // Optimistic: show the label at once, roll back if the server refuses.
  const optimistic = { ...d, labels: [...d.labels, label] };
  renderDetail(optimistic);
  const r = await fetch(`/api/issues/${d.id}/labels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: label.name }) });
  if (!r.ok && openId === d.id) renderDetail(d);
}

function toggle(set, value, button) {
  set.has(value) ? set.delete(value) : set.add(value);
  button.setAttribute('aria-pressed', String(set.has(value)));
  reload();
}

async function init() {
  const facets = await fetch('/api/facets').then((r) => r.json());
  const states = document.getElementById('states');
  for (const s of ['open', 'closed']) {
    states.append(
      el('button', {
        'aria-pressed': String(view.state === s),
        dataset: { bench: 'filter-state', value: s },
        on: {
          click: (e) => {
            view.state = s;
            for (const b of states.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            reload();
          },
        },
      }, s),
    );
  }
  document.getElementById('labels').append(
    ...facets.labels.map((l) => el('button', { 'aria-pressed': 'false', dataset: { bench: 'filter-label', value: l }, on: { click: (e) => toggle(view.labels, l, e.currentTarget) } }, l)),
  );
  document.getElementById('assignees').append(
    ...facets.assignees.map((a) => el('button', { 'aria-pressed': 'false', dataset: { bench: 'filter-assignee', value: a }, on: { click: (e) => toggle(view.assignees, a, e.currentTarget) } }, `@${a}`)),
  );
  document.querySelector('[data-bench=search]').addEventListener('input', (e) => {
    view.q = e.target.value;
    reload();
  });
  await reload();

  new EventSource('/events').onmessage = (e) => {
    const { ids } = JSON.parse(e.data);
    reload(rows.length);
    if (openId && ids.includes(openId)) openDetail(openId);
  };
}

init();
