import { GoogleGenAI, ApiError } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';

// Хто придумує завдання: Gemini (ключ Google), Claude (ключ Anthropic) або ніхто.
// Без ключа завдання беруться з вбудованого банку.
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
export const aiProvider = GEMINI_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : null;
export const aiEnabled = Boolean(aiProvider);

const gemini = aiProvider === 'gemini' ? new GoogleGenAI({ apiKey: GEMINI_KEY }) : null;
const claude = aiProvider === 'claude' ? new Anthropic() : null;

const GEMINI_MODEL = process.env.ZDT_GEMINI_MODEL || 'gemini-flash-latest';
const CLAUDE_MODEL = process.env.ZDT_MODEL || 'claude-opus-5-5';

const DIFFICULTY_TEXT = {
  easy: 'легке: 10–15 хвилин, без підготовки',
  medium: 'середнє: 20–40 хвилин, треба трохи подумати або щось зробити руками',
  hard: 'складне: 45–90 хвилин, справжній виклик, результат можна показати батькам (фото, текст, виріб)',
};

const SYSTEM = `Ти придумуєш щоденні завдання для сімейного додатку-щоденника "ЗДТ" ("Зацікавлення Днів Тижня").
Завдання виконує хлопчик, який живе з батьками в Києві. За виконання він отримує бліски (внутрішню валюту).

Мета — зробити кожен день цікавішим: завдання мають розвивати, дивувати й давати відчуття досягнення.
Чергуй напрями: наука й експерименти, творчість, логіка й математика, рух і спорт, книжки й мови, природа,
допомога вдома, історія та географія України, маленькі інженерні чи кулінарні проєкти (з дозволу батьків).

Обмеження:
- Завдання безпечне для дитини: без вогню, гострих інструментів, електрики, висоти й хімії без дорослих.
- Не вимагає купівель, реєстрацій в інтернеті чи спілкування з незнайомими людьми.
- Можна виконати вдома або біля дому за один день.
- Результат легко перевірити: батьки можуть побачити його самі або на фото.
- Пиши українською, дружньо й коротко, звертайся на "ти".
- Не повторюй завдання зі списку недавніх.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Коротка назва, до 60 символів' },
    description: { type: 'string', description: 'Що саме зробити і як показати результат, 2–4 речення' },
  },
  required: ['title', 'description'],
  additionalProperties: false,
};

function userPrompt({ difficulty, age, recentTitles }) {
  const recent = recentTitles.length ? recentTitles.map(t => `- ${t}`).join('\n') : '(немає)';
  return `Вік: ${age ? `${age} років` : 'школяр 10–13 років'}.\nСкладність: ${DIFFICULTY_TEXT[difficulty]}.\n\nНедавні завдання:\n${recent}\n\nПридумай одне нове завдання.`;
}

// Якщо модель перевантажена (503) чи вичерпано ліміт (429), чекаємо й пробуємо ще раз,
// потім — запасні моделі. Лише якщо не відповіла жодна, завдання береться з банку.
const GEMINI_FALLBACKS = [...new Set([GEMINI_MODEL, 'gemini-flash-lite-latest', 'gemini-2.5-flash'])];
const isBusy = err => err instanceof ApiError && [429, 500, 503].includes(err.status);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function askGemini(prompt) {
  let lastError;
  for (const model of GEMINI_FALLBACKS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await gemini.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: SYSTEM,
            responseMimeType: 'application/json',
            responseJsonSchema: SCHEMA,
          },
        });
        return response.text;
      } catch (err) {
        if (!isBusy(err)) throw err;
        lastError = err;
        console.warn(`Gemini ${model} перевантажена (${err.status}), спроба ${attempt + 1}`);
        if (attempt === 0) await sleep(1500);
      }
    }
  }
  throw lastError;
}

async function askClaude(prompt) {
  const response = await claude.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Модель відмовилась генерувати завдання');
  return response.content.find(b => b.type === 'text')?.text;
}

export async function generateWithAI(params) {
  const prompt = userPrompt(params);
  const text = aiProvider === 'gemini' ? await askGemini(prompt) : await askClaude(prompt);
  const task = JSON.parse(text ?? '');
  if (typeof task.title !== 'string' || typeof task.description !== 'string' || !task.title.trim()) {
    throw new Error('Модель повернула завдання в неправильному форматі');
  }
  return { title: task.title.trim().slice(0, 120), description: task.description.trim() };
}
