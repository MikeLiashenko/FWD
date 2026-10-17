// Показує моделі Gemini, доступні за ключем із .env (сам ключ не друкується).
// Запуск: node --env-file=.env scripts/gemini-models.mjs
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pager = await ai.models.list();
for await (const m of pager) {
  if (m.supportedActions?.includes('generateContent') && m.name.includes('gemini')) {
    console.log(m.name.replace('models/', ''), '—', m.displayName);
  }
}
