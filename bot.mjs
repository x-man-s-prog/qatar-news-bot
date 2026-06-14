// Shared runtime helpers: Gemini, Telegram, state, formatting.
import fs from 'fs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export class QuotaError extends Error {}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function gemini(prompt, { maxTokens = 1024, temperature = 0.2 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } }) });
  } catch (e) { throw new Error('Gemini network: ' + e); }
  if (r.status === 429) throw new QuotaError('Gemini 429 rate/quota');
  const j = await r.json().catch(() => ({}));
  if (j.error) {
    if (String(j.error.status || '').includes('RESOURCE_EXHAUSTED') || j.error.code === 429) throw new QuotaError(j.error.message);
    throw new Error('Gemini: ' + (j.error.message || 'unknown'));
  }
  return (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '';
}

export async function tgApi(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

export function esc(s) { return String(s || '').split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'); }
export function fmtDate(iso) {
  try { const d = new Date(iso); if (isNaN(d.getTime())) return '';
    const t = new Date(d.getTime() + 3 * 3600 * 1000); const p = n => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
  } catch { return ''; }
}
export function chunkText(s, max = 3500) {
  const out = []; let t = String(s || '');
  if (!t) return ['(لا يتوفّر النص الكامل لهذا الخبر — افتح الرابط من الصحيفة)'];
  while (t.length > 0) { out.push(t.slice(0, max)); t = t.slice(max); }
  return out;
}

export function loadJson(path, def) { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return def; } }
export function saveJson(path, obj) {
  const dir = path.split('/').slice(0, -1).join('/') || '.';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path, JSON.stringify(obj));
}
// keep only the newest `keep` entries (by .ts) of an id->obj map
export function pruneByTs(map, keep) {
  const ids = Object.keys(map);
  if (ids.length <= keep) return;
  ids.map(id => [id, map[id] && map[id].ts || 0]).sort((a, b) => b[1] - a[1]).slice(keep).forEach(([id]) => { delete map[id]; });
}
