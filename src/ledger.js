import { db, getNumber } from './db.js';
import { nowIso } from './time.js';

export function addEntry({ amount, kind, note, taskId = null, createdBy = null }) {
  db.prepare(
    'INSERT INTO ledger (created_at, amount, kind, task_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(nowIso(), amount, kind, taskId, note, createdBy);
}

export function balance() {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger').get().total;
}

// П. 2.1: гривні за поточним курсом, з точністю до копійки
export function toUah(blisks) {
  return Math.floor((blisks * getNumber('rate_uah') / getNumber('rate_blisks')) * 100) / 100;
}

export function history(limit = 100) {
  return db.prepare(`
    SELECT l.id, l.created_at, l.amount, l.kind, l.task_id, l.note, u.name AS created_by_name
    FROM ledger l LEFT JOIN users u ON u.id = l.created_by
    ORDER BY l.id DESC LIMIT ?
  `).all(limit);
}
