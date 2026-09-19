// Shared runtime helpers: Gemini, Telegram, state, formatting.
import fs from 'fs';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

// AI POLICY (owner directive 2026-09): unattended paid AI is DENIED by default. Gemini runs only when AI_MODE=gemini AND a key
// is present, and only the owner-triggered workflow (news-ai.yml, workflow_dispatch) provides both. The scheduled workflows
// (news.yml, bot.yml) carry no key and no AI_MODE, so they are deterministic and no request to a model provider can be made.
export const AI_ENABLED = (process.env.AI_MODE || '').trim().toLowerCase() === 'gemini' && GEMINI_KEY.length > 0;
export class AIDisabledError extends Error {}
export const DRY_RUN = process.env.DRY_RUN === '1';   // fetch + process, but send nothing and write no state

export class QuotaError extends Error {}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function gemini(prompt, { maxTokens = 1024, temperature = 0.2 } = {}) {
  if (!AI_ENABLED) throw new AIDisabledError('AI disabled by policy (AI_MODE is not gemini or no key): no request was made');
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
  if (DRY_RUN) return { ok: true, result: {} };
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
  if (DRY_RUN) return;
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
