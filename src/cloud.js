// Хмарна копія бази у Firebase Realtime Database (розділ /zdt).
// Додаток працює з локальною базою (швидко й без лімітів), а кожна зміна через кілька секунд
// відправляється в хмару. На новому комп'ютері з порожньою базою дані відновлюються з хмари.
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { db, SYNC_TABLES, UPLOAD_DIR, transaction } from './db.js';

const KEY_PATH = path.resolve(process.env.ZDT_FIREBASE_KEY || 'firebase-key.json');
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const ROOT = process.env.ZDT_CLOUD_PREFIX || 'zdt'; // інший розділ — для тестів
const PUSH_EVERY_MS = 5_000;
const MAX_PHOTO_BYTES = 5_000_000;

// На хостингу (Render) ключ лежить не у файлі, а в змінній середовища FIREBASE_KEY_JSON
const KEY_FROM_ENV = process.env.FIREBASE_KEY_JSON;
export const cloudEnabled = Boolean(KEY_FROM_ENV) || existsSync(KEY_PATH);

function readKey() {
  return JSON.parse(KEY_FROM_ENV || readFileSync(KEY_PATH, 'utf8'));
}

const status = {
  enabled: cloudEnabled,
  connected: false,
  project: null,
  lastSync: null,
  lastError: null,
  restored: false,
};

let root = null; // посилання на /zdt; створюється один раз

export class HostedElsewhereError extends Error {
  constructor(url) {
    super(`Сервер ЗДТ тепер працює на Render${url ? ` (${url})` : ''}. Запуск на цьому комп'ютері вимкнено, щоб не зіпсувати дані.`);
    this.url = url;
  }
}
const pendingCount = () => db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n;

// У ключах Realtime Database не можна використовувати . $ # [ ] /
const encodeKey = key => encodeURIComponent(String(key)).replace(/\./g, '%2E');
const decodeKey = key => decodeURIComponent(key);

export function cloudStatus() {
  return { ...status, pending: pendingCount() };
}

// Повний список того, що треба відправити, коли хмара ще порожня
function enqueueAll() {
  transaction(() => {
    for (const [t, pk] of Object.entries(SYNC_TABLES)) {
      db.exec(`INSERT INTO sync_queue (tbl, pk) SELECT '${t}', ${pk} FROM ${t}`);
    }
    const add = db.prepare("INSERT INTO sync_queue (tbl, pk) VALUES ('uploads', ?)");
    for (const file of readdirSync(UPLOAD_DIR)) add.run(file);
  });
}

async function restore() {
  const snap = await root.get();
  const data = {};
  for (const t of Object.keys(SYNC_TABLES)) {
    data[t] = [];
    // forEach, а не val(): числові ключі Realtime Database інакше перетворює на масив
    snap.child(t).forEach(child => { data[t].push(child.val()); });
  }

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
      for (const [t, rows] of Object.entries(data)) {
        // Журнал блісків не можна чистити (п. 7.2), але в новій базі він і так порожній.
        // Налаштування не чистимо: значення з хмари замінять стандартні, а нові ключі залишаться.
        if (t !== 'ledger' && t !== 'settings') db.exec(`DELETE FROM ${t}`);
        for (const row of rows) {
          const cols = Object.keys(row);
          db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map(c => row[c]));
        }
      }
      db.exec('DELETE FROM sync_queue'); // щойно завантажене вже є в хмарі
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  snap.child('uploads').forEach(child => {
    writeFileSync(path.join(UPLOAD_DIR, path.basename(decodeKey(child.key))), Buffer.from(child.val(), 'base64'));
  });
  status.restored = true;
  console.log(`Хмара: базу відновлено з Firebase (${data.users.length} користувачі, ${data.ledger.length} записів журналу).`);
}

let pushing = false;

async function pushChanges() {
  if (!status.connected || pushing) return;
  pushing = true;
  try {
    for (;;) {
      const queue = db.prepare('SELECT id, tbl, pk FROM sync_queue ORDER BY id LIMIT 400').all();
      if (!queue.length) break;
      const maxId = queue.at(-1).id;
      const unique = new Map(queue.map(q => [`${q.tbl}/${q.pk}`, q]));

      // Одне атомарне оновлення кількох шляхів; null видаляє запис
      const updates = {};
      const photos = [];
      for (const { tbl, pk } of unique.values()) {
        if (tbl === 'uploads') { photos.push(pk); continue; }
        const row = db.prepare(`SELECT * FROM ${tbl} WHERE ${SYNC_TABLES[tbl]} = ?`).get(pk);
        updates[`${tbl}/${encodeKey(pk)}`] = row ? { ...row } : null;
      }
      if (Object.keys(updates).length) await root.update(updates);

      // Фото відправляються по одному, щоб не робити завеликий запит
      for (const file of photos) {
        const full = path.join(UPLOAD_DIR, file);
        const ref = root.child(`uploads/${encodeKey(file)}`);
        if (!existsSync(full)) { await ref.remove(); continue; }
        const buf = readFileSync(full);
        if (buf.length > MAX_PHOTO_BYTES) {
          console.warn(`Хмара: фото ${file} завелике, лишається лише на комп'ютері.`);
          continue;
        }
        await ref.set(buf.toString('base64'));
      }

      db.prepare('DELETE FROM sync_queue WHERE id <= ?').run(maxId);
    }
    status.lastSync = new Date().toISOString();
    status.lastError = null;
  } catch (err) {
    status.lastError = err.message;
    console.error('Хмара: не вдалося відправити зміни —', err.message);
  } finally {
    pushing = false;
  }
}

async function connect() {
  if (!DATABASE_URL) throw new Error('не задано FIREBASE_DATABASE_URL (у .env або в налаштуваннях хостингу)');
  if (!root) {
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getDatabase } = await import('firebase-admin/database');
    const key = readKey();
    status.project = key.project_id;
    root = getDatabase(initializeApp({ credential: cert(key), databaseURL: DATABASE_URL })).ref(ROOT);
  }

  // Сервер має працювати лише в одному місці. Render позначає себе в /zdt_host;
  // сервер на ноутбуці, побачивши цю позначку, не запускається, щоб не перезаписувати дані.
  const hostRef = root.parent.child(`${ROOT}_host`);
  if (process.env.RENDER) {
    await hostRef.set({ host: 'render', url: process.env.RENDER_EXTERNAL_URL ?? null, since: new Date().toISOString() });
  } else if (!process.env.ZDT_ALLOW_LOCAL) {
    const host = (await hostRef.get()).val();
    if (host?.host === 'render') throw new HostedElsewhereError(host.url);
  }

  const cloudHasData = (await root.child('users').limitToFirst(1).get()).exists();
  const localHasData = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (cloudHasData && !localHasData) await restore();
  else if (!cloudHasData) enqueueAll(); // хмара порожня — відправляємо все, що є локально
  status.connected = true;
  console.log(`Хмара: підключено до Firebase (проєкт ${status.project}, розділ /${ROOT}).`);
}

// Викликається один раз перед стартом сервера. Без інтернету сервер усе одно запуститься,
// а підключення повторюватиметься щохвилини.
export async function initCloud() {
  if (!cloudEnabled) {
    console.log('Хмара: немає ключа Firebase (firebase-key.json або FIREBASE_KEY_JSON) — дані зберігаються лише тут.');
    return;
  }
  const tryConnect = async () => {
    try {
      await connect();
      await pushChanges();
      await publishPendingLink();
      setInterval(pushChanges, PUSH_EVERY_MS);
      return true;
    } catch (err) {
      if (err instanceof HostedElsewhereError) throw err;
      status.connected = false;
      status.lastError = err.message;
      console.error('Хмара: не вдалося підключитися до Firebase —', err.message);
      return false;
    }
  };
  if (await tryConnect()) return;
  const retry = setInterval(async () => {
    if (await tryConnect()) clearInterval(retry);
  }, 60_000);
}

// Поточна адреса тунелю лежить у /zdt_link — це єдине місце, яке правила дозволяють читати всім.
// Сторінка на GitHub Pages читає її й перекидає туди.
let linkToPublish = null;

async function publishPendingLink() {
  if (!status.connected || !linkToPublish) return;
  const url = linkToPublish;
  try {
    await root.parent.child(`${ROOT}_link`).set({ url, updated: new Date().toISOString() });
    if (linkToPublish === url) linkToPublish = null;
    console.log('Хмара: нову адресу записано для сторінки на GitHub.');
  } catch (err) {
    status.lastError = err.message;
    console.error('Хмара: не вдалося записати адресу —', err.message);
  }
}

export function publishLink(url) {
  linkToPublish = url;
  return publishPendingLink();
}

// Перед вимкненням сервера (хостинг «засинає» або оновлюється) відправляємо все, що лишилося в черзі
export async function flushCloud() {
  if (!status.connected) return;
  for (let i = 0; i < 20 && (pushing || pendingCount() > 0); i++) {
    await pushChanges();
    if (pushing) await new Promise(r => setTimeout(r, 250));
  }
}

// Для тестів: зупинити з'єднання, щоб процес міг завершитися
export async function closeCloud() {
  const { getApps, deleteApp } = await import('firebase-admin/app');
  await Promise.all(getApps().map(deleteApp));
}
