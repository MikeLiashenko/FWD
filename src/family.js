// Скарги (п. 5), штрафи (п. 3) і пауза (п. 9). Рішення діють лише тоді, коли згодна друга сторона.
import { db, getNumber, transaction } from './db.js';
import { today, nowIso, monthOf, addDays } from './time.js';
import { addEntry } from './ledger.js';
import { TaskError } from './errors.js';

export const other = role => (role === 'son' ? 'parents' : 'son');

// День, коли сім'я почала користуватися додатком: бонуси рахуються лише з нього
export function setupDay() {
  const row = db.prepare('SELECT MIN(created_at) AS t FROM users').get();
  return row?.t ? today(new Date(row.t)) : today();
}

// ---------- Штрафи ----------

// П. 3.2–3.3: 150, далі кожен наступний у місяці на 50% від початкової суми більший
export function nextFineAmount(side, month = monthOf(today())) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM fines WHERE side = ? AND month = ?').get(side, month).n;
  const base = getNumber('fine_base');
  return Math.round(base + base * getNumber('fine_step_percent') / 100 * count);
}

function createFine(side, complaint) {
  const month = monthOf(today());
  const amount = nextFineAmount(side, month);
  db.prepare('INSERT INTO fines (side, month, amount, complaint_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(side, month, amount, complaint.id, nowIso());
  addEntry(side === 'son'
    ? { amount: -amount, kind: 'fine', note: `Штраф: ${complaint.text}` }
    : { amount, kind: 'fine', note: `Штраф батьків на користь сина: ${complaint.text}` });
}

export function sonFinesIn(month) {
  return db.prepare("SELECT COUNT(*) AS n FROM fines WHERE side = 'son' AND month = ?").get(month).n;
}

export function finesSummary() {
  const month = monthOf(today());
  const count = side => db.prepare('SELECT COUNT(*) AS n FROM fines WHERE side = ? AND month = ?').get(side, month).n;
  return {
    son: { count: count('son'), next: nextFineAmount('son', month) },
    parents: { count: count('parents'), next: nextFineAmount('parents', month) },
  };
}

// ---------- Скарги ----------

function getComplaint(id) {
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
  if (!c) throw new TaskError('Скаргу не знайдено');
  return c;
}

export function createComplaint(role, text) {
  text = text?.trim();
  if (!text) throw new TaskError('Опиши, що сталося');
  if (text.length > 300) throw new TaskError('Скарга задовга (до 300 символів)');
  const { lastInsertRowid } = db.prepare('INSERT INTO complaints (against, text, created_at) VALUES (?, ?, ?)')
    .run(other(role), text, nowIso());
  return getComplaint(lastInsertRowid);
}

// Одна сторона пропонує рішення: штраф або відхилити скаргу
export function proposeResolution(id, role, proposal) {
  if (!['fine', 'dismiss'].includes(proposal)) throw new TaskError('Невідоме рішення');
  const c = getComplaint(id);
  if (c.status !== 'open') throw new TaskError('Скаргу вже розглянуто');
  if (c.proposal && c.proposed_by !== role) throw new TaskError('Спершу дай відповідь на пропозицію іншої сторони');
  db.prepare('UPDATE complaints SET proposal = ?, proposed_by = ? WHERE id = ?').run(proposal, role, id);
  return getComplaint(id);
}

// Друга сторона погоджується (рішення набирає сили) або ні (скарга знову відкрита)
export function answerResolution(id, role, agree) {
  return transaction(() => {
    const c = getComplaint(id);
    if (c.status !== 'open' || !c.proposal) throw new TaskError('Немає рішення, яке треба підтвердити');
    if (c.proposed_by === role) throw new TaskError('Підтвердити має інша сторона');
    if (!agree) {
      db.prepare('UPDATE complaints SET proposal = NULL, proposed_by = NULL WHERE id = ?').run(id);
      return getComplaint(id);
    }
    if (c.proposal === 'fine') createFine(c.against, c);
    db.prepare('UPDATE complaints SET status = ?, resolved_at = ? WHERE id = ?')
      .run(c.proposal === 'fine' ? 'fined' : 'dismissed', nowIso(), id);
    return getComplaint(id);
  });
}

export function listComplaints(limit = 50) {
  return db.prepare(`
    SELECT c.*, f.amount AS fine_amount
    FROM complaints c LEFT JOIN fines f ON f.complaint_id = c.id
    ORDER BY c.status = 'open' DESC, c.id DESC LIMIT ?
  `).all(limit);
}

// ---------- Пауза ----------

function getPause(id) {
  const p = db.prepare('SELECT * FROM pauses WHERE id = ?').get(id);
  if (!p) throw new TaskError('Паузу не знайдено');
  return p;
}

export function isPaused(day) {
  return Boolean(db.prepare(`
    SELECT 1 FROM pauses WHERE status IN ('active', 'ended') AND start_day <= ? AND end_day >= ?
  `).get(day, day));
}

export function requestPause(role, { start, end, reason }) {
  reason = reason?.trim();
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(start ?? '') || !re.test(end ?? '')) throw new TaskError('Вкажи дати початку й кінця');
  if (start < today()) throw new TaskError('Пауза не може початися в минулому');
  if (end < start) throw new TaskError('Кінець паузи раніше за початок');
  if (end > addDays(start, 29)) throw new TaskError('Пауза — не довше 30 днів');
  if (!reason) throw new TaskError('Вкажи причину (хвороба, іспити…)');
  const overlap = db.prepare(`
    SELECT 1 FROM pauses WHERE status IN ('pending', 'active') AND start_day <= ? AND end_day >= ?
  `).get(end, start);
  if (overlap) throw new TaskError('На ці дні вже є пауза або запит');
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO pauses (start_day, end_day, reason, requested_by, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(start, end, reason, role, nowIso());
  return getPause(lastInsertRowid);
}

// П. 9.2: пауза діє лише за згодою обох сторін
export function answerPause(id, role, agree) {
  const p = getPause(id);
  if (p.status !== 'pending') throw new TaskError('Запит уже розглянуто');
  if (p.requested_by === role) {
    if (agree) throw new TaskError('Підтвердити має інша сторона');
    db.prepare("UPDATE pauses SET status = 'declined', decided_at = ? WHERE id = ?").run(nowIso(), id); // відкликати свій запит
    return getPause(id);
  }
  db.prepare('UPDATE pauses SET status = ?, decided_at = ? WHERE id = ?').run(agree ? 'active' : 'declined', nowIso(), id);
  return getPause(id);
}

// Син може завершити паузу раніше: сьогоднішній день уже не на паузі
export function endPause(id, role) {
  if (role !== 'son') throw new TaskError('Достроково завершити паузу може син');
  const p = getPause(id);
  if (p.status !== 'active') throw new TaskError('Ця пауза не активна');
  const lastDay = addDays(today(), -1);
  db.prepare("UPDATE pauses SET status = 'ended', end_day = ? WHERE id = ?")
    .run(lastDay < p.start_day ? addDays(p.start_day, -1) : lastDay, id);
  return getPause(id);
}

export function listPauses(limit = 20) {
  return db.prepare("SELECT * FROM pauses WHERE status != 'declined' OR decided_at >= ? ORDER BY id DESC LIMIT ?")
    .all(new Date(Date.now() - 7 * 86_400_000).toISOString(), limit);
}

// Що чекає згоди саме цієї сторони
export function awaitingConsent(role) {
  return {
    complaints: db.prepare("SELECT * FROM complaints WHERE status = 'open' AND proposal IS NOT NULL AND proposed_by != ?").all(role),
    pauses: db.prepare("SELECT * FROM pauses WHERE status = 'pending' AND requested_by != ?").all(role),
  };
}
