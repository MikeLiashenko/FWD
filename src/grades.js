import { db, getNumber, transaction } from './db.js';
import { today, nowIso } from './time.js';
import { addEntry } from './ledger.js';
import { TaskError } from './errors.js';

// П. 4.2: види робіт
export const GRADE_KINDS = ['class', 'home', 'independent', 'test', 'topic'];
const REVIEW_HOURS = 24;

// П. 4.1–4.2: базова сума за оцінку × множник за вид роботи
export function gradeReward(grade, kind) {
  return getNumber(`grade_${grade}`) * getNumber(`mult_${kind}`);
}

function getGrade(id) {
  const g = db.prepare('SELECT * FROM grades WHERE id = ?').get(id);
  if (!g) throw new TaskError('Оцінку не знайдено');
  return g;
}

export function addGrade({ subject, grade, kind, day }) {
  subject = subject?.trim();
  grade = Number(grade);
  day = day || today();
  if (!subject) throw new TaskError('Вкажи предмет');
  if (subject.length > 60) throw new TaskError('Назва предмета задовга');
  if (![9, 10, 11, 12].includes(grade)) throw new TaskError('Бліски даються за оцінки від 9 до 12');
  if (!GRADE_KINDS.includes(kind)) throw new TaskError('Обери вид роботи');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today()) throw new TaskError('Неправильна дата');
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO grades (day, subject, grade, kind, reward, submitted_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(day, subject, grade, kind, gradeReward(grade, kind), nowIso());
  return getGrade(lastInsertRowid);
}

function approve(g, { reviewerId, note, auto }) {
  db.prepare("UPDATE grades SET status = 'approved', reviewed_at = ?, review_note = ?, auto_approved = ? WHERE id = ?")
    .run(nowIso(), note ?? null, auto ? 1 : 0, g.id);
  addEntry({
    amount: g.reward,
    kind: 'grade',
    note: `${auto ? 'Автозарахування (24 год)' : 'Оцінка'}: ${g.grade} з предмета «${g.subject}»`,
    createdBy: reviewerId,
  });
}

export function reviewGrade(id, { approved, note, reviewerId }) {
  return transaction(() => {
    const g = getGrade(id);
    if (g.status !== 'submitted') throw new TaskError('Ця оцінка не чекає перевірки');
    if (approved) {
      approve(g, { reviewerId, note, auto: false });
    } else {
      if (!note?.trim()) throw new TaskError('Напиши, чому оцінку відхилено');
      db.prepare("UPDATE grades SET status = 'rejected', reviewed_at = ?, review_note = ? WHERE id = ?")
        .run(nowIso(), note.trim(), id);
    }
    return getGrade(id);
  });
}

export function listGrades(limit = 60) {
  return db.prepare('SELECT * FROM grades ORDER BY day DESC, id DESC LIMIT ?').all(limit);
}

export function gradesForReview() {
  return db.prepare("SELECT * FROM grades WHERE status = 'submitted' ORDER BY submitted_at").all();
}

export function recentSubjects() {
  return db.prepare('SELECT subject FROM grades GROUP BY subject ORDER BY MAX(id) DESC LIMIT 12').all().map(r => r.subject);
}

// Як і завдання, оцінка зараховується автоматично, якщо батьки не перевірили її за 24 години
export function tickGrades() {
  const cutoff = new Date(Date.now() - REVIEW_HOURS * 3_600_000).toISOString();
  const overdue = db.prepare("SELECT * FROM grades WHERE status = 'submitted' AND submitted_at <= ?").all(cutoff);
  for (const g of overdue) approve(g, { reviewerId: null, note: null, auto: true });
}
