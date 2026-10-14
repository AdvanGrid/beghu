// What a correct candidate shows, computed from the pristine fixture. Scenarios wait for the DOM
// to match these ids, so a candidate is only "done" once it shows the right rows.
//
// The view contract (see README): issues only, no stubs, one state at a time, every selected
// label and every selected assignee present, search = case-insensitive substring of the title,
// newest `updated_at` first with ties broken by higher id.

import { DatabaseSync } from 'node:sqlite';

export class Expect {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  ids({ state = 'open', labels = [], assignees = [], q = '' } = {}, limit = 20, offset = 0) {
    const where = ["i.kind = 'issue'", 'i.is_stub = 0', 'i.state = ?'];
    const params = [state];
    for (const name of labels) {
      where.push('EXISTS (SELECT 1 FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id AND l.name = ?)');
      params.push(name);
    }
    for (const login of assignees) {
      where.push('EXISTS (SELECT 1 FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id AND u.login = ?)');
      params.push(login);
    }
    if (q) {
      where.push("instr(lower(i.title), lower(?)) > 0");
      params.push(q);
    }
    const sql = `SELECT i.id FROM items i WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params, limit, offset).map((r) => String(r.id));
  }

  fixtureNow() {
    return Date.parse(this.db.prepare("SELECT value FROM meta WHERE key = 'fixture_now'").get().value);
  }

  labelsOf(id) {
    return this.db
      .prepare('SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = ?')
      .all(id)
      .map((r) => r.name);
  }

  labelNames() {
    return this.db.prepare('SELECT DISTINCT name FROM labels ORDER BY name').all().map((r) => r.name);
  }

  team() {
    return this.db
      .prepare('SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id')
      .all()
      .map((r) => r.login);
  }
}
