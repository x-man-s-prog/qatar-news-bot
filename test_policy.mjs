// Offline unit tests for the AI policy and the deterministic summary. No network, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

delete process.env.AI_MODE;
delete process.env.GEMINI_API_KEY;
const { gemini, AI_ENABLED, AIDisabledError } = await import('./bot.mjs');
const { extractiveSummary, isSport } = await import('./lib.mjs');

test('AI is disabled by default and a model request is never made', async () => {
  assert.equal(AI_ENABLED, false);
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; throw new Error('network must not be touched'); };
  try {
    await assert.rejects(() => gemini('hello'), AIDisabledError);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(called, 0);
});

test('a key alone (without AI_MODE=gemini) does not enable AI; both together do', () => {
  const code = "import('./bot.mjs').then(m => { process.stdout.write(String(m.AI_ENABLED)); })";
  const run = (env) => spawnSync(process.execPath, ['-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' }).stdout;
  assert.equal(run({ GEMINI_API_KEY: 'k', AI_MODE: '' }), 'false');
  assert.equal(run({ GEMINI_API_KEY: 'k', AI_MODE: 'deterministic' }), 'false');
  assert.equal(run({ GEMINI_API_KEY: '', AI_MODE: 'gemini' }), 'false');
  assert.equal(run({ GEMINI_API_KEY: 'k', AI_MODE: 'gemini' }), 'true');
});

test('extractive summary: first sentences, capped, deterministic', () => {
  const body = 'أعلنت الوزارة اليوم عن خطة جديدة لتحسين الخدمات الصحية في الدولة. وتشمل الخطة افتتاح مراكز جديدة خلال العام. ' +
    'كما ستوفر الوزارة كوادر إضافية في المناطق البعيدة عن المدن الكبرى. وقال مسؤول إن التنفيذ سيبدأ قريباً بحسب الجدول.';
  const s = extractiveSummary(body, '');
  assert.ok(s.length > 40 && s.length <= 421, String(s.length));
  assert.ok(s.startsWith('أعلنت الوزارة'));
  assert.equal(s, extractiveSummary(body, ''));
  assert.ok(s.split(/(?<=[.!?؟…])\s+/).length <= 3);
});

test('extractive summary falls back to the feed description and handles empty input', () => {
  assert.equal(extractiveSummary('', 'Short description from the feed about the story today.').startsWith('Short description'), true);
  assert.equal(extractiveSummary('', ''), '');
  assert.ok(extractiveSummary('x'.repeat(2000), '').length <= 421);
});

test('the deterministic sports filter still works (Gemini is not needed for it)', () => {
  assert.equal(isSport('نتائج مباراة كرة القدم في الدوري'), true);
  assert.equal(isSport('Football league match result'), true);
  assert.equal(isSport('وزارة الصحة تطلق حملة تطعيم جديدة'), false);
});
