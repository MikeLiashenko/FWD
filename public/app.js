import { icon, coin } from './icons.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const DIFF = {
  easy: { name: 'Легке', icon: 'sprout', time: '10–15 хв' },
  medium: { name: 'Середнє', icon: 'flame', time: '20–40 хв' },
  hard: { name: 'Складне', icon: 'rocket', time: '45–90 хв' },
};

const STATUS = {
  active: ['Треба виконати', '', 'clock'],
  submitted: ['На перевірці', 'wait', 'hourglass'],
  approved: ['Зараховано', 'ok', 'check'],
  rejected: ['Відхилено', 'bad', 'x'],
  expired: ['Час минув', 'bad', 'clock'],
};

let session = null;

// ---------- Допоміжне ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    session.user = null;
    render();
    throw new Error(data.error || 'Потрібно увійти');
  }
  if (!res.ok) throw new Error(data.error || 'Помилка');
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  toastEl.innerHTML = `${icon(isError ? 'x' : 'check')}<span>${esc(msg)}</span>`;
  toastEl.className = isError ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

// Обгортка для кнопок: блокує кнопку, поки йде запит, і показує помилку
async function act(button, fn, busyText) {
  const old = button.innerHTML;
  button.disabled = true;
  if (busyText) button.textContent = busyText;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
    button.innerHTML = old;
  }
}

const fmtDate = iso => new Date(iso).toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = day => new Date(`${day}T12:00:00`).toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' });
const isSon = () => session.user?.role === 'son';
const show = html => { app.innerHTML = `<div class="view">${html}</div>`; };

function avatar(user) {
  return user.role === 'son'
    ? `<div class="avatar son">${esc(user.name.trim()[0] ?? '?')}</div>`
    : `<div class="avatar parents">${icon('users')}</div>`;
}

// Скільки лишилось до дедлайну 23:00 за київським часом
function timeLeft() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const mins = 23 * 60 - (Number(p.hour) * 60 + Number(p.minute));
  if (mins <= 0) return null;
  return mins >= 60 ? `${Math.floor(mins / 60)} год ${mins % 60} хв` : `${mins} хв`;
}

// Стискаємо фото на телефоні, щоб не надсилати 10-мегабайтні знімки
function resizeImage(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * k);
      canvas.height = Math.round(img.height * k);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('Не вдалося відкрити фото'));
    img.src = URL.createObjectURL(file);
  });
}

function empty(ico, title, text) {
  return `<div class="card empty"><div class="big-ico">${icon(ico)}</div><b>${title}</b>${text}</div>`;
}

// ---------- Навігація ----------

// tab — яка вкладка меню підсвічується
const ROUTES = {
  today: { title: 'Сьогодні', icon: 'sun', view: viewToday },
  grades: { title: 'Оцінки', icon: 'book', view: viewGrades },
  review: { title: 'Перевірка', icon: 'clipboard', view: viewReview },
  balance: { title: 'Бліски', icon: 'sparkle', view: viewBalance },
  more: { title: 'Ще', icon: 'grid', view: viewMore },
  complaints: { tab: 'more', view: viewComplaints },
  pause: { tab: 'more', view: viewPause },
  holidays: { tab: 'more', view: viewHolidays },
  shop: { tab: 'more', view: viewShop },
  meeting: { tab: 'more', view: viewMeeting },
  settings: { tab: 'more', view: viewSettings },
};

function currentRoute() {
  const r = location.hash.slice(2);
  return ROUTES[r] ? r : 'today';
}

async function renderNav() {
  const route = currentRoute();
  const tab = ROUTES[route].tab ?? route;
  let pending = 0;
  try { pending = (await api('/pending')).count; } catch { /* не критично */ }
  nav.innerHTML = Object.entries(ROUTES).filter(([, r]) => r.title).map(([key, r]) => `
    <a href="#/${key}" class="${key === tab ? 'active' : ''}" aria-label="${r.title}">
      ${icon(r.icon)}<span>${r.title}</span>
      ${key === 'review' && pending ? `<span class="dot">${pending}</span>` : ''}
    </a>`).join('');
  nav.hidden = false;
}

const backLink = `<a class="back" href="#/more">${icon('back')}Ще</a>`;

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const fmtShortDay = day => new Date(`${day}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
const sideName = role => (role === 'son' ? session.users.find(u => u.role === 'son')?.name ?? 'Син' : 'Батьки');
const miniAvatar = role => avatar({ role, name: sideName(role) });

async function render() {
  if (!session) session = await api('/session');
  if (session.setupNeeded) return viewSetup();
  if (!session.user) { nav.hidden = true; return viewLogin(); }
  renderNav();
  try {
    await ROUTES[currentRoute()].view();
    window.scrollTo(0, 0);
  } catch (err) {
    show(empty('x', 'Не вдалося завантажити', `<p>${esc(err.message)}</p>`));
  }
}

window.addEventListener('hashchange', render);

// ---------- Перший запуск ----------

function viewSetup() {
  nav.hidden = true;
  show(`
    <div class="brand" style="margin-top:24px">
      <div class="brand-logo">${coin(44)}</div>
      <h1>Вітаємо в ЗДТ</h1>
      <p>Перший запуск. Задайте імена й PIN-коди (4–8 цифр).</p>
    </div>
    <form id="setup">
      <div class="card">
        <div class="group-title"><div class="avatar son" style="width:34px;height:34px;font-size:14px">С</div>Син</div>
        <div class="field"><label>Ім'я</label><input name="sonName" placeholder="Ім'я сина" required></div>
        <div class="field"><label>Дата народження</label><input name="sonBirth" type="date" max="${kyivToday()}" required></div>
        <div class="field"><label>PIN</label><input name="sonPin" type="password" inputmode="numeric" pattern="\\d{4,8}" required></div>
      </div>
      <div class="card">
        <div class="group-title"><div class="avatar parents" style="width:34px;height:34px">${icon('users')}</div>Батьки — спільний акаунт</div>
        <div class="field"><label>Назва</label><input name="parentsName" value="Батьки" required></div>
        <div class="field"><label>PIN</label><input name="parentsPin" type="password" inputmode="numeric" pattern="\\d{4,8}" required></div>
      </div>
      <p class="muted small center">PIN знає лише той, чий це акаунт.</p>
      <button class="block">Почати ${icon('arrow')}</button>
    </form>`);
  const form = document.getElementById('setup');
  form.onsubmit = e => {
    e.preventDefault();
    const f = new FormData(form);
    act(form.querySelector('button'), async () => {
      await api('/setup', { body: {
        son: { name: f.get('sonName'), pin: f.get('sonPin'), birthDate: f.get('sonBirth') },
        parents: { name: f.get('parentsName'), pin: f.get('parentsPin') },
      } });
      session = null;
      toast('Готово! Тепер увійдіть');
      render();
    });
  };
}

// ---------- Вхід ----------

function viewLogin() {
  let selected = null;
  let pin = '';
  let busy = false;

  show(`
    <div class="login">
      <div class="brand">
        <div class="brand-logo">${coin(44)}</div>
        <h1>ЗДТ</h1>
        <p>Зацікавлення Днів Тижня</p>
      </div>
      <div class="who">
        ${session.users.map(u => `<button data-id="${u.id}">${avatar(u)}<span>${esc(u.name)}</span></button>`).join('')}
      </div>
      <div class="pin-area" hidden>
        <p class="center muted small" style="margin-bottom:10px">${icon('lock')} Введи PIN</p>
        <div class="pin-dots"></div>
        <div class="pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-key="${n}">${n}</button>`).join('')}
          <button class="del" data-key="del" aria-label="Стерти">${icon('backspace')}</button>
          <button data-key="0">0</button>
          <button class="go" data-key="go" aria-label="Увійти">${icon('arrow')}</button>
        </div>
      </div>
    </div>`);

  const area = app.querySelector('.pin-area');
  const dots = app.querySelector('.pin-dots');
  const drawDots = () => {
    const n = Math.max(4, pin.length);
    dots.innerHTML = Array.from({ length: n }, (_, i) => `<span class="${i < pin.length ? 'on' : ''}"></span>`).join('');
  };

  const submit = async () => {
    if (busy || pin.length < 4) return;
    busy = true;
    try {
      const { user } = await api('/login', { body: { userId: selected, pin } });
      session.user = user;
      document.removeEventListener('keydown', onKey);
      location.hash = '#/today';
      render();
    } catch (err) {
      pin = '';
      drawDots();
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
      toast(err.message, true);
    } finally {
      busy = false;
    }
  };

  const press = key => {
    if (!selected) return;
    if (key === 'del') pin = pin.slice(0, -1);
    else if (key === 'go') return submit();
    else if (pin.length < 8) pin += key;
    drawDots();
  };

  const onKey = e => {
    if (!app.contains(dots)) return document.removeEventListener('keydown', onKey);
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter') press('go');
  };
  document.addEventListener('keydown', onKey);

  app.querySelectorAll('.who button').forEach(btn => {
    btn.onclick = () => {
      selected = Number(btn.dataset.id);
      pin = '';
      app.querySelectorAll('.who button').forEach(b => b.classList.toggle('selected', b === btn));
      area.hidden = false;
      drawDots();
    };
  });
  app.querySelectorAll('.pad button').forEach(btn => { btn.onclick = () => press(btn.dataset.key); });
}

// ---------- Картка завдання ----------

function taskCard(t, actions = '') {
  const [statusText, statusClass, statusIcon] = STATUS[t.status] ?? [t.status, '', 'clock'];
  const d = DIFF[t.difficulty];
  const done = ['approved', 'rejected', 'expired'].includes(t.status);
  return `
    <div class="card task ${t.difficulty} ${done ? 'done' : ''}" data-task="${t.id}">
      <div class="row spread">
        <span class="pill tone">${icon(d.icon)}${d.name}</span>
        <span class="pill gold">${coin(18)}+${t.reward}</span>
      </div>
      <div class="task-title">${esc(t.title)}</div>
      <p class="task-desc">${esc(t.description)}</p>
      <div class="task-meta">
        <span class="pill ${statusClass}">${icon(statusIcon)}${statusText}${t.auto_approved ? ' · авто' : ''}</span>
      </div>
      ${t.proof_note ? `<div class="quote">${icon('message')}<div><b>Звіт</b>${esc(t.proof_note)}</div></div>` : ''}
      ${t.proof_image ? `<img class="proof-img" src="/api/proof/${encodeURIComponent(t.proof_image)}" alt="Фото-доказ">` : ''}
      ${t.review_note ? `<div class="quote">${icon('users')}<div><b>Батьки</b>${esc(t.review_note)}</div></div>` : ''}
      ${actions}
    </div>`;
}

// ---------- Сьогодні ----------

async function viewToday() {
  const [data, bal] = await Promise.all([api('/today'), api('/balance')]);
  const son = isSon();
  const left = timeLeft();
  const doneCount = data.tasks.filter(t => ['submitted', 'approved'].includes(t.status)).length;
  const planned = data.tasks.length + data.tasksLeft;
  const progress = planned ? Math.round(doneCount / planned * 100) : 0;
  const canAdd = son && !data.pastDeadline && !data.paused && data.tasksLeft > 0;

  const cards = data.tasks.map(t => {
    if (!son || t.status !== 'active' || data.pastDeadline) return taskCard(t);
    return taskCard(t, `
      <div class="task-actions">
        <div class="btn-row">
          <button class="ok" data-act="done">${icon('check')}Виконано</button>
          <button class="soft icon-btn" data-act="regen" ${data.regensLeft ? '' : 'disabled'} aria-label="Інше завдання" title="Інше завдання">
            ${icon('refresh')}<span class="regen-count">${data.regensLeft}</span>
          </button>
        </div>
        <form class="sheet" data-form="submit" hidden>
          <div class="field"><label>Що ти зробив?</label><textarea name="note" placeholder="Необов'язково, але батькам буде приємно"></textarea></div>
          <div class="field">
            <label>Фото-доказ ${t.difficulty === 'hard' ? '· бажано, якщо батьки не бачили' : "· необов'язково"}</label>
            <label class="drop">${icon('camera')}<span>Додати фото</span><input name="photo" type="file" accept="image/*"></label>
          </div>
          <button class="ok block" style="margin-top:14px">Надіслати на перевірку ${icon('arrow')}</button>
        </form>
      </div>`);
  }).join('');

  show(`
    <div class="hero">
      <div class="hero-top">
        <span class="hero-date">${esc(fmtDay(data.day))}</span>
        <span class="hero-chip">${icon('clock')}${left && !data.pastDeadline ? left : 'день закрито'}</span>
      </div>
      <div class="hero-balance">${coin(38)}<span class="num">${bal.blisks}</span></div>
      <div class="hero-sub">≈ ${bal.uah} грн на балансі</div>
      ${data.paused ? '' : `
      <div class="hero-progress">
        <div class="row spread"><span>Сьогодні виконано</span><span>${doneCount} з ${planned}</span></div>
        <div class="bar"><div style="width:${progress}%"></div></div>
      </div>`}
      <div class="hero-foot">
        <span class="hero-chip">${icon('flame')}Серія ${data.streak.days} · бонус через ${data.streak.untilBonus} ${plural(data.streak.untilBonus, 'день', 'дні', 'днів')}</span>
      </div>
    </div>
    ${data.paused ? `<a class="note" href="#/pause" style="text-decoration:none">${icon('pause')}<span><b style="color:var(--text)">Зараз пауза.</b> Нові завдання не потрібні, серія не зламається.</span></a>` : ''}
    ${data.meetingToday ? `<a class="note" href="#/meeting" style="text-decoration:none">${icon('users')}<span><b style="color:var(--text)">Сьогодні сімейні збори.</b> Подивіться, що обговорити.</span></a>` : ''}
    ${data.contract.dueSoon ? `<a class="note" href="#/meeting" style="text-decoration:none">${icon('file')}<span><b style="color:var(--text)">${data.contract.expired ? 'Термін договору закінчився.' : `Договір діє ще ${data.contract.daysLeft} ${plural(data.contract.daysLeft, 'день', 'дні', 'днів')}.`}</b> Час обговорити продовження (п. 12.1).</span></a>` : ''}
    ${!data.aiEnabled ? `<div class="note">${icon('sparkle')}<span>ШІ ще не підключено — завдання беруться з вбудованого банку.</span></div>` : ''}
    <h2>Завдання на сьогодні</h2>
    ${cards || (son
      ? empty('sun', 'Новий день — нові пригоди', '<p>Обери складність нижче й отримай завдання.</p>')
      : empty('sun', 'Поки порожньо', '<p>Син ще не взяв завдань на сьогодні.</p>'))}
    ${canAdd ? `
      <h2>Нове завдання <span class="count">ще ${data.tasksLeft}</span></h2>
      <div class="diff-grid">
        ${Object.entries(DIFF).map(([k, d]) => `
          <button class="diff ${k}" data-new="${k}">
            <span class="bubble">${icon(d.icon)}</span>
            <span class="name">${d.name}</span>
            <span class="time">${d.time}</span>
            <span class="reward">${coin(16)}<span data-reward></span></span>
          </button>`).join('')}
      </div>
      <p class="muted small center">Чим складніше — тим більше блісків.</p>` : ''}`);

  if (canAdd) {
    const settings = await api('/settings');
    app.querySelectorAll('[data-new]').forEach(btn => {
      btn.querySelector('[data-reward]').textContent = `+${settings[`reward_${btn.dataset.new}`]}`;
      btn.onclick = () => act(btn, async () => {
        app.querySelectorAll('[data-new]').forEach(b => { b.disabled = true; });
        await api('/tasks', { body: { difficulty: btn.dataset.new } });
        toast('Нове завдання готове!');
        render();
      }, 'Думаю…');
    });
  }

  app.querySelectorAll('[data-task]').forEach(card => {
    const id = card.dataset.task;
    const form = card.querySelector('[data-form="submit"]');
    card.querySelector('[data-act="done"]')?.addEventListener('click', () => { form.hidden = !form.hidden; });
    const regen = card.querySelector('[data-act="regen"]');
    regen?.addEventListener('click', () => act(regen, async () => {
      await api(`/tasks/${id}/regenerate`, { body: {} });
      toast('Ось інше завдання');
      render();
    }));
    if (!form) return;
    const drop = form.querySelector('.drop');
    form.photo.addEventListener('change', () => {
      const file = form.photo.files[0];
      drop.querySelector('img')?.remove();
      drop.querySelector('span').textContent = file ? 'Інше фото' : 'Додати фото';
      if (file) drop.insertAdjacentHTML('afterbegin', `<img src="${URL.createObjectURL(file)}" alt="">`);
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      act(form.querySelector('button'), async () => {
        const file = form.photo.files[0];
        const image = file ? await resizeImage(file) : null;
        await api(`/tasks/${id}/submit`, { body: { note: form.note.value, image } });
        toast('Надіслано батькам на перевірку');
        render();
      }, 'Надсилаю…');
    });
  });
}
// ---------- Оцінки ----------

const KIND = {
  class: 'Класна',
  home: 'Домашня',
  independent: 'Самостійна',
  test: 'Контрольна',
  topic: 'Тематична',
};

const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

function gradeStatus(g) {
  const [text, cls, ico] = STATUS[g.status] ?? [g.status, '', 'clock'];
  return `<span class="pill ${cls}">${icon(ico)}${text}${g.auto_approved ? ' · авто' : ''}</span>`;
}

function gradeCard(g, settings, actions = '') {
  return `
    <div class="card" data-grade="${g.id}">
      <div class="grade-row" style="padding:0;border:0">
        <div class="grade-num ${g.grade === 12 ? 'g12' : ''}">${g.grade}</div>
        <div class="grade-info"><b>${esc(g.subject)}</b><span class="muted small">${KIND[g.kind]} ×${settings[`mult_${g.kind}`]} · ${fmtShortDay(g.day)}</span></div>
        <span class="pill gold">${coin(18)}+${g.reward}</span>
      </div>
      ${g.status !== 'submitted' ? `<div class="task-meta">${gradeStatus(g)}</div>` : ''}
      ${g.review_note ? `<div class="quote">${icon('users')}<div><b>Батьки</b>${esc(g.review_note)}</div></div>` : ''}
      ${actions}
    </div>`;
}

async function viewGrades() {
  const [data, settings] = await Promise.all([api('/grades'), api('/settings')]);
  const son = isSon();
  const values = [12, 11, 10, 9].map(n => `${n} → ${settings[`grade_${n}`]}`).join(' · ');
  const mults = Object.entries(KIND).map(([k, name]) => `${name.toLowerCase()} ×${settings[`mult_${k}`]}`).join(', ');

  show(`
    <h1>Оцінки</h1>
    <p class="lead">Бліски за 9–12 (п. 4): база за оцінку × вид роботи.</p>
    ${son ? `
      <form id="grade" class="card">
        <div class="group-title">${icon('book')}Нова оцінка</div>
        <div class="field"><label>Предмет</label><input name="subject" placeholder="Напр. Математика" maxlength="60" required></div>
        ${data.subjects.length ? `<div class="chips" style="margin-top:10px">${data.subjects.map(s => `<button type="button" class="chip" data-subject="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
        <div class="field" style="margin-top:16px"><label>Оцінка</label>
          <div class="grade-pick">${[9, 10, 11, 12].map(n => `<button type="button" data-g="${n}" class="${n === 12 ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="field"><label>Вид роботи</label>
          <div class="chips">${Object.entries(KIND).map(([k, name], i) => `<button type="button" class="chip ${i === 0 ? 'on' : ''}" data-kind="${k}">${name} <small>×${settings[`mult_${k}`]}</small></button>`).join('')}</div></div>
        <div class="field"><label>Коли</label><input name="day" type="date" value="${kyivToday()}" max="${kyivToday()}" required></div>
        <div class="preview"><span>Батьки підтвердять — і ти отримаєш</span><span class="amt">${coin(24)}<span id="gp"></span></span></div>
        <button class="block">Надіслати батькам ${icon('arrow')}</button>
      </form>` : `<div class="note">${icon('sparkle')}<span>${values}. Множники: ${mults}. Нові оцінки з’являються у «Перевірці».</span></div>`}
    <h2>${son ? 'Мої оцінки' : `Оцінки: ${esc(sideName('son'))}`} <span class="count">${data.grades.length}</span></h2>
    ${data.grades.length ? `<div class="card">${data.grades.map(g => `
      <div class="grade-row">
        <div class="grade-num ${g.grade === 12 ? 'g12' : ''}">${g.grade}</div>
        <div class="grade-info"><b>${esc(g.subject)}</b><span class="muted small">${KIND[g.kind]} · ${fmtShortDay(g.day)}</span></div>
        <div style="text-align:right">
          <div class="amount ${g.status === 'rejected' ? 'minus' : 'plus'}" style="${g.status === 'submitted' ? 'color:var(--wait)' : ''}">${g.status === 'rejected' ? '0' : `+${g.reward}`}</div>
          <div class="muted small">${STATUS[g.status][0]}</div>
        </div>
      </div>`).join('')}</div>` : empty('book', 'Ще немає оцінок', son ? '<p>Отримав 9–12? Додай оцінку вище.</p>' : '<p>Син ще не додав оцінок.</p>')}`);

  const form = document.getElementById('grade');
  if (!form) return;
  let grade = 12;
  let kind = 'class';
  const update = () => { document.getElementById('gp').textContent = `+${settings[`grade_${grade}`] * settings[`mult_${kind}`]}`; };
  update();
  form.querySelectorAll('[data-g]').forEach(b => {
    b.onclick = () => { grade = Number(b.dataset.g); form.querySelectorAll('[data-g]').forEach(x => x.classList.toggle('on', x === b)); update(); };
  });
  form.querySelectorAll('[data-kind]').forEach(b => {
    b.onclick = () => { kind = b.dataset.kind; form.querySelectorAll('[data-kind]').forEach(x => x.classList.toggle('on', x === b)); update(); };
  });
  form.querySelectorAll('[data-subject]').forEach(b => {
    b.onclick = () => { form.subject.value = b.dataset.subject; form.querySelectorAll('[data-subject]').forEach(x => x.classList.toggle('on', x === b)); };
  });
  form.onsubmit = e => {
    e.preventDefault();
    act(form.querySelector('button.block'), async () => {
      await api('/grades', { body: { subject: form.subject.value, grade, kind, day: form.day.value } });
      toast('Оцінку надіслано батькам');
      render();
    });
  };
}

// ---------- Перевірка ----------

const answerButtons = `
  <div class="btn-row even" style="margin-top:14px">
    <button class="ok" data-agree="1">${icon('check')}Погоджуюсь</button>
    <button class="bad" data-agree="0">${icon('x')}Ні</button>
  </div>`;

const pauseDates = p => (p.start_day === p.end_day
  ? fmtShortDay(p.start_day)
  : `${fmtShortDay(p.start_day)} — ${fmtShortDay(p.end_day)}`);

function complaintTarget(c) {
  return c.against === 'son' ? 'сина' : 'батьків';
}

async function viewReview() {
  const [p, settings] = await Promise.all([api('/pending'), api('/settings')]);
  const son = isSon();

  const consent = [
    ...p.consent.complaints.map(c => `
      <div class="card consent" data-complaint="${c.id}">
        <div class="who-line">${miniAvatar(c.proposed_by)}${esc(sideName(c.proposed_by))} пропонує</div>
        <div class="big-text">${c.proposal === 'fine' ? `Штраф для ${complaintTarget(c)}` : 'Відхилити скаргу'}</div>
        <p class="muted">Скарга на ${complaintTarget(c)}: «${esc(c.text)}»</p>
        ${answerButtons}
      </div>`),
    ...p.consent.pauses.map(x => `
      <div class="card consent" data-pause="${x.id}">
        <div class="who-line">${miniAvatar(x.requested_by)}${esc(sideName(x.requested_by))} просить паузу</div>
        <div class="big-text">${pauseDates(x)}</div>
        <p class="muted">${esc(x.reason)}</p>
        ${answerButtons}
      </div>`),
    ...p.payouts.map(x => `
      <div class="card consent" data-payout="${x.id}">
        <div class="who-line">${icon('wallet')}Виплата ${PAYOUT_DAY_TEXT}</div>
        <div class="big-text">${son ? `Батьки виплатили ${x.uah} грн` : `Виплатіть ${x.uah} грн`}</div>
        <p class="muted">${x.percent}% балансу, списано ${x.blisks} блісків.</p>
        <button class="ok block" style="margin-top:12px" data-pay="${son ? 'received' : 'paid'}">${icon('check')}${son ? 'Я отримав гроші' : 'Ми виплатили'}</button>
      </div>`),
    ...(p.renewal ? [`
      <div class="card consent" data-renewal>
        <div class="who-line">${miniAvatar(p.renewal.renewProposedBy)}${esc(sideName(p.renewal.renewProposedBy))} пропонує</div>
        <div class="big-text">Продовжити договір ще на 3 місяці</div>
        <p class="muted">Зараз діє до ${fmtShortDay(p.renewal.end)} (п. 12.1).</p>
        ${answerButtons}
      </div>`] : []),
    ...p.purchases.map(x => purchaseCard(x)),
  ];

  const taskCards = p.tasks.map(t => {
    const autoAt = new Date(new Date(t.submitted_at).getTime() + 24 * 3_600_000).toISOString();
    const info = `<p class="muted small" style="margin-top:12px">Надіслано ${fmtDate(t.submitted_at)} · авто ${fmtDate(autoAt)}</p>`;
    return son ? taskCard(t, info) : taskCard(t, `${info}${reviewActions}`);
  });
  const gradeCards = p.grades.map(g => gradeCard(g, settings, son
    ? `<p class="muted small" style="margin-top:12px">Чекає батьків · надіслано ${fmtDate(g.submitted_at)}</p>`
    : reviewActions));

  const nothing = !consent.length && !taskCards.length && !gradeCards.length;
  show(`
    <h1>Перевірка</h1>
    <p class="lead">${son ? 'Що чекає на тебе і що чекає на батьків.' : 'Усе, що чекає вашого рішення.'}</p>
    ${consent.length ? `<h2>${son ? 'Чекає твоєї відповіді' : 'Чекає вашої відповіді'}</h2>${consent.join('')}` : ''}
    ${taskCards.length ? `<h2>Завдання <span class="count">${taskCards.length}</span></h2>
      <div class="note">${icon('hourglass')}<span>Батьки мають 24 години. Потім завдання й оцінки зараховуються автоматично (п. 8.2).</span></div>
      ${taskCards.join('')}` : ''}
    ${gradeCards.length ? `<h2>Оцінки <span class="count">${gradeCards.length}</span></h2>${gradeCards.join('')}` : ''}
    ${nothing ? empty('check', 'Все перевірено', '<p>Нічого не чекає на перевірку.</p>') : ''}`);

  const bindReview = (selector, path) => app.querySelectorAll(selector).forEach(card => {
    card.querySelectorAll('[data-review]').forEach(btn => {
      btn.onclick = () => act(btn, async () => {
        await api(path(card), { body: { approved: btn.dataset.review === '1', note: card.querySelector('textarea').value } });
        toast(btn.dataset.review === '1' ? 'Зараховано!' : 'Відхилено');
        render();
      });
    });
  });
  bindReview('[data-task]', c => `/tasks/${c.dataset.task}/review`);
  bindReview('[data-grade]', c => `/grades/${c.dataset.grade}/review`);

  const bindAnswer = (selector, path) => app.querySelectorAll(selector).forEach(card => {
    card.querySelectorAll('[data-agree]').forEach(btn => {
      btn.onclick = () => act(btn, async () => {
        await api(path(card), { body: { agree: btn.dataset.agree === '1' } });
        toast(btn.dataset.agree === '1' ? 'Погоджено' : 'Відповідь надіслано');
        render();
      });
    });
  });
  bindAnswer('[data-complaint]', c => `/complaints/${c.dataset.complaint}/answer`);
  bindAnswer('[data-pause]', c => `/pauses/${c.dataset.pause}/answer`);
  bindAnswer('[data-renewal]', () => '/contract/answer');
  bindPurchases();

  app.querySelectorAll('[data-payout]').forEach(card => {
    const btn = card.querySelector('[data-pay]');
    btn.onclick = () => act(btn, async () => {
      await api(`/payouts/${card.dataset.payout}/${btn.dataset.pay}`, { body: {} });
      toast('Позначено');
      render();
    });
  });
}

const PAYOUT_DAY_TEXT = '6 числа';

// ---------- Покупки (спільне для Перевірки, Магазину і Зборів) ----------

function purchaseCard(x) {
  const son = isSon();
  let footer;
  if (x.status === 'pending' && !son) footer = `
    <textarea name="note" placeholder="Коментар (обов'язковий, якщо відмовляєте)" style="margin-top:12px"></textarea>
    <div class="btn-row even" style="margin-top:10px">
      <button class="ok" data-decide="1">${icon('check')}Погодити</button>
      <button class="bad" data-decide="0">${icon('x')}Відмовити</button>
    </div>`;
  else if (x.status === 'pending') footer = `
    <div class="row spread" style="margin-top:12px">
      <span class="pill wait">${icon('hourglass')}Чекає зборів у неділю</span>
      <button class="plain" data-cancel style="min-height:0;padding:6px 4px">Скасувати</button>
    </div>`;
  else if (x.status === 'approved' && !son) footer = `
    <span class="pill ok" style="margin-top:12px">${icon('check')}Погоджено, бліски списано</span>
    <button class="ok block" data-delivered style="margin-top:12px">${icon('gift')}Подарунок вручено</button>`;
  else if (x.status === 'approved') footer = `<span class="pill ok" style="margin-top:12px">${icon('check')}Погоджено — чекай подарунок</span>`;
  else if (x.status === 'delivered') footer = `<span class="pill ok" style="margin-top:12px">${icon('gift')}Вручено</span>`;
  else footer = `<span class="pill bad" style="margin-top:12px">${icon('x')}Відмовлено</span>`;
  return `
    <div class="card ${x.status === 'pending' && !son ? 'consent' : ''}" data-purchase="${x.id}">
      <div class="who-line">${icon('bag')}Покупка · ${fmtDate(x.created_at)}</div>
      <div class="row spread" style="margin-top:8px;align-items:flex-start">
        <div class="big-text" style="margin:0">${esc(x.name)}</div>
        <span class="pill gold">${coin(18)}${x.price}</span>
      </div>
      ${x.note ? `<div class="quote">${icon('message')}<div><b>Коментар</b>${esc(x.note)}</div></div>` : ''}
      <div>${footer}</div>
    </div>`;
}

function bindPurchases() {
  app.querySelectorAll('[data-purchase]').forEach(card => {
    const id = card.dataset.purchase;
    card.querySelectorAll('[data-decide]').forEach(btn => {
      btn.onclick = () => act(btn, async () => {
        await api(`/purchases/${id}/decide`, { body: { approve: btn.dataset.decide === '1', note: card.querySelector('textarea').value } });
        toast(btn.dataset.decide === '1' ? 'Покупку погоджено' : 'Відмовлено');
        render();
      });
    });
    const cancel = card.querySelector('[data-cancel]');
    if (cancel) cancel.onclick = () => act(cancel, async () => {
      await api(`/purchases/${id}/cancel`, { body: {} });
      toast('Покупку скасовано');
      render();
    });
    const delivered = card.querySelector('[data-delivered]');
    if (delivered) delivered.onclick = () => act(delivered, async () => {
      await api(`/purchases/${id}/delivered`, { body: {} });
      toast('Чудово!');
      render();
    });
  });
}

const reviewActions = `
  <div class="task-actions">
    <textarea name="note" placeholder="Коментар (обов'язковий, якщо відхиляєте)"></textarea>
    <div class="btn-row even" style="margin-top:10px">
      <button class="ok" data-review="1">${icon('check')}Підтвердити</button>
      <button class="bad" data-review="0">${icon('x')}Відхилити</button>
    </div>
  </div>`;

// ---------- Бліски ----------

// Та сама формула, що й на сервері: гривні цілі, списуємо бліски лише за них
function payoutQuote(percent, total, rate) {
  const share = Math.floor(Math.max(0, total) * percent / 100);
  const uah = Math.floor(share * rate.uah / rate.blisks);
  const blisks = Math.ceil(uah * rate.blisks / rate.uah);
  return { uah, remaining: total - blisks };
}

const PAYOUT_STATUS = { owed: ['Чекає виплати', 'wait'], paid: ['Виплачено', ''], received: ['Отримано', 'ok'] };

async function viewBalance() {
  const [bal, pay] = await Promise.all([api('/balance'), api('/payouts')]);
  const son = isSon();
  const q = payoutQuote(pay.quote.percent, bal.blisks, bal.rate);

  show(`
    <div class="hero">
      <div class="hero-top">
        <span>Баланс</span>
        <span class="hero-chip">${coin(14)}${bal.rate.blisks} = ${bal.rate.uah} грн</span>
      </div>
      <div class="hero-balance">${coin(38)}<span class="num">${bal.blisks}</span></div>
      <div class="hero-sub">≈ ${bal.uah} грн за поточним курсом</div>
    </div>
    <a class="note" href="#/shop" style="text-decoration:none">${icon('bag')}<span><b style="color:var(--text)">Магазин подарунків.</b> Обміняй бліски на подарунок від батьків (п. 6).</span></a>
    <div class="card">
      <div class="group-title">${icon('wallet')}Виплата ${fmtShortDay(pay.next)}</div>
      <div class="row spread"><span class="muted">${son ? 'Скільки виплатити' : `${esc(sideName('son'))} обрав`}</span><span class="percent-big" id="pct">${pay.quote.percent}%</span></div>
      ${son ? `<input type="range" id="range" min="0" max="100" step="5" value="${pay.quote.percent}" style="--fill:${pay.quote.percent}%" aria-label="Відсоток виплати">` : ''}
      <div class="stat-grid" style="margin-top:12px">
        <div class="stat"><b id="q-uah">${q.uah} грн</b><span>${son ? 'отримаєш' : 'треба буде виплатити'}</span></div>
        <div class="stat"><b id="q-rest">${q.remaining}</b><span>блісків залишиться</span></div>
      </div>
      <p class="muted small" style="margin-top:12px">${son ? 'Обери до 6 числа. Решта блісків залишиться на балансі й піде на наступний місяць (п. 2.3).' : 'Відсоток обирає син (п. 2.3). Сума порахується 6 числа за балансом того дня.'}</p>
      ${pay.list.length ? `<div style="margin-top:12px">${pay.list.map(x => `
        <div class="ledger-item">
          <div class="ledger-ico plus">${icon('wallet')}</div>
          <div class="ledger-text"><div>${x.uah} грн · ${x.percent}%</div><div class="muted small">${x.month}</div></div>
          <span class="pill ${PAYOUT_STATUS[x.status][1]}">${PAYOUT_STATUS[x.status][0]}</span>
        </div>`).join('')}</div>` : ''}
    </div>
    ${son ? '' : `
      <form id="entry" class="card">
        <div class="group-title">${icon('gift')}Новий запис</div>
        <div class="seg">
          <button type="button" class="on plus" data-sign="1">${icon('plus')}Нарахувати</button>
          <button type="button" class="minus" data-sign="-1">${icon('minus')}Зняти</button>
        </div>
        <div class="field" style="margin-top:14px"><label>Скільки</label>
          <div class="suffix"><input name="amount" type="number" min="1" step="1" inputmode="numeric" required><span>блісків</span></div></div>
        <div class="field"><label>За що</label><input name="note" placeholder="Напр. допоміг з ремонтом" required></div>
        <p class="muted small">Записи не можна змінити чи видалити (п. 7.2). Помилку виправляють зустрічним записом.</p>
        <button class="block">Додати запис</button>
      </form>`}
    <h2>Журнал <span class="count">${bal.history.length}</span></h2>
    ${bal.history.length ? `<div class="card">${bal.history.map(e => {
      const plus = e.amount > 0;
      const ico = { task: 'check', grade: 'book', holiday: 'cake', bonus: 'trophy', fine: 'flag', payout: 'wallet', purchase: 'bag' }[e.kind] ?? (plus ? 'gift' : 'minus');
      return `
        <div class="ledger-item">
          <div class="ledger-ico ${plus ? 'plus' : 'minus'}">${icon(ico)}</div>
          <div class="ledger-text">
            <div>${esc(e.note)}</div>
            <div class="muted small">${fmtDate(e.created_at)} · ${e.created_by_name ? esc(e.created_by_name) : 'автоматично'}</div>
          </div>
          <div class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : ''}${e.amount}</div>
        </div>`;
    }).join('')}</div>` : empty('sparkle', 'Тут поки порожньо', '<p>Виконай перше завдання — і тут з’являться бліски.</p>')}`);

  const range = document.getElementById('range');
  if (range) {
    const draw = () => {
      const pct = Number(range.value);
      const r = payoutQuote(pct, bal.blisks, bal.rate);
      range.style.setProperty('--fill', `${pct}%`);
      document.getElementById('pct').textContent = `${pct}%`;
      document.getElementById('q-uah').textContent = `${r.uah} грн`;
      document.getElementById('q-rest').textContent = r.remaining;
    };
    range.addEventListener('input', draw);
    range.addEventListener('change', async () => {
      try {
        await api('/payout-percent', { method: 'PUT', body: { percent: Number(range.value) } });
        toast(`Збережено: ${range.value}%`);
      } catch (err) { toast(err.message, true); }
    });
  }

  const form = document.getElementById('entry');
  if (!form) return;
  let sign = 1;
  form.querySelectorAll('[data-sign]').forEach(btn => {
    btn.onclick = () => {
      sign = Number(btn.dataset.sign);
      form.querySelectorAll('[data-sign]').forEach(b => b.classList.toggle('on', b === btn));
    };
  });
  form.onsubmit = e => {
    e.preventDefault();
    act(form.querySelector('button.block'), async () => {
      await api('/ledger', { body: { amount: sign * Math.abs(Number(form.amount.value)), note: form.note.value } });
      toast('Запис додано');
      render();
    });
  };
}

// ---------- Ще ----------

async function viewMore() {
  const [c, pauses, holidays, meeting, shop] = await Promise.all([
    api('/complaints'), api('/pauses'), api('/holidays'), api('/meeting'), api('/shop'),
  ]);
  const open = c.complaints.filter(x => x.status === 'open').length;
  const agenda = meeting.topics.open.length + meeting.purchases.length + meeting.complaints.length;
  const contract = meeting.contract;
  const today = kyivToday();
  const activePause = pauses.find(p => p.status === 'active' && p.start_day <= today && p.end_day >= today);
  const next = holidays[0];
  const item = (href, ico, title, sub, badge = '') => `
    <a href="${href}">
      <span class="m-ico">${icon(ico)}</span>
      <span class="m-text">${title}<small>${sub}</small></span>
      ${badge ? `<span class="badge-n">${badge}</span>` : ''}
      ${icon('chevron', 'chev')}
    </a>`;
  show(`
    <h1>Ще</h1>
    <div class="card menu">
      ${item('#/shop', 'bag', 'Магазин', `Подарунків: ${shop.items.filter(i => i.active).length} · доступно ${shop.available} блісків`)}
      ${item('#/meeting', 'users', 'Сімейні збори', `${meeting.date === today ? 'Сьогодні' : fmtShortDay(meeting.date)} · ${contract.expired ? 'договір закінчився' : `договір до ${fmtShortDay(contract.end)}`}`, agenda || '')}
      ${item('#/complaints', 'flag', 'Скарги та штрафи', open ? `Відкритих: ${open}` : 'Розглядаються на сімейних зборах', open || '')}
      ${item('#/pause', 'pause', 'Пауза', activePause ? `Діє до ${fmtShortDay(activePause.end_day)}` : 'Хвороба чи іспити — за згодою обох')}
      ${item('#/holidays', 'cake', 'Свята', next ? `Найближче: ${next.name}, ${fmtShortDay(next.day)}` : 'Бліски на свята')}
      ${item('#/settings', 'sliders', 'Налаштування', 'Курс, нагороди, штрафи')}
    </div>
    <h2>Акаунт</h2>
    <div class="card account">
      ${avatar(session.user)}
      <div><b>${esc(session.user.name)}</b><div class="muted small">${isSon() ? 'Син' : 'Батьки'}</div></div>
      <button class="soft" id="logout">${icon('logout')}Вийти</button>
    </div>`);
  document.getElementById('logout').onclick = async () => {
    await api('/logout', { body: {} });
    session.user = null;
    render();
  };
}

// ---------- Скарги та штрафи ----------

async function viewComplaints() {
  const { complaints, fines } = await api('/complaints');
  const role = session.user.role;
  const card = c => {
    let footer;
    if (c.status === 'fined') footer = `<span class="pill bad">${icon('flag')}Штраф ${c.against === 'son' ? '−' : '+'}${c.fine_amount}</span>`;
    else if (c.status === 'dismissed') footer = `<span class="pill">${icon('x')}Відхилено</span>`;
    else if (!c.proposal) footer = `
      <p class="muted small">Що вирішили на зборах?</p>
      <div class="btn-row even" style="margin-top:8px">
        <button class="bad" data-propose="fine">${icon('flag')}Штраф ${fines[c.against].next}</button>
        <button class="soft" data-propose="dismiss">${icon('x')}Відхилити</button>
      </div>`;
    else if (c.proposed_by === role) footer = `<span class="pill wait">${icon('hourglass')}Чекає згоди: ${esc(sideName(c.proposed_by === 'son' ? 'parents' : 'son'))}</span>
      <p class="muted small" style="margin-top:8px">Ви запропонували: ${c.proposal === 'fine' ? 'штраф' : 'відхилити'}.</p>`;
    else footer = `<p class="muted small"><b>${esc(sideName(c.proposed_by))}</b> пропонує: ${c.proposal === 'fine' ? `штраф ${fines[c.against].next}` : 'відхилити скаргу'}.</p>${answerButtons}`;
    return `
      <div class="card" data-complaint="${c.id}">
        <div class="who-line">${miniAvatar(c.against)}Скарга на ${complaintTarget(c)} · ${fmtDate(c.created_at)}</div>
        <div class="big-text">${esc(c.text)}</div>
        <div style="margin-top:10px">${footer}</div>
      </div>`;
  };

  show(`
    ${backLink}
    <h1>Скарги та штрафи</h1>
    <p class="lead">Скарги розглядаються на сімейних зборах у неділю (п. 5.2). Рішення діє, коли погодиться друга сторона.</p>
    <div class="card">
      <div class="group-title">${icon('flag')}Штрафи цього місяця</div>
      <div class="stat-grid">
        <div class="stat"><b>${fines.son.count}</b><span>${esc(sideName('son'))} · наступний −${fines.son.next}</span></div>
        <div class="stat"><b>${fines.parents.count}</b><span>Батьки · наступний +${fines.parents.next} сину</span></div>
      </div>
      <p class="muted small" style="margin-top:10px">Кожен наступний штраф у місяці більший на 50% від початкового. 1 числа лічильники обнуляються (п. 3).</p>
    </div>
    <form id="complaint" class="card">
      <div class="group-title">${icon('message')}Скарга на ${role === 'son' ? 'батьків' : 'сина'}</div>
      <textarea name="text" maxlength="300" placeholder="Що сталося?" required></textarea>
      <button class="block" style="margin-top:12px">Надіслати скаргу</button>
    </form>
    ${complaints.length ? `<h2>Усі скарги <span class="count">${complaints.length}</span></h2>${complaints.map(card).join('')}` : ''}`);

  const form = document.getElementById('complaint');
  form.onsubmit = e => {
    e.preventDefault();
    act(form.querySelector('button'), async () => {
      await api('/complaints', { body: { text: form.text.value } });
      toast('Скаргу додано');
      render();
    });
  };
  app.querySelectorAll('[data-complaint]').forEach(cardEl => {
    const id = cardEl.dataset.complaint;
    cardEl.querySelectorAll('[data-propose]').forEach(btn => {
      btn.onclick = () => act(btn, async () => {
        await api(`/complaints/${id}/propose`, { body: { proposal: btn.dataset.propose } });
        toast('Запропоновано. Чекаємо згоди іншої сторони');
        render();
      });
    });
    cardEl.querySelectorAll('[data-agree]').forEach(btn => {
      btn.onclick = () => act(btn, async () => {
        await api(`/complaints/${id}/answer`, { body: { agree: btn.dataset.agree === '1' } });
        toast(btn.dataset.agree === '1' ? 'Рішення прийнято' : 'Скарга знову відкрита');
        render();
      });
    });
  });
}

// ---------- Пауза ----------

async function viewPause() {
  const pauses = await api('/pauses');
  const role = session.user.role;
  const today = kyivToday();
  const card = p => {
    const live = p.status === 'active' && p.end_day >= today;
    let footer = '';
    if (p.status === 'pending' && p.requested_by === role) footer = `<span class="pill wait">${icon('hourglass')}Чекає згоди</span>
      <button class="plain" data-withdraw style="margin-top:6px">Відкликати запит</button>`;
    else if (p.status === 'pending') footer = answerButtons;
    else if (live) footer = `<span class="pill ok">${icon('check')}${p.start_day > today ? 'Погоджено' : 'Діє зараз'}</span>
      ${role === 'son' ? `<button class="soft block" data-end style="margin-top:12px">Завершити паузу достроково</button>` : ''}`;
    else footer = `<span class="pill">${p.status === 'declined' ? 'Не погоджено' : 'Завершено'}</span>`;
    return `
      <div class="card ${p.status === 'pending' && p.requested_by !== role ? 'consent' : ''}" data-pause="${p.id}">
        <div class="who-line">${miniAvatar(p.requested_by)}Запит: ${esc(sideName(p.requested_by))}</div>
        <div class="big-text">${pauseDates(p)}</div>
        <p class="muted">${esc(p.reason)}</p>
        <div style="margin-top:10px">${footer}</div>
      </div>`;
  };

  show(`
    ${backLink}
    <h1>Пауза</h1>
    <p class="lead">Хвороба чи іспити? Завдання можна поставити на паузу без втрати серії, досягнень і штрафів (п. 9). Діє лише за згодою обох.</p>
    ${pauses.map(card).join('')}
    <form id="pause" class="card">
      <div class="group-title">${icon('pause')}Попросити паузу</div>
      <div class="grid-2">
        <div class="field"><label>З</label><input name="start" type="date" value="${today}" min="${today}" required></div>
        <div class="field"><label>По</label><input name="end" type="date" value="${today}" min="${today}" required></div>
      </div>
      <div class="field"><label>Причина</label><input name="reason" placeholder="Напр. застуда, тиждень контрольних" required></div>
      <button class="block" style="margin-top:14px">Надіслати запит</button>
    </form>`);

  const form = document.getElementById('pause');
  form.onsubmit = e => {
    e.preventDefault();
    act(form.querySelector('button'), async () => {
      await api('/pauses', { body: { start: form.start.value, end: form.end.value, reason: form.reason.value } });
      toast('Запит надіслано');
      render();
    });
  };
  app.querySelectorAll('[data-pause]').forEach(el => {
    const id = el.dataset.pause;
    el.querySelectorAll('[data-agree]').forEach(btn => {
      btn.onclick = () => act(btn, async () => {
        await api(`/pauses/${id}/answer`, { body: { agree: btn.dataset.agree === '1' } });
        toast(btn.dataset.agree === '1' ? 'Паузу погоджено' : 'Відмовлено');
        render();
      });
    });
    const withdraw = el.querySelector('[data-withdraw]');
    if (withdraw) withdraw.onclick = () => act(withdraw, async () => {
      await api(`/pauses/${id}/answer`, { body: { agree: false } });
      toast('Запит відкликано');
      render();
    });
    const end = el.querySelector('[data-end]');
    if (end) end.onclick = () => act(end, async () => {
      await api(`/pauses/${id}/end`, { body: {} });
      toast('Паузу завершено');
      render();
    });
  });
}

// ---------- Магазин ----------

async function viewShop() {
  const data = await api('/shop');
  const son = isSon();
  const itemCard = i => {
    const short = i.price - data.available;
    const actions = son
      ? `<button class="block" data-buy style="margin-top:14px" ${short > 0 ? 'disabled' : ''}>${short > 0 ? `Ще треба ${short} блісків` : `${icon('bag')}Купити`}</button>`
      : `<div class="btn-row" style="margin-top:14px">
          <button class="soft" data-edit>${icon('sliders')}Змінити</button>
          <button class="soft icon-btn" data-toggle aria-label="${i.active ? 'Сховати' : 'Показати'}" title="${i.active ? 'Сховати від сина' : 'Показати синові'}">${icon(i.active ? 'eyeOff' : 'eye')}</button>
        </div>
        <form class="sheet" data-edit-form hidden>
          <div class="field"><label>Назва</label><input name="name" value="${esc(i.name)}" maxlength="80" required></div>
          <div class="field"><label>Ціна</label><div class="suffix"><input name="price" type="number" min="1" step="1" value="${i.price}" required><span>блісків</span></div></div>
          <div class="field"><label>Опис</label><input name="description" value="${esc(i.description)}" maxlength="200"></div>
          <button class="block" style="margin-top:14px">Зберегти</button>
        </form>`;
    return `
      <div class="card ${i.active ? '' : 'hidden-item'}" data-item="${i.id}">
        <div class="row spread" style="align-items:flex-start">
          <div>
            <div class="big-text" style="margin:0">${esc(i.name)}</div>
            ${i.description ? `<p class="muted small">${esc(i.description)}</p>` : ''}
            ${i.active ? '' : '<p class="muted small">Схований від сина</p>'}
          </div>
          <span class="pill gold">${coin(18)}${i.price}</span>
        </div>
        ${actions}
      </div>`;
  };
  const purchases = data.purchases.slice(0, 10);

  show(`
    ${backLink}
    <h1>Магазин</h1>
    <p class="lead">Подарунки від батьків за бліски. Кожну покупку погоджують на сімейних зборах у неділю (п. 6.2).</p>
    <div class="hero" style="padding:18px 22px">
      <div class="hero-top"><span>${son ? 'Можеш витратити' : 'Доступно сину'}</span></div>
      <div class="hero-balance" style="margin-top:8px">${coin(32)}<span class="num" style="font-size:38px">${data.available}</span></div>
      <div class="hero-sub">Бліски на покупках, що чекають рішення, вже відкладено</div>
    </div>
    ${purchases.length ? `<h2>Покупки</h2>${purchases.map(purchaseCard).join('')}` : ''}
    <h2>Подарунки <span class="count">${data.items.length}</span></h2>
    ${data.items.length ? data.items.map(itemCard).join('') : empty('gift', 'Поки порожньо', son ? '<p>Батьки ще не додали подарунків. Запропонуй ідею на зборах!</p>' : '<p>Додайте перший подарунок нижче.</p>')}
    ${son ? '' : `
      <form id="new-item" class="card">
        <div class="group-title">${icon('plus')}Новий подарунок</div>
        <div class="field"><label>Назва</label><input name="name" maxlength="80" placeholder="Напр. похід у кіно" required></div>
        <div class="field"><label>Ціна</label><div class="suffix"><input name="price" type="number" min="1" step="1" required><span>блісків</span></div></div>
        <div class="field"><label>Опис</label><input name="description" maxlength="200" placeholder="Необов'язково"></div>
        <button class="block" style="margin-top:14px">Додати</button>
      </form>`}`);

  bindPurchases();
  app.querySelectorAll('[data-item]').forEach(card => {
    const id = card.dataset.item;
    const buyBtn = card.querySelector('[data-buy]');
    if (buyBtn) buyBtn.onclick = () => act(buyBtn, async () => {
      await api(`/shop/items/${id}/buy`, { body: {} });
      toast('Запит надіслано — обговорите на зборах');
      render();
    });
    const form = card.querySelector('[data-edit-form]');
    card.querySelector('[data-edit]')?.addEventListener('click', () => { form.hidden = !form.hidden; });
    const toggle = card.querySelector('[data-toggle]');
    if (toggle) toggle.onclick = () => act(toggle, async () => {
      await api(`/shop/items/${id}`, { method: 'PUT', body: { active: card.classList.contains('hidden-item') } });
      render();
    });
    if (form) form.onsubmit = e => {
      e.preventDefault();
      act(form.querySelector('button'), async () => {
        await api(`/shop/items/${id}`, { method: 'PUT', body: Object.fromEntries(new FormData(form)) });
        toast('Збережено');
        render();
      });
    };
  });
  const add = document.getElementById('new-item');
  if (add) add.onsubmit = e => {
    e.preventDefault();
    act(add.querySelector('button'), async () => {
      await api('/shop/items', { body: Object.fromEntries(new FormData(add)) });
      toast('Подарунок додано');
      render();
    });
  };
}

// ---------- Сімейні збори ----------

async function viewMeeting() {
  const m = await api('/meeting');
  const role = session.user.role;
  const isToday = m.date === kyivToday();
  const s = m.summary;
  const c = m.contract;
  const stat = (value, label) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;

  let contractFooter;
  if (c.renewProposedBy === role) contractFooter = `
    <div class="row spread" style="margin-top:12px">
      <span class="pill wait">${icon('hourglass')}Чекає згоди: ${esc(sideName(role === 'son' ? 'parents' : 'son'))}</span>
      <button class="plain" data-renew-withdraw style="min-height:0;padding:6px 4px">Відкликати</button>
    </div>`;
  else if (c.renewProposedBy) contractFooter = `<p class="muted small" style="margin-top:10px"><b>${esc(sideName(c.renewProposedBy))}</b> пропонує продовжити ще на 3 місяці.</p>${answerButtons}`;
  else contractFooter = `<button class="${c.dueSoon ? '' : 'soft'} block" data-renew style="margin-top:12px">${icon('file')}Запропонувати продовжити на 3 місяці</button>`;

  show(`
    ${backLink}
    <h1>Сімейні збори</h1>
    <p class="lead">${isToday ? '<b style="color:var(--text)">Сьогодні неділя — час зборів!</b>' : `Наступні: ${esc(fmtDay(m.date))}.`} Тут обговорюють скарги, покупки й правила (п. 5.2, 6.2, 7.3, 12.2).</p>
    <div class="card">
      <div class="group-title">${icon('trophy')}Підсумки тижня</div>
      <div class="stat-grid">
        ${stat(s.tasks, 'завдань зараховано')}
        ${stat(s.grades, 'оцінок зараховано')}
        ${stat(`+${s.earned}`, 'блісків зароблено')}
        ${stat(s.spent, 'блісків витрачено й знято')}
        ${stat(s.missed, 'завдань пропущено')}
        ${stat(s.fines, 'штрафів')}
      </div>
    </div>
    <div class="card" data-renewal>
      <div class="group-title">${icon('file')}Договір</div>
      <p>${c.expired
        ? `<b style="color:var(--bad)">Термін закінчився ${esc(fmtShortDay(c.end))}.</b>`
        : `Діє до <b>${esc(fmtShortDay(c.end))}</b> — ще ${c.daysLeft} ${plural(c.daysLeft, 'день', 'дні', 'днів')}.`}
        Продовження — за згодою обох сторін (п. 12).</p>
      ${contractFooter}
    </div>
    ${m.complaints.length ? `
      <h2>Скарги <span class="count">${m.complaints.length}</span></h2>
      <a class="card menu" href="#/complaints" style="display:block;text-decoration:none;color:inherit;padding:16px 18px">
        ${m.complaints.map(x => `<p style="margin:4px 0">${icon('flag')} <b>На ${complaintTarget(x)}:</b> ${esc(x.text)}</p>`).join('')}
        <p class="muted small" style="margin-top:8px">Відкрити скарги ›</p>
      </a>` : ''}
    ${m.purchases.length ? `<h2>Покупки <span class="count">${m.purchases.length}</span></h2>${m.purchases.map(purchaseCard).join('')}` : ''}
    <h2>Теми <span class="count">${m.topics.open.length}</span></h2>
    ${m.topics.open.map(t => `
      <div class="card" data-topic="${t.id}">
        <div class="who-line">${miniAvatar(t.created_by)}${esc(sideName(t.created_by))} · ${fmtDate(t.created_at)}</div>
        <div class="big-text">${esc(t.text)}</div>
        <form class="sheet" style="border-top:0;padding-top:0;margin-top:10px">
          <input name="decision" placeholder="Що вирішили?" required>
          <button class="soft block" style="margin-top:10px">${icon('check')}Обговорено</button>
        </form>
      </div>`).join('')}
    <form id="topic" class="card">
      <div class="group-title">${icon('message')}Нова тема</div>
      <textarea name="text" maxlength="300" placeholder="Напр. змінити курс блісків, новий подарунок у магазин…" required></textarea>
      <button class="block" style="margin-top:12px">Додати тему</button>
    </form>
    ${m.topics.discussed.length ? `
      <h2>Вирішено раніше</h2>
      ${m.topics.discussed.map(t => `
        <div class="card">
          <div class="who-line">${miniAvatar(t.created_by)}${fmtDate(t.discussed_at)}</div>
          <div class="big-text">${esc(t.text)}</div>
          <div class="quote">${icon('check')}<div><b>Рішення</b>${esc(t.decision)}</div></div>
        </div>`).join('')}` : ''}`);

  bindPurchases();
  const topicForm = document.getElementById('topic');
  topicForm.onsubmit = e => {
    e.preventDefault();
    act(topicForm.querySelector('button'), async () => {
      await api('/topics', { body: { text: topicForm.text.value } });
      toast('Тему додано');
      render();
    });
  };
  app.querySelectorAll('[data-topic]').forEach(card => {
    const form = card.querySelector('form');
    form.onsubmit = e => {
      e.preventDefault();
      act(form.querySelector('button'), async () => {
        await api(`/topics/${card.dataset.topic}/discuss`, { body: { decision: form.decision.value } });
        toast('Записано');
        render();
      });
    };
  });
  const renewCard = app.querySelector('[data-renewal]');
  const renew = renewCard.querySelector('[data-renew]');
  if (renew) renew.onclick = () => act(renew, async () => {
    await api('/contract/renew', { body: {} });
    toast('Запропоновано. Чекаємо згоди іншої сторони');
    render();
  });
  const withdraw = renewCard.querySelector('[data-renew-withdraw]');
  if (withdraw) withdraw.onclick = () => act(withdraw, async () => {
    await api('/contract/answer', { body: { agree: false } });
    render();
  });
  renewCard.querySelectorAll('[data-agree]').forEach(btn => {
    btn.onclick = () => act(btn, async () => {
      await api('/contract/answer', { body: { agree: btn.dataset.agree === '1' } });
      toast(btn.dataset.agree === '1' ? 'Договір продовжено на 3 місяці' : 'Відповідь надіслано');
      render();
    });
  });
}

// ---------- Свята ----------

async function viewHolidays() {
  const [list, settings] = await Promise.all([api('/holidays'), api('/settings')]);
  show(`
    ${backLink}
    <h1>Свята</h1>
    <p class="lead">Бліски нараховуються автоматично в день свята (п. 2.2).</p>
    <div class="card">
      ${list.map(h => {
        const d = new Date(`${h.day}T12:00:00`);
        return `
          <div class="holiday">
            <div class="date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('uk-UA', { month: 'short' })}</span></div>
            <div class="h-name">${esc(h.name)}${h.awarded ? '<div class="muted small">Нараховано</div>' : ''}</div>
            <span class="pill gold">${coin(18)}+${h.amount}</span>
          </div>`;
      }).join('')}
    </div>
    <div class="card">
      <div class="group-title">${icon('sparkle')}Зубна фея</div>
      <p class="muted">Випав зуб — ${coin(16)} +${settings.holiday_tooth_fairy}. ${isSon() ? 'Покажи зуб батькам, вони натиснуть кнопку.' : ''}</p>
      ${isSon() ? '' : `<button class="block" id="fairy" style="margin-top:12px">Нарахувати від зубної феї</button>`}
    </div>`);
  const fairy = document.getElementById('fairy');
  if (fairy) fairy.onclick = () => act(fairy, async () => {
    await api('/tooth-fairy', { body: {} });
    toast(`Зубна фея принесла +${settings.holiday_tooth_fairy}`);
    render();
  });
}

// ---------- Налаштування ----------

const SETTING_GROUPS = [
  { title: 'Курс блісків', icon: 'scale', grid: true, fields: [
    ['rate_blisks', 'Бліски', 'блісків'],
    ['rate_uah', 'Дорівнюють', 'грн'],
  ] },
  { title: 'Завдання', icon: 'sun', grid: true, fields: [
    ['tasks_per_day', 'Завдань на день', 'шт'],
    ['regen_limit', 'Перегенерацій', 'на день'],
    ['reward_easy', 'Легке', 'блісків'],
    ['reward_medium', 'Середнє', 'блісків'],
    ['reward_hard', 'Складне', 'блісків'],
  ] },
  { title: 'Оцінки (п. 4)', icon: 'book', grid: true, fields: [
    ['grade_12', 'За 12', 'блісків'],
    ['grade_11', 'За 11', 'блісків'],
    ['grade_10', 'За 10', 'блісків'],
    ['grade_9', 'За 9', 'блісків'],
    ['mult_class', 'Класна', '×'],
    ['mult_home', 'Домашня', '×'],
    ['mult_independent', 'Самостійна', '×'],
    ['mult_test', 'Контрольна', '×'],
    ['mult_topic', 'Тематична', '×'],
  ] },
  { title: 'Штрафи (п. 3)', icon: 'flag', grid: true, fields: [
    ['fine_base', 'Перший штраф', 'блісків'],
    ['fine_step_percent', 'Кожен наступний', '%'],
  ] },
  { title: 'Свята (п. 2.2)', icon: 'cake', grid: true, fields: [
    ['holiday_birthday', 'День народження', 'блісків'],
    ['holiday_new_year', 'Новий рік', 'блісків'],
    ['holiday_easter', 'Великдень', 'блісків'],
    ['holiday_nicholas', 'Святий Миколай', 'блісків'],
    ['holiday_defenders', 'День захисників', 'блісків'],
    ['holiday_children', 'День дітей', 'блісків'],
    ['holiday_tooth_fairy', 'Зубна фея', 'блісків'],
  ] },
  { title: 'Бонуси (п. 11)', icon: 'trophy', grid: true, fields: [
    ['bonus_streak', '7 днів поспіль', 'блісків'],
    ['bonus_perfect_month', 'Ідеальний місяць', 'блісків'],
  ] },
  { title: 'Дати', icon: 'file', fields: [
    ['son_birth_date', 'Дата народження сина (для свята й ШІ)', null],
    ['contract_end', 'Договір діє до (п. 12.1)', null],
  ] },
];

async function viewSettings() {
  const settings = await api('/settings');
  const parents = !isSon();
  const field = ([key, label, suffix]) => `
    <div class="field"><label>${label}</label>
      ${suffix
        ? `<div class="suffix"><input name="${key}" value="${esc(settings[key])}" type="number" min="0" step="1" inputmode="numeric" ${parents ? '' : 'disabled'}><span>${suffix}</span></div>`
        : `<input name="${key}" value="${esc(settings[key])}" type="date" ${parents ? '' : 'disabled'}>`}
    </div>`;

  show(`
    ${backLink}
    <h1>Налаштування</h1>
    <p class="lead">Змінюються на сімейних зборах у неділю (п. 12.2).${parents ? '' : ' Редагувати можуть лише батьки.'}</p>
    <form id="settings">
      ${SETTING_GROUPS.map(g => `
        <div class="card">
          <div class="group-title">${icon(g.icon)}${g.title}</div>
          <div class="${g.grid ? 'grid-2' : ''}">${g.fields.map(field).join('')}</div>
        </div>`).join('')}
      ${parents ? `<button class="block">${icon('check')}Зберегти</button>` : ''}
    </form>`);

  const form = document.getElementById('settings');
  form.onsubmit = e => {
    e.preventDefault();
    act(form.querySelector('button'), async () => {
      await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(form)) });
      toast('Збережено');
      render();
    });
  };
}

render();
