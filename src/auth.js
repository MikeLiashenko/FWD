import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { db, getSetting } from './db.js';
import { nowIso } from './time.js';

const COOKIE = 'zdt_session';
const SESSION_DAYS = 30;

export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPin(pin, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Новий PIN — від 6 цифр (додаток доступний з інтернету). Для входу приймаємо й старі 4-значні.
export function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{6,8}$/.test(pin);
}

const looksLikePin = pin => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

// Хто звертається. Через Cloudflare Tunnel запит приходить з localhost, але з заголовком
// CF-Connecting-IP, який Cloudflare додає завжди. Тому «локальний» = без цього заголовка й з 127.0.0.1.
// На хостингу перед сервером стоїть проксі, тоді справжню адресу дає req.ip (див. trust proxy)
export function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || req.socket.remoteAddress || '?';
}

export function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || '';
  return !req.headers['cf-connecting-ip'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
}

export function hasUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

export function createUsers(son, parents) {
  const insert = db.prepare('INSERT INTO users (role, name, pin_hash, created_at) VALUES (?, ?, ?, ?)');
  insert.run('son', son.name, hashPin(son.pin), nowIso());
  insert.run('parents', parents.name, hashPin(parents.pin), nowIso());
}

export function listUsers() {
  return db.prepare('SELECT id, role, name FROM users ORDER BY id').all();
}

// Захист від підбору PIN:
// - акаунт: 5 помилок поспіль → блокування на 15 хвилин;
// - адреса: 10 помилок за годину → блокування цієї адреси на годину;
// - усього: 40 помилок за годину з інтернету → вхід ззовні вимикається на годину (з ноутбука працює).
const MINUTE = 60_000;
const byAccount = new Map(); // userId → { count, until }
const byIp = new Map();      // ip → [час помилки, ...]
let remoteFails = [];        // час помилок з інтернету
let remoteLockedUntil = 0;

const recent = (times, ms) => times.filter(t => Date.now() - t < ms);

function lockMessage(until) {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / MINUTE));
  return `Забагато невдалих спроб. Спробуй через ${minutes} хв.`;
}

// Блокування стосуються лише входу з інтернету: з самого ноутбука увійти можна завжди,
// інакше зловмисник міг би навмисно «замкнути» сім'ю з її ж додатка.
export function login(userId, pin, { ip = '?', local = false } = {}) {
  const now = Date.now();
  const ipFails = recent(byIp.get(ip) ?? [], 60 * MINUTE);
  const acc = byAccount.get(userId);
  if (!local) {
    if (remoteLockedUntil > now) return { error: lockMessage(remoteLockedUntil) };
    if (ipFails.length >= 10) return { error: lockMessage(ipFails[0] + 60 * MINUTE) };
    if (acc?.until > now) return { error: lockMessage(acc.until) };
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !looksLikePin(pin) || !checkPin(pin, user.pin_hash)) {
    if (local) return { error: 'Неправильний PIN' };
    const count = (acc?.count ?? 0) + 1;
    byAccount.set(userId, { count: count >= 5 ? 0 : count, until: count >= 5 ? now + 15 * MINUTE : 0 });
    byIp.set(ip, [...ipFails, now]);
    remoteFails = [...recent(remoteFails, 60 * MINUTE), now];
    if (remoteFails.length >= 40) {
      remoteLockedUntil = now + 60 * MINUTE;
      console.warn('Увага: забагато невдалих спроб входу з інтернету — вхід ззовні вимкнено на годину.');
    }
    return { error: count >= 5 ? lockMessage(now + 15 * MINUTE) : 'Неправильний PIN' };
  }
  if (!local) byAccount.delete(userId);
  return { user: { id: user.id, role: user.role, name: user.name } };
}

function sign(payload) {
  return createHmac('sha256', getSetting('session_secret')).update(payload).digest('base64url');
}

export function setSessionCookie(req, res, userId) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${userId}.${expires}`;
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure, // через Cloudflare (https) cookie не піде відкритим каналом
    maxAge: SESSION_DAYS * 86_400_000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE);
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function currentUser(req) {
  const raw = readCookie(req);
  if (!raw) return null;
  const [userId, expires, sig] = raw.split('.');
  if (!sig) return null;
  const expected = sign(`${userId}.${expires}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Date.now() > Number(expires)) return null;
  return db.prepare('SELECT id, role, name FROM users WHERE id = ?').get(Number(userId)) ?? null;
}

export function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Потрібно увійти' });
  req.user = user;
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: 'Немає доступу' });
    next();
  };
}
