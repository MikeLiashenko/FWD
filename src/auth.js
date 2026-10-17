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

export function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
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

// Захист від підбору PIN: після 5 помилок вхід блокується на хвилину.
const failures = new Map();

export function login(userId, pin) {
  const f = failures.get(userId);
  if (f && f.count >= 5 && Date.now() - f.last < 60_000) {
    return { error: 'Забагато спроб. Зачекай хвилину.' };
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !isValidPin(pin) || !checkPin(pin, user.pin_hash)) {
    failures.set(userId, { count: (f?.count ?? 0) + 1, last: Date.now() });
    return { error: 'Неправильний PIN' };
  }
  failures.delete(userId);
  return { user: { id: user.id, role: user.role, name: user.name } };
}

function sign(payload) {
  return createHmac('sha256', getSetting('session_secret')).update(payload).digest('base64url');
}

export function setSessionCookie(res, userId) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${userId}.${expires}`;
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 86_400_000,
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
