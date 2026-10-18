import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { UPLOAD_DIR, getSetting, setSetting, PUBLIC_SETTINGS, db, transaction } from './db.js';
import {
  hasUsers, createUsers, listUsers, login, isValidPin,
  setSessionCookie, clearSessionCookie, currentUser, requireUser, requireRole,
} from './auth.js';
import {
  TaskError, todayInfo, listDay, listForReview, listRecent,
  createTask, regenerateTask, submitTask, reviewTask, tick as tickTasks,
} from './tasks.js';
import { addEntry, balance, toUah, history } from './ledger.js';
import { aiEnabled, aiProvider } from './ai.js';
import { addGrade, reviewGrade, listGrades, gradesForReview, recentSubjects, tickGrades } from './grades.js';
import {
  createComplaint, proposeResolution, answerResolution, listComplaints, finesSummary,
  requestPause, answerPause, endPause, listPauses, awaitingConsent,
} from './family.js';
import { tickBonuses, streakInfo, upcomingHolidays, toothFairy } from './bonuses.js';
import { quote, setPercent, nextPayoutDay, tickPayouts, markPaid, markReceived, listPayouts, payoutsAwaiting } from './payouts.js';
import {
  listItems, addItem, updateItem, buy, cancelPurchase, decide, markDelivered, listPurchases, purchasesAwaiting, available,
} from './shop.js';
import {
  nextSunday, addTopic, discussTopic, listTopics, weekSummary, contractInfo, proposeRenewal, answerRenewal,
} from './meeting.js';

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.resolve('public')));

// Стан оновлюється перед кожним запитом до API, а також раз на хвилину:
// дедлайни, автозарахування, свята, серії, ідеальний місяць, виплата 6 числа
function tick() {
  transaction(() => {
    tickTasks();
    tickGrades();
    if (hasUsers()) {
      tickBonuses();
      tickPayouts();
    }
  });
}
app.use('/api', (req, res, next) => { tick(); next(); });
setInterval(tick, 60_000);

// ---------- Перший запуск і вхід ----------

app.get('/api/session', (req, res) => {
  res.json({ setupNeeded: !hasUsers(), user: currentUser(req), users: listUsers() });
});

app.post('/api/setup', (req, res) => {
  if (hasUsers()) return res.status(400).json({ error: 'Сім\'я вже налаштована' });
  const { son, parents } = req.body ?? {};
  for (const p of [son, parents]) {
    if (!p?.name?.trim()) return res.status(400).json({ error: 'Вкажи імена' });
    if (!isValidPin(p.pin)) return res.status(400).json({ error: 'PIN — від 4 до 8 цифр' });
  }
  const birth = son.birthDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth ?? '') || birth >= new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Вкажи дату народження сина' });
  }
  createUsers({ name: son.name.trim(), pin: son.pin }, { name: parents.name.trim(), pin: parents.pin });
  setSetting('son_birth_date', birth);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { userId, pin } = req.body ?? {};
  const result = login(Number(userId), String(pin ?? ''));
  if (result.error) return res.status(401).json({ error: result.error });
  setSessionCookie(res, result.user.id);
  res.json({ user: result.user });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- Завдання ----------

app.get('/api/today', requireUser, (req, res) => {
  const info = todayInfo();
  res.json({
    ...info, tasks: listDay(), streak: streakInfo(),
    contract: contractInfo(), meetingToday: nextSunday() === info.day,
  });
});

app.post('/api/tasks', requireUser, requireRole('son'), async (req, res) => {
  res.json(await createTask(req.body?.difficulty));
});

app.post('/api/tasks/:id/regenerate', requireUser, requireRole('son'), async (req, res) => {
  res.json(await regenerateTask(Number(req.params.id)));
});

app.post('/api/tasks/:id/submit', requireUser, requireRole('son'), (req, res) => {
  res.json(submitTask(Number(req.params.id), { note: req.body?.note, image: req.body?.image }));
});

// Усе, що чекає дії саме цього користувача (для вкладки «Перевірка» та лічильника в меню)
app.get('/api/pending', requireUser, (req, res) => {
  const role = req.user.role;
  const tasks = listForReview();
  const grades = gradesForReview();
  const consent = awaitingConsent(role);
  const payouts = payoutsAwaiting(role);
  const purchases = role === 'parents' ? purchasesAwaiting() : [];
  const contract = contractInfo();
  const renewal = contract.renewProposedBy && contract.renewProposedBy !== role ? contract : null;
  const mine = consent.complaints.length + consent.pauses.length + payouts.length + purchases.length + (renewal ? 1 : 0);
  res.json({
    tasks, grades, consent, payouts, purchases, renewal,
    count: role === 'parents' ? tasks.length + grades.length + mine : mine,
  });
});

app.post('/api/tasks/:id/review', requireUser, requireRole('parents'), (req, res) => {
  const { approved, note } = req.body ?? {};
  res.json(reviewTask(Number(req.params.id), { approved: Boolean(approved), note, reviewerId: req.user.id }));
});

app.get('/api/tasks/history', requireUser, (req, res) => {
  res.json(listRecent());
});

app.get('/api/proof/:file', requireUser, (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(UPLOAD_DIR, file);
  if (!existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

// ---------- Бліски ----------

app.get('/api/balance', requireUser, (req, res) => {
  const total = balance();
  res.json({
    blisks: total,
    uah: toUah(total),
    rate: { blisks: Number(getSetting('rate_blisks')), uah: Number(getSetting('rate_uah')) },
    history: history(),
  });
});

// П. 7.2: виправлення лише зустрічним записом із поясненням
app.post('/api/ledger', requireUser, requireRole('parents'), (req, res) => {
  const amount = Number(req.body?.amount);
  const note = req.body?.note?.trim();
  if (!Number.isInteger(amount) || amount === 0) return res.status(400).json({ error: 'Сума — ціле число, не 0' });
  if (!note) return res.status(400).json({ error: 'Поясни, за що цей запис' });
  addEntry({ amount, kind: 'manual', note, createdBy: req.user.id });
  res.json({ ok: true });
});

// ---------- Оцінки (п. 4) ----------

app.get('/api/grades', requireUser, (req, res) => {
  res.json({ grades: listGrades(), subjects: recentSubjects() });
});

app.post('/api/grades', requireUser, requireRole('son'), (req, res) => {
  res.json(addGrade(req.body ?? {}));
});

app.post('/api/grades/:id/review', requireUser, requireRole('parents'), (req, res) => {
  const { approved, note } = req.body ?? {};
  res.json(reviewGrade(Number(req.params.id), { approved: Boolean(approved), note, reviewerId: req.user.id }));
});

// ---------- Скарги та штрафи (п. 3, 5) ----------

app.get('/api/complaints', requireUser, (req, res) => {
  res.json({ complaints: listComplaints(), fines: finesSummary() });
});

app.post('/api/complaints', requireUser, (req, res) => {
  res.json(createComplaint(req.user.role, req.body?.text));
});

app.post('/api/complaints/:id/propose', requireUser, (req, res) => {
  res.json(proposeResolution(Number(req.params.id), req.user.role, req.body?.proposal));
});

app.post('/api/complaints/:id/answer', requireUser, (req, res) => {
  res.json(answerResolution(Number(req.params.id), req.user.role, Boolean(req.body?.agree)));
});

// ---------- Пауза (п. 9) ----------

app.get('/api/pauses', requireUser, (req, res) => {
  res.json(listPauses());
});

app.post('/api/pauses', requireUser, (req, res) => {
  res.json(requestPause(req.user.role, req.body ?? {}));
});

app.post('/api/pauses/:id/answer', requireUser, (req, res) => {
  res.json(answerPause(Number(req.params.id), req.user.role, Boolean(req.body?.agree)));
});

app.post('/api/pauses/:id/end', requireUser, (req, res) => {
  res.json(endPause(Number(req.params.id), req.user.role));
});

// ---------- Свята (п. 2.2) ----------

app.get('/api/holidays', requireUser, (req, res) => {
  res.json(upcomingHolidays());
});

app.post('/api/tooth-fairy', requireUser, requireRole('parents'), (req, res) => {
  toothFairy(req.user.id);
  res.json({ ok: true });
});

// ---------- Виплата (п. 1.2, 2.3) ----------

app.get('/api/payouts', requireUser, (req, res) => {
  res.json({ quote: quote(), next: nextPayoutDay(), list: listPayouts() });
});

app.put('/api/payout-percent', requireUser, requireRole('son'), (req, res) => {
  setPercent(req.body?.percent);
  res.json(quote());
});

app.post('/api/payouts/:id/paid', requireUser, requireRole('parents'), (req, res) => {
  markPaid(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/payouts/:id/received', requireUser, requireRole('son'), (req, res) => {
  markReceived(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Магазин (п. 6) ----------

app.get('/api/shop', requireUser, (req, res) => {
  res.json({
    items: listItems({ includeHidden: req.user.role === 'parents' }),
    purchases: listPurchases(),
    available: available(),
  });
});

app.post('/api/shop/items', requireUser, requireRole('parents'), (req, res) => {
  res.json(addItem(req.body ?? {}));
});

app.put('/api/shop/items/:id', requireUser, requireRole('parents'), (req, res) => {
  res.json(updateItem(Number(req.params.id), req.body ?? {}));
});

app.post('/api/shop/items/:id/buy', requireUser, requireRole('son'), (req, res) => {
  res.json(buy(Number(req.params.id)));
});

app.post('/api/purchases/:id/cancel', requireUser, requireRole('son'), (req, res) => {
  cancelPurchase(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/purchases/:id/decide', requireUser, requireRole('parents'), (req, res) => {
  const { approve, note } = req.body ?? {};
  res.json(decide(Number(req.params.id), { approve: Boolean(approve), note, reviewerId: req.user.id }));
});

app.post('/api/purchases/:id/delivered', requireUser, requireRole('parents'), (req, res) => {
  markDelivered(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Сімейні збори й договір (п. 7.3, 12) ----------

app.get('/api/meeting', requireUser, (req, res) => {
  res.json({
    date: nextSunday(),
    topics: listTopics(),
    summary: weekSummary(),
    complaints: listComplaints().filter(c => c.status === 'open'),
    purchases: purchasesAwaiting().filter(p => p.status === 'pending'),
    contract: contractInfo(),
  });
});

app.post('/api/topics', requireUser, (req, res) => {
  addTopic(req.user.role, req.body?.text);
  res.json({ ok: true });
});

app.post('/api/topics/:id/discuss', requireUser, (req, res) => {
  discussTopic(Number(req.params.id), req.body?.decision);
  res.json({ ok: true });
});

app.get('/api/contract', requireUser, (req, res) => {
  res.json(contractInfo());
});

app.post('/api/contract/renew', requireUser, (req, res) => {
  proposeRenewal(req.user.role);
  res.json(contractInfo());
});

app.post('/api/contract/answer', requireUser, (req, res) => {
  res.json(answerRenewal(req.user.role, Boolean(req.body?.agree)));
});

// ---------- Налаштування (змінюються на сімейних зборах) ----------

app.get('/api/settings', requireUser, (req, res) => {
  res.json(Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, getSetting(k)])));
});

app.put('/api/settings', requireUser, requireRole('parents'), (req, res) => {
  const changes = req.body ?? {};
  for (const [key, value] of Object.entries(changes)) {
    if (!PUBLIC_SETTINGS.includes(key)) return res.status(400).json({ error: `Невідоме налаштування: ${key}` });
    if (key === 'payout_percent') return res.status(400).json({ error: 'Відсоток виплати обирає син' });
    if (key === 'son_birth_date' || key === 'contract_end') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return res.status(400).json({ error: 'Дата у форматі РРРР-ММ-ДД' });
    } else if (!Number.isInteger(Number(value)) || Number(value) < 0) {
      return res.status(400).json({ error: `${key}: потрібне невід'ємне ціле число` });
    }
  }
  if ('rate_blisks' in changes && Number(changes.rate_blisks) === 0) {
    return res.status(400).json({ error: 'Курс не може бути 0 блісків' });
  }
  for (const [key, value] of Object.entries(changes)) setSetting(key, value);
  res.json({ ok: true });
});

// ---------- Помилки ----------

app.use((err, req, res, next) => {
  if (err instanceof TaskError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Щось пішло не так. Спробуй ще раз.' });
});

// Tailscale видає адреси з діапазону 100.64.0.0/10
const isTailscale = ip => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`ЗДТ працює: http://localhost:${PORT}`);
  let tailscale = false;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|Loopback/i.test(name)) continue; // віртуальні мережі Windows
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (isTailscale(a.address)) {
        tailscale = true;
        console.log(`  звідусіль через Tailscale: http://${os.hostname().toLowerCase()}:${PORT}  (або http://${a.address}:${PORT})`);
      } else {
        console.log(`  з телефону в домашній Wi-Fi: http://${a.address}:${PORT}`);
      }
    }
  }
  if (!tailscale) console.log('  Tailscale не підключено — поза домом додаток недоступний.');
  console.log(aiEnabled
    ? `Завдання генерує ШІ (${aiProvider === 'gemini' ? 'Google Gemini' : 'Claude'}).`
    : 'Ключа ШІ немає — завдання беруться з вбудованого банку.');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`ЗДТ уже працює (порт ${PORT} зайнятий) — мабуть, його запустив автозапуск. Це вікно можна закрити.`);
    process.exit(0);
  }
  throw err;
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
