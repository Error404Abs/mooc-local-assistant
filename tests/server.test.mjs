import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createService, DEFAULTS, validateQuestion, validateAnswer, askModel, loadConfig } from '../server.mjs';

const TOKEN = 'a'.repeat(48);
const QUESTION = { course: '中国文化传承与科技创新', type: 'multiple', stem: 'Which philosophies influenced TCM?',
  options: [{ id: 'A', text: 'Taoism' }, { id: 'B', text: 'Confucianism' }, { id: 'C', text: 'Buddhism' }, { id: 'D', text: 'Mohism' }] };
const remoteAnswer = (answer = { status: 'answered', optionIds: ['A', 'B', 'C'], reason: '三种思想' }) =>
  new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }), { status: 200 });
async function fixture(t, fetchImpl = async () => remoteAnswer(), overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mooc-tests-'));
  const service = await createService({ dataDir: dir, apiKey: 'test-secret-do-not-print', config: DEFAULTS, token: TOKEN, fetchImpl, ...overrides });
  await new Promise(ok => service.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => { service.server.closeAllConnections(); await new Promise(ok => service.server.close(ok)); await rm(dir, { recursive: true, force: true }); });
  return { dir, service, base, async send(path, data, headers = {}) {
    const response = await fetch(base + path, { method: data ? 'POST' : 'GET',
      headers: { 'X-MOOC-Token': TOKEN, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, data: await response.json() };
  } };
}
test('validates question and invalid option structures', () => {
  assert.equal(validateQuestion(QUESTION).options.length, 4);
  for (const bad of [null, { ...QUESTION, type: 'fill' }, { ...QUESTION, options: [] },
    { ...QUESTION, options: [{ id: 'A', text: 'same' }, { id: 'B', text: 'same' }] }]) assert.throws(() => validateQuestion(bad));
});
test('answer validation rejects wrong IDs, duplicates, empty and invalid single cardinality', () => {
  for (const ids of [[], ['X'], ['A', 'A']]) assert.throws(() => validateAnswer({ status: 'answered', optionIds: ids, reason: '' }, QUESTION));
  assert.throws(() => validateAnswer({ status: 'answered', optionIds: ['A', 'B'], reason: '' }, { ...QUESTION, type: 'single' }));
  assert.deepEqual(validateAnswer({ status: 'uncertain', optionIds: ['A'], reason: '缺少视频上下文' }, QUESTION).optionIds, []);
});
test('Responses request uses configured model, disabled storage, and correct endpoint', async () => {
  let seen;
  const answer = await askModel(QUESTION, { config: DEFAULTS, apiKey: 'secret', fetchImpl: async (url, request) => {
    seen = { url, request, body: JSON.parse(request.body) }; return remoteAnswer();
  } });
  assert.equal(seen.url, 'https://api-cn.mofluxapi.com/v1/responses');
  assert.equal(seen.body.model, 'gpt-6.1-sol'); assert.equal(seen.body.store, false);
  assert.equal(seen.request.redirect, 'error'); assert.equal(answer.source, 'ai');
});
test('health is authenticated and does not expose API key', async t => {
  const f = await fixture(t);
  const ok = await f.send('/health'); assert.equal(ok.status, 200); assert.equal(ok.data.ready, true);
  assert.ok(!JSON.stringify(ok.data).includes('test-secret'));
  assert.equal((await f.send('/health', null, { 'X-MOOC-Token': 'wrong' })).status, 401);
  assert.equal((await f.send('/health', null, { Origin: 'https://malicious.example' })).status, 403);
  const maliciousHostStatus = await new Promise((ok, fail) => {
    const req = httpRequest(f.base + '/health', { headers: { Host: 'malicious.example', 'X-MOOC-Token': TOKEN } }, res => {
      res.resume(); res.once('end', () => ok(res.statusCode));
    }); req.once('error', fail); req.end();
  });
  assert.equal(maliciousHostStatus, 403);
  assert.equal((await f.send('/health', null, { Origin: 'https://www.icourse163.org' })).status, 200);
});
test('AI answer is returned but is not cached until platform feedback', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return remoteAnswer(); });
  assert.equal((await f.send('/solve', { question: QUESTION })).data.source, 'ai');
  await f.send('/solve', { question: QUESTION }); assert.equal(calls, 2);
});
test('cache matches option content when order and letters change, persists confirmed answers', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return remoteAnswer(); });
  assert.equal((await f.send('/feedback', { question: QUESTION, correctOptionIds: ['A', 'B', 'C'] })).data.saved, true);
  const reordered = { ...QUESTION, options: [
    { id: 'A', text: 'Mohism' }, { id: 'B', text: 'Buddhism' }, { id: 'C', text: 'Taoism' }, { id: 'D', text: 'Confucianism' }] };
  const hit = await f.send('/solve', { question: reordered });
  assert.equal(hit.data.source, 'cache'); assert.deepEqual(hit.data.optionIds, ['B', 'C', 'D']); assert.equal(calls, 0);
  const saved = await readFile(join(f.dir, 'answers-cache.json'), 'utf8');
  assert.ok(saved.includes('Taoism')); assert.ok(!saved.includes('test-secret'));
  const changed = { ...reordered, stem: 'A different question?' };
  assert.equal((await f.send('/solve', { question: changed })).data.source, 'ai');
});
for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [402, 'NO_BALANCE'], [429, 'API_LIMIT'], [503, 'API_FAILED']]) {
  test(`upstream HTTP ${status} becomes safe pause error`, async t => {
    const f = await fixture(t, async () => new Response('private error data', { status }));
    const result = await f.send('/solve', { question: QUESTION });
    assert.equal(result.status, 502); assert.equal(result.data.error.code, code);
    assert.ok(!JSON.stringify(result.data).includes('private error'));
  });
}
test('uncertain answer has no selected options', async t => {
  const f = await fixture(t, async () => remoteAnswer({ status: 'uncertain', optionIds: ['A'], reason: '缺少上下文' }));
  const result = await f.send('/solve', { question: QUESTION });
  assert.equal(result.data.status, 'uncertain'); assert.deepEqual(result.data.optionIds, []);
});
test('malformed/incomplete AI answers fail closed', async () => {
  for (const data of [{ status: 'incomplete', output: [] }, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'probably A' }] }] }]) {
    await assert.rejects(askModel(QUESTION, { config: DEFAULTS, apiKey: 'test', fetchImpl: async () => new Response(JSON.stringify(data)) }));
  }
});
test('request timeout aborts upstream instead of giving an answer', async t => {
  const f = await fixture(t, async (_url, { signal }) => new Promise((_, fail) => {
    signal.addEventListener('abort', () => fail(new Error('aborted')), { once: true });
  }), { config: { ...DEFAULTS, timeoutMs: 20 } });
  const result = await f.send('/solve', { question: QUESTION });
  assert.equal(result.status, 504); assert.equal(result.data.error.code, 'API_TIMEOUT');
});
test('parallel solves cannot cause concurrent paid requests', async t => {
  let release, started;
  const ready = new Promise(ok => { started = ok; });
  const f = await fixture(t, async () => { started(); await new Promise(ok => { release = ok; }); return remoteAnswer(); });
  const first = f.send('/solve', { question: QUESTION }); await ready;
  const second = await f.send('/solve', { question: QUESTION });
  assert.equal(second.status, 409); release(); assert.equal((await first).status, 200);
});
test('invalid request body and content type are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/solve', { question: null })).status, 400);
  assert.equal((await f.send('/solve', { question: QUESTION }, { 'Content-Type': 'text/plain' })).status, 415);
  const r = await fetch(f.base + '/solve', { method: 'POST', headers: { 'X-MOOC-Token': TOKEN, 'Content-Type': 'application/json' }, body: 'not json' });
  assert.equal(r.status, 400);
});
test('config validates HTTPS and permits model changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mooc-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await loadConfig(dir)).model, DEFAULTS.model);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ apiBaseUrl: 'http://unsafe.example/v1' }));
  await assert.rejects(loadConfig(dir));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ model: 'configured-model' }));
  assert.equal((await loadConfig(dir)).model, 'configured-model');
});
