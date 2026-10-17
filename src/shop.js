// П. 6: подарунки від батьків за бліски. Купівлю погоджують батьки (на зборах у неділю, п. 6.2).
import { db, transaction } from './db.js';
import { nowIso } from './time.js';
import { addEntry, balance } from './ledger.js';
import { TaskError } from './errors.js';

function getItem(id) {
  const item = db.prepare('SELECT * FROM shop_items WHERE id = ?').get(id);
  if (!item) throw new TaskError('Подарунок не знайдено');
  return item;
}

function getPurchase(id) {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!p) throw new TaskError('Покупку не знайдено');
  return p;
}

function cleanItem({ name, description, price }) {
  name = name?.trim();
  price = Number(price);
  if (!name) throw new TaskError('Вкажи назву подарунка');
  if (name.length > 80) throw new TaskError('Назва задовга');
  if (!Number.isInteger(price) || price <= 0) throw new TaskError('Ціна — ціле число блісків, більше 0');
  return { name, description: description?.trim().slice(0, 200) ?? '', price };
}

export function listItems({ includeHidden = false } = {}) {
  return db.prepare(`SELECT * FROM shop_items ${includeHidden ? '' : 'WHERE active = 1'} ORDER BY active DESC, price`).all();
}

export function addItem(data) {
  const { name, description, price } = cleanItem(data);
  const { lastInsertRowid } = db.prepare('INSERT INTO shop_items (name, description, price, created_at) VALUES (?, ?, ?, ?)')
    .run(name, description, price, nowIso());
  return getItem(lastInsertRowid);
}

export function updateItem(id, data) {
  getItem(id);
  if ('active' in data && Object.keys(data).length === 1) {
    db.prepare('UPDATE shop_items SET active = ? WHERE id = ?').run(data.active ? 1 : 0, id);
  } else {
    const { name, description, price } = cleanItem(data);
    db.prepare('UPDATE shop_items SET name = ?, description = ?, price = ? WHERE id = ?').run(name, description, price, id);
  }
  return getItem(id);
}

// Бліски, які вже обіцяні на покупки, що чекають рішення
function reserved() {
  return db.prepare("SELECT COALESCE(SUM(price), 0) AS s FROM purchases WHERE status = 'pending'").get().s;
}

export function available() {
  return balance() - reserved();
}

export function buy(itemId) {
  const item = getItem(itemId);
  if (!item.active) throw new TaskError('Цього подарунка вже немає');
  if (available() < item.price) throw new TaskError(`Не вистачає ${item.price - available()} блісків`);
  const { lastInsertRowid } = db.prepare('INSERT INTO purchases (item_id, name, price, created_at) VALUES (?, ?, ?, ?)')
    .run(item.id, item.name, item.price, nowIso());
  return getPurchase(lastInsertRowid);
}

export function cancelPurchase(id) {
  const p = getPurchase(id);
  if (p.status !== 'pending') throw new TaskError('Покупку вже розглянуто');
  db.prepare("UPDATE purchases SET status = 'declined', note = 'Скасовано сином', decided_at = ? WHERE id = ?").run(nowIso(), id);
}

export function decide(id, { approve, note, reviewerId }) {
  return transaction(() => {
    const p = getPurchase(id);
    if (p.status !== 'pending') throw new TaskError('Покупку вже розглянуто');
    if (approve) {
      if (balance() < p.price) throw new TaskError('На балансі сина вже не вистачає блісків');
      db.prepare("UPDATE purchases SET status = 'approved', note = ?, decided_at = ? WHERE id = ?").run(note?.trim() || null, nowIso(), id);
      addEntry({ amount: -p.price, kind: 'purchase', note: `Покупка: ${p.name}`, createdBy: reviewerId });
    } else {
      if (!note?.trim()) throw new TaskError('Напишіть, чому відмовили');
      db.prepare("UPDATE purchases SET status = 'declined', note = ?, decided_at = ? WHERE id = ?").run(note.trim(), nowIso(), id);
    }
    return getPurchase(id);
  });
}

export function markDelivered(id) {
  const p = getPurchase(id);
  if (p.status !== 'approved') throw new TaskError('Спершу покупку треба погодити');
  db.prepare("UPDATE purchases SET status = 'delivered', delivered_at = ? WHERE id = ?").run(nowIso(), id);
}

export function listPurchases(limit = 30) {
  return db.prepare("SELECT * FROM purchases ORDER BY status IN ('pending', 'approved') DESC, id DESC LIMIT ?").all(limit);
}

export function purchasesAwaiting() {
  return db.prepare("SELECT * FROM purchases WHERE status IN ('pending', 'approved') ORDER BY id").all();
}
