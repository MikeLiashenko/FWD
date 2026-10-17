// Свята (п. 2.2), бонус за серію (п. 11.1) та ідеальний місяць (п. 11.2)
import { db, getNumber, getSetting, hasAward, markAward } from './db.js';
import { today, isPastDeadline, addDays, monthOf, addMonths, lastDayOfMonth, daysFrom } from './time.js';
import { addEntry } from './ledger.js';
import { isPaused, setupDay, sonFinesIn } from './family.js';

const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

// Православний Великдень: юліанська пасхалія + 13 днів (вірно для 1900–2099)
export function easter(year) {
  const a = year % 4, b = year % 7, c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return addDays(julian, 13);
}

export function holidaysOf(year) {
  const birth = getSetting('son_birth_date')?.slice(5);
  return [
    { key: 'new_year', name: 'Новий рік', day: `${year}-01-01` },
    { key: 'easter', name: 'Великдень', day: easter(year) },
    { key: 'children', name: 'День захисту дітей', day: `${year}-06-01` },
    { key: 'defenders', name: 'День захисників і захисниць', day: `${year}-10-01` },
    birth && { key: 'birthday', name: 'День народження', day: `${year}-${birth}` },
    { key: 'nicholas', name: 'Святий Миколай', day: `${year}-12-06` },
  ].filter(Boolean).map(h => ({ ...h, amount: getNumber(`holiday_${h.key}`) })).sort((x, y) => x.day.localeCompare(y.day));
}

export function upcomingHolidays() {
  const now = today();
  const year = Number(now.slice(0, 4));
  return [...holidaysOf(year), ...holidaysOf(year + 1)].filter(h => h.day >= now).slice(0, 6)
    .map(h => ({ ...h, awarded: hasAward(`holiday:${h.key}:${h.day.slice(0, 4)}`) }));
}

// Свято нараховується в свій день; якщо сервер того дня не працював — протягом двох тижнів
function tickHolidays() {
  const now = today();
  const from = [setupDay(), addDays(now, -14)].sort().at(-1);
  const year = Number(now.slice(0, 4));
  for (const h of [...holidaysOf(year - 1), ...holidaysOf(year)]) {
    const key = `holiday:${h.key}:${h.day.slice(0, 4)}`;
    if (h.day < from || h.day > now || hasAward(key)) continue;
    markAward(key);
    if (h.amount > 0) addEntry({ amount: h.amount, kind: 'holiday', note: `Свято: ${h.name}` });
  }
}

export function toothFairy(createdBy) {
  addEntry({ amount: getNumber('holiday_tooth_fairy'), kind: 'holiday', note: 'Зубна фея', createdBy });
}

// ---------- Серія та ідеальний місяць ----------

// Стан дня: усі завдання дня зараховані = виконаний; пауза не рахується й не перериває серію
function dayStatus(day) {
  if (isPaused(day)) return 'paused';
  const rows = db.prepare("SELECT status FROM tasks WHERE day = ? AND status != 'replaced'").all(day);
  if (rows.some(r => r.status === 'submitted' || r.status === 'active')) return 'pending';
  const approved = rows.filter(r => r.status === 'approved').length;
  return approved >= getNumber('tasks_per_day') ? 'complete' : 'broken';
}

function daysWord(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дні';
  return 'днів';
}

function lastClosedDay() {
  return isPastDeadline() ? today() : addDays(today(), -1);
}

// Повертає поточну серію і заодно видає бонуси за кожні 7 днів поспіль
function scanStreak() {
  let run = 0;
  for (const day of daysFrom(setupDay(), lastClosedDay())) {
    const s = dayStatus(day);
    if (s === 'paused') continue;
    if (s === 'pending') break;
    if (s === 'broken') { run = 0; continue; }
    run++;
    const key = `streak:${day}`;
    if (run % 7 === 0 && !hasAward(key)) {
      markAward(key);
      addEntry({ amount: getNumber('bonus_streak'), kind: 'bonus', note: `Бонус за серію: ${run} ${daysWord(run)} поспіль` });
    }
  }
  return run;
}

function tickPerfectMonths() {
  const start = setupDay();
  const closed = lastClosedDay();
  // Лише повні місяці, що почалися після старту додатка
  const first = start.endsWith('-01') ? monthOf(start) : addMonths(monthOf(start), 1);
  for (let m = first; lastDayOfMonth(m) <= closed; m = addMonths(m, 1)) {
    const key = `month:${m}`;
    if (hasAward(key)) continue;
    const statuses = [...daysFrom(`${m}-01`, lastDayOfMonth(m))].map(dayStatus);
    if (statuses.includes('pending')) continue;
    const active = statuses.filter(s => s !== 'paused');
    if (!active.length || active.some(s => s !== 'complete') || sonFinesIn(m) > 0) {
      markAward(key); // місяць не ідеальний — більше не перевіряємо
      continue;
    }
    markAward(key);
    addEntry({ amount: getNumber('bonus_perfect_month'), kind: 'bonus', note: `Ідеальний місяць: ${MONTHS[Number(m.slice(5)) - 1]}` });
  }
}

let currentStreak = 0;

export function tickBonuses() {
  tickHolidays();
  currentStreak = scanStreak();
  tickPerfectMonths();
}

export function streakInfo() {
  return { days: currentStreak, untilBonus: 7 - (currentStreak % 7) };
}
