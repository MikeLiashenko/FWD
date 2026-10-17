// Сімейні збори в неділю (п. 5.2, 6.2, 7.3, 12.2) і термін дії договору (п. 12.1)
import { db, getSetting, setSetting } from './db.js';
import { today, nowIso, addDays } from './time.js';
import { setupDay } from './family.js';
import { TaskError } from './errors.js';

// ---------- Збори ----------

// Найближча неділя (сьогодні, якщо сьогодні неділя)
export function nextSunday(day = today()) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, (7 - weekday) % 7);
}

export function addTopic(role, text) {
  text = text?.trim();
  if (!text) throw new TaskError('Напиши тему');
  if (text.length > 300) throw new TaskError('Тема задовга (до 300 символів)');
  db.prepare('INSERT INTO topics (text, created_by, created_at) VALUES (?, ?, ?)').run(text, role, nowIso());
}

export function discussTopic(id, decision) {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!topic) throw new TaskError('Тему не знайдено');
  if (topic.status !== 'open') throw new TaskError('Тему вже обговорено');
  decision = decision?.trim();
  if (!decision) throw new TaskError('Запишіть, що вирішили');
  db.prepare("UPDATE topics SET status = 'discussed', decision = ?, discussed_at = ? WHERE id = ?").run(decision, nowIso(), id);
}

export function listTopics() {
  return {
    open: db.prepare("SELECT * FROM topics WHERE status = 'open' ORDER BY id").all(),
    discussed: db.prepare("SELECT * FROM topics WHERE status = 'discussed' ORDER BY discussed_at DESC LIMIT 10").all(),
  };
}

// Підсумки останніх 7 днів для зборів
export function weekSummary() {
  const from = addDays(today(), -6);
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  return {
    from,
    tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'approved' AND day >= ?", from),
    missed: count("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('expired', 'rejected') AND day >= ?", from),
    grades: count("SELECT COUNT(*) AS n FROM grades WHERE status = 'approved' AND day >= ?", from),
    earned: count('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE amount > 0 AND created_at >= ?', since),
    spent: -count('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE amount < 0 AND created_at >= ?', since),
    fines: count('SELECT COUNT(*) AS n FROM fines WHERE created_at >= ?', since),
  };
}

// ---------- Договір ----------

function addMonthsToDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(d, lastDay));
  return date.toISOString().slice(0, 10);
}

export const CONTRACT_MONTHS = 3;

export function contractEnd() {
  let end = getSetting('contract_end');
  if (!end) {
    end = addMonthsToDay(setupDay(), CONTRACT_MONTHS);
    setSetting('contract_end', end);
  }
  return end;
}

export function contractInfo() {
  const end = contractEnd();
  const daysLeft = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
  return {
    end,
    daysLeft,
    expired: daysLeft < 0,
    dueSoon: daysLeft <= 14,
    renewProposedBy: getSetting('contract_renew_by') || null,
  };
}

// П. 12.1–12.2: продовжити на 3 місяці — одна сторона пропонує, інша підтверджує
export function proposeRenewal(role) {
  const by = getSetting('contract_renew_by');
  if (by === role) throw new TaskError('Ви вже запропонували, чекаємо згоди іншої сторони');
  if (by) throw new TaskError('Інша сторона вже запропонувала — підтвердіть у «Перевірці»');
  setSetting('contract_renew_by', role);
}

export function answerRenewal(role, agree) {
  const by = getSetting('contract_renew_by');
  if (!by) throw new TaskError('Ніхто не пропонував продовження');
  if (by === role) {
    if (agree) throw new TaskError('Підтвердити має інша сторона');
    setSetting('contract_renew_by', ''); // відкликати свою пропозицію
    return contractInfo();
  }
  if (agree) {
    const end = contractEnd();
    const base = end < today() ? today() : end;
    setSetting('contract_end', addMonthsToDay(base, CONTRACT_MONTHS));
  }
  setSetting('contract_renew_by', '');
  return contractInfo();
}
