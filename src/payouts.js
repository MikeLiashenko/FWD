// П. 1.2, 2.3: зарплата 6 числа. Син обирає відсоток, решта блісків лишається на балансі.
import { db, getNumber, setSetting } from './db.js';
import { today, nowIso, monthOf, addMonths } from './time.js';
import { addEntry, balance } from './ledger.js';
import { setupDay } from './family.js';
import { TaskError } from './errors.js';

export const PAYOUT_DAY = 6;

// Гривні виплачуються цілими: скільки гривень вийде і скільки блісків за це списати
export function quote(percent = getNumber('payout_percent'), total = balance()) {
  const rateB = getNumber('rate_blisks');
  const rateU = getNumber('rate_uah');
  const share = Math.floor(Math.max(0, total) * percent / 100);
  const uah = Math.floor(share * rateU / rateB);
  const blisks = Math.ceil(uah * rateB / rateU);
  return { percent, uah, blisks, remaining: total - blisks };
}

export function setPercent(percent) {
  percent = Number(percent);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new TaskError('Відсоток — від 0 до 100');
  setSetting('payout_percent', percent);
}

export function nextPayoutDay() {
  const now = today();
  const thisMonth = `${monthOf(now)}-0${PAYOUT_DAY}`;
  return now < thisMonth ? thisMonth : `${addMonths(monthOf(now), 1)}-0${PAYOUT_DAY}`;
}

export function tickPayouts() {
  const now = today();
  const month = monthOf(now);
  const payDay = `${month}-0${PAYOUT_DAY}`;
  // Перша виплата — у першому 6 числі після старту додатка
  if (now < payDay || setupDay() >= payDay) return;
  if (db.prepare('SELECT 1 FROM payouts WHERE month = ?').get(month)) return;

  const q = quote();
  const status = q.uah > 0 ? 'owed' : 'empty';
  db.prepare('INSERT INTO payouts (month, percent, blisks, uah, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(month, q.percent, q.blisks, q.uah, status, nowIso());
  if (q.uah > 0) {
    addEntry({ amount: -q.blisks, kind: 'payout', note: `Виплата ${PAYOUT_DAY} числа: ${q.uah} грн (${q.percent}%)` });
  }
}

function getPayout(id) {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
  if (!p) throw new TaskError('Виплату не знайдено');
  return p;
}

// Батьки позначають, що віддали гроші; син підтверджує, що отримав
export function markPaid(id) {
  const p = getPayout(id);
  if (p.status !== 'owed') throw new TaskError('Цю виплату вже позначено');
  db.prepare("UPDATE payouts SET status = 'paid', paid_at = ? WHERE id = ?").run(nowIso(), id);
}

export function markReceived(id) {
  const p = getPayout(id);
  if (p.status !== 'paid') throw new TaskError('Батьки ще не позначили виплату');
  db.prepare("UPDATE payouts SET status = 'received', received_at = ? WHERE id = ?").run(nowIso(), id);
}

export function listPayouts(limit = 12) {
  return db.prepare("SELECT * FROM payouts WHERE status != 'empty' ORDER BY month DESC LIMIT ?").all(limit);
}

export function payoutsAwaiting(role) {
  return db.prepare('SELECT * FROM payouts WHERE status = ?').all(role === 'parents' ? 'owed' : 'paid');
}
