import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Папку з даними можна змінити: --data=інша-папка або змінна ZDT_DATA_DIR
const dataArg = process.argv.find(a => a.startsWith('--data='))?.slice(7);
export const DATA_DIR = path.resolve(dataArg || process.env.ZDT_DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'zdt.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('son', 'parents')),
  name        TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  day           TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  difficulty    TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  reward        INTEGER NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('ai', 'bank')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'submitted', 'approved', 'rejected', 'expired', 'replaced')),
  proof_note    TEXT,
  proof_image   TEXT,
  submitted_at  TEXT,
  reviewed_at   TEXT,
  review_note   TEXT,
  auto_approved INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);

-- П. 7.2: журнал блісків. Записи лише додаються; змінити чи видалити їх не можна.
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY,
  created_at  TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  task_id     INTEGER REFERENCES tasks(id),
  note        TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id)
);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

-- П. 4: оцінки
CREATE TABLE IF NOT EXISTS grades (
  id            INTEGER PRIMARY KEY,
  day           TEXT NOT NULL,
  subject       TEXT NOT NULL,
  grade         INTEGER NOT NULL CHECK (grade BETWEEN 9 AND 12),
  kind          TEXT NOT NULL CHECK (kind IN ('class', 'home', 'independent', 'test', 'topic')),
  reward        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  submitted_at  TEXT NOT NULL,
  reviewed_at   TEXT,
  review_note   TEXT,
  auto_approved INTEGER NOT NULL DEFAULT 0
);

-- Разові нарахування (свята, серії, ідеальний місяць): ключ гарантує, що бонус не видасться двічі
CREATE TABLE IF NOT EXISTS awards (
  key         TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

-- П. 5: скарги. Рішення пропонує одна сторона, підтверджує інша.
CREATE TABLE IF NOT EXISTS complaints (
  id           INTEGER PRIMARY KEY,
  against      TEXT NOT NULL CHECK (against IN ('son', 'parents')),
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fined', 'dismissed')),
  proposal     TEXT CHECK (proposal IN ('fine', 'dismiss')),
  proposed_by  TEXT CHECK (proposed_by IN ('son', 'parents')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

-- П. 3: штрафи. Лічильник ведеться окремо для кожної сторони й обнуляється щомісяця.
CREATE TABLE IF NOT EXISTS fines (
  id            INTEGER PRIMARY KEY,
  side          TEXT NOT NULL CHECK (side IN ('son', 'parents')),
  month         TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  complaint_id  INTEGER REFERENCES complaints(id),
  created_at    TEXT NOT NULL
);

-- П. 9: пауза. Діє лише за згодою обох сторін.
CREATE TABLE IF NOT EXISTS pauses (
  id            INTEGER PRIMARY KEY,
  start_day     TEXT NOT NULL,
  end_day       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  requested_by  TEXT NOT NULL CHECK (requested_by IN ('son', 'parents')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'declined', 'ended')),
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);

-- П. 6: магазин подарунків за бліски
CREATE TABLE IF NOT EXISTS shop_items (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL CHECK (price > 0),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES shop_items(id),
  name          TEXT NOT NULL,
  price         INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'delivered')),
  note          TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  delivered_at  TEXT
);

-- П. 7.3, 12.2: теми для сімейних зборів у неділю
CREATE TABLE IF NOT EXISTS topics (
  id             INTEGER PRIMARY KEY,
  text           TEXT NOT NULL,
  created_by     TEXT NOT NULL CHECK (created_by IN ('son', 'parents')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'discussed')),
  decision       TEXT,
  created_at     TEXT NOT NULL,
  discussed_at   TEXT
);

-- П. 1.2, 2.3: щомісячна виплата 6 числа
CREATE TABLE IF NOT EXISTS payouts (
  id           INTEGER PRIMARY KEY,
  month        TEXT NOT NULL UNIQUE,
  percent      INTEGER NOT NULL,
  blisks       INTEGER NOT NULL,
  uah          INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('owed', 'paid', 'received', 'empty')),
  created_at   TEXT NOT NULL,
  paid_at      TEXT,
  received_at  TEXT
);
`);

// Синхронізація з Firebase: кожна зміна в цих таблицях потрапляє в чергу sync_queue,
// а src/cloud.js відправляє її у Firestore. Значення — первинний ключ таблиці.
export const SYNC_TABLES = {
  users: 'id', settings: 'key', tasks: 'id', ledger: 'id', grades: 'id', awards: 'key',
  complaints: 'id', fines: 'id', pauses: 'id', payouts: 'id', shop_items: 'id', purchases: 'id', topics: 'id',
};

db.exec('CREATE TABLE IF NOT EXISTS sync_queue (id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, pk TEXT NOT NULL)');
for (const [t, pk] of Object.entries(SYNC_TABLES)) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_${t}_i AFTER INSERT ON ${t} BEGIN INSERT INTO sync_queue (tbl, pk) VALUES ('${t}', NEW.${pk}); END;
    CREATE TRIGGER IF NOT EXISTS sync_${t}_u AFTER UPDATE ON ${t} BEGIN INSERT INTO sync_queue (tbl, pk) VALUES ('${t}', NEW.${pk}); END;
    CREATE TRIGGER IF NOT EXISTS sync_${t}_d AFTER DELETE ON ${t} BEGIN INSERT INTO sync_queue (tbl, pk) VALUES ('${t}', OLD.${pk}); END;
  `);
}

export function queueUpload(file) {
  db.prepare("INSERT INTO sync_queue (tbl, pk) VALUES ('uploads', ?)").run(file);
}

// Значення за замовчуванням. Змінюються на сімейних зборах (п. 12.2).
const DEFAULTS = {
  rate_blisks: '25',      // п. 2.1: 25 блісків = 10 грн
  rate_uah: '10',
  regen_limit: '3',       // п. 1.3: перегенерацій на день
  tasks_per_day: '3',
  reward_easy: '10',
  reward_medium: '20',
  reward_hard: '40',
  son_birth_date: '',     // задається під час першого запуску
  // п. 4: бліски за оцінки та множники за вид роботи
  grade_12: '50',
  grade_11: '30',
  grade_10: '15',
  grade_9: '5',
  mult_class: '1',
  mult_home: '2',
  mult_independent: '3',
  mult_test: '4',
  mult_topic: '5',
  // п. 3: штраф 150, кожен наступний у місяці +50% від початкової суми
  fine_base: '150',
  fine_step_percent: '50',
  // п. 2.2: свята
  holiday_birthday: '10000',
  holiday_nicholas: '100',
  holiday_new_year: '1000',
  holiday_defenders: '150',
  holiday_easter: '500',
  holiday_children: '150',
  holiday_tooth_fairy: '150',
  // п. 11: бонуси
  bonus_streak: '75',
  bonus_perfect_month: '500',
  // п. 2.3: відсоток виплати, який обирає син
  payout_percent: '100',
  // п. 12.1: дата закінчення договору (порожньо — 3 місяці від старту додатка)
  contract_end: '',
};

const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULTS)) insertDefault.run(k, v);
insertDefault.run('session_secret', randomBytes(32).toString('hex'));
insertDefault.run('contract_renew_by', ''); // хто запропонував продовжити договір

// П. 6.1: приклад подарунка з договору
if (!db.prepare('SELECT 1 FROM shop_items LIMIT 1').get()) {
  db.prepare('INSERT INTO shop_items (name, description, price, created_at) VALUES (?, ?, ?, ?)')
    .run('1 раз не йти в тривогу до школи', 'Приклад із договору (п. 6.1)', 30, new Date().toISOString());
}

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

export function getNumber(key) {
  return Number(getSetting(key));
}

export function setSetting(key, value) {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
}

export const PUBLIC_SETTINGS = Object.keys(DEFAULTS);

// Вкладені виклики виконуються всередині зовнішньої транзакції
let depth = 0;
export function transaction(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export function hasAward(key) {
  return Boolean(db.prepare('SELECT 1 FROM awards WHERE key = ?').get(key));
}

export function markAward(key) {
  db.prepare('INSERT INTO awards (key, created_at) VALUES (?, ?)').run(key, new Date().toISOString());
}
