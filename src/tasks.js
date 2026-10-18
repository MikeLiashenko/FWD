import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, getNumber, getSetting, transaction, UPLOAD_DIR, queueUpload } from './db.js';
import { today, isPastDeadline, nowIso, ageOn } from './time.js';
import { aiEnabled, generateWithAI } from './ai.js';
import { pickFromBank } from './taskBank.js';
import { addEntry } from './ledger.js';

import { TaskError } from './errors.js';
import { isPaused } from './family.js';

export { TaskError };
export const DIFFICULTIES = ['easy', 'medium', 'hard'];
const REVIEW_HOURS = 24; // п. 8.2

function getTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new TaskError('Завдання не знайдено');
  return task;
}

function recentTitles() {
  return db.prepare('SELECT title FROM tasks ORDER BY id DESC LIMIT 20').all().map(r => r.title);
}

async function invent(difficulty) {
  const recent = recentTitles();
  if (aiEnabled) {
    try {
      const birth = getSetting('son_birth_date');
      const age = birth ? ageOn(birth) : null;
      return { ...(await generateWithAI({ difficulty, age, recentTitles: recent })), source: 'ai' };
    } catch (err) {
      console.error('ШІ не зміг згенерувати завдання, беру з банку:', err.message);
    }
  }
  return { ...pickFromBank(difficulty, recent), source: 'bank' };
}

function dayStats(day) {
  return db.prepare(`
    SELECT
      SUM(status != 'replaced') AS live,
      SUM(status = 'replaced')  AS replaced
    FROM tasks WHERE day = ?
  `).get(day);
}

export function todayInfo() {
  const day = today();
  const stats = dayStats(day);
  return {
    day,
    pastDeadline: isPastDeadline(),
    tasksLeft: Math.max(0, getNumber('tasks_per_day') - (stats.live ?? 0)),
    regensLeft: Math.max(0, getNumber('regen_limit') - (stats.replaced ?? 0)),
    paused: isPaused(day),
    aiEnabled,
  };
}

export function listDay(day = today()) {
  return db.prepare("SELECT * FROM tasks WHERE day = ? AND status != 'replaced' ORDER BY id").all(day);
}

export function listForReview() {
  return db.prepare("SELECT * FROM tasks WHERE status = 'submitted' ORDER BY submitted_at").all();
}

export function listRecent(limit = 50) {
  return db.prepare("SELECT * FROM tasks WHERE status != 'replaced' ORDER BY id DESC LIMIT ?").all(limit);
}

export async function createTask(difficulty) {
  if (!DIFFICULTIES.includes(difficulty)) throw new TaskError('Невідома складність');
  const info = todayInfo();
  if (info.pastDeadline) throw new TaskError('Після 23:00 нові завдання не видаються');
  if (info.paused) throw new TaskError('Зараз пауза — відпочивай');
  if (info.tasksLeft <= 0) throw new TaskError('На сьогодні завдань уже достатньо');

  const task = await invent(difficulty);
  // Перевіряємо ще раз: поки ШІ думав, могло бути створене інше завдання
  return transaction(() => {
    if (todayInfo().tasksLeft <= 0) throw new TaskError('На сьогодні завдань уже достатньо');
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tasks (day, title, description, difficulty, reward, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(info.day, task.title, task.description, difficulty, getNumber(`reward_${difficulty}`), task.source, nowIso());
    return getTask(lastInsertRowid);
  });
}

// П. 1.3: перегенерація — старе завдання позначається як замінене, нове має ту саму складність
export async function regenerateTask(id) {
  const old = getTask(id);
  const info = todayInfo();
  if (old.status !== 'active' || old.day !== info.day) throw new TaskError('Перегенерувати можна лише сьогоднішнє активне завдання');
  if (info.pastDeadline) throw new TaskError('Після 23:00 перегенерація недоступна');
  if (info.regensLeft <= 0) throw new TaskError('Перегенерації на сьогодні закінчились');

  const task = await invent(old.difficulty);
  return transaction(() => {
    const current = getTask(id);
    if (current.status !== 'active') throw new TaskError('Завдання вже змінилось');
    if (todayInfo().regensLeft <= 0) throw new TaskError('Перегенерації на сьогодні закінчились');
    db.prepare("UPDATE tasks SET status = 'replaced' WHERE id = ?").run(id);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tasks (day, title, description, difficulty, reward, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(old.day, task.title, task.description, old.difficulty, old.reward, task.source, nowIso());
    return getTask(lastInsertRowid);
  });
}

function saveProofImage(taskId, dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new TaskError('Фото має бути у форматі JPEG, PNG або WebP');
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) throw new TaskError('Фото завелике (максимум 5 МБ)');
  const file = `task-${taskId}-${Date.now()}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
  writeFileSync(path.join(UPLOAD_DIR, file), buf);
  queueUpload(file);
  return file;
}

// Син позначає завдання виконаним (до 23:00), за бажанням із доказом (п. 8.1)
export function submitTask(id, { note, image }) {
  const task = getTask(id);
  if (task.status !== 'active') throw new TaskError('Це завдання вже не активне');
  if (task.day !== today() || isPastDeadline()) throw new TaskError('Час на це завдання минув (дедлайн 23:00)');
  const proofImage = image ? saveProofImage(id, image) : null;
  db.prepare(`
    UPDATE tasks SET status = 'submitted', proof_note = ?, proof_image = ?, submitted_at = ?
    WHERE id = ? AND status = 'active'
  `).run(note?.trim() || null, proofImage, nowIso(), id);
  return getTask(id);
}

function approve(task, { reviewerId, note, auto }) {
  db.prepare(`
    UPDATE tasks SET status = 'approved', reviewed_at = ?, review_note = ?, auto_approved = ?
    WHERE id = ?
  `).run(nowIso(), note ?? null, auto ? 1 : 0, task.id);
  addEntry({
    amount: task.reward,
    kind: 'task',
    taskId: task.id,
    note: `${auto ? 'Автозарахування (24 год)' : 'Виконано'}: ${task.title}`,
    createdBy: reviewerId,
  });
}

export function reviewTask(id, { approved, note, reviewerId }) {
  return transaction(() => {
    const task = getTask(id);
    if (task.status !== 'submitted') throw new TaskError('Це завдання не чекає перевірки');
    if (approved) {
      approve(task, { reviewerId, note, auto: false });
    } else {
      if (!note?.trim()) throw new TaskError('Напиши, чому завдання відхилено');
      db.prepare("UPDATE tasks SET status = 'rejected', reviewed_at = ?, review_note = ? WHERE id = ?")
        .run(nowIso(), note.trim(), id);
    }
    return getTask(id);
  });
}

// Фонова перевірка: прострочені завдання (п. 10.1) і автозарахування через 24 години (п. 8.2)
export function tick() {
  transaction(() => {
    const day = today();
    db.prepare("UPDATE tasks SET status = 'expired' WHERE status = 'active' AND day < ?").run(day);
    if (isPastDeadline()) {
      db.prepare("UPDATE tasks SET status = 'expired' WHERE status = 'active' AND day = ?").run(day);
    }
    const cutoff = new Date(Date.now() - REVIEW_HOURS * 3_600_000).toISOString();
    const overdue = db.prepare("SELECT * FROM tasks WHERE status = 'submitted' AND submitted_at <= ?").all(cutoff);
    for (const task of overdue) approve(task, { reviewerId: null, note: null, auto: true });
  });
}
