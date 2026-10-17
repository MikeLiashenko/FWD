// Усі дати й дедлайни рахуються за київським часом, незалежно від часового поясу комп'ютера.
const TZ = 'Europe/Kyiv';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function parts(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}

// Поточний день у форматі YYYY-MM-DD (Київ)
export function today(date = new Date()) {
  return parts(date).day;
}

// П. 10.1: щоденні завдання треба позначити до 23:00
export const DEADLINE_HOUR = 23;

export function isPastDeadline(date = new Date()) {
  return parts(date).hour >= DEADLINE_HOUR;
}

export function nowIso() {
  return new Date().toISOString();
}

// Арифметика з днями YYYY-MM-DD (рахуємо в UTC, щоб не заважали переходи на літній час)
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthOf(day) {
  return day.slice(0, 7);
}

export function lastDayOfMonth(month) {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function* daysFrom(start, endInclusive) {
  for (let d = start; d <= endInclusive; d = addDays(d, 1)) yield d;
}

export function ageOn(birthDate, day = today()) {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
