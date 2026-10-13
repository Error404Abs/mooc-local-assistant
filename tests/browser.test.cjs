const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createApp, readQuiz, wireQuestion } = require('../mooc-assistant.user.js');
const TOKEN = 'a'.repeat(48);
const COURSE = '中国文化传承与科技创新';
function html(type = 'checkbox') {
  return `<h1>${COURSE}</h1><video></video><div class="quiz"><p>What are the schools of philosophies that influenced TCM?</p>
    <label><input type="${type}" name="quiz">A. Taoism</label><label><input type="${type}" name="quiz">B. Confucianism</label>
    <label><input type="${type}" name="quiz">C. Buddhism</label><label><input type="${type}" name="quiz">D. Mohism</label>
    <button id="submit">提交</button></div><label><input type="checkbox" checked>自动播放下一视频</label>`;
}
function fixture(t, options = {}) {
  const dom = new JSDOM(html(options.type), { url: 'https://www.icourse163.org/learn/test', pretendToBeVisual: true });
  const { window } = dom, doc = window.document;
  const records = { requests: [], submissions: 0, continues: 0, notices: [] };
  let playing = false, currentTime = 0;
  const video = doc.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => !playing });
  Object.defineProperty(video, 'currentTime', { get: () => { if (playing) currentTime += 0.1; return currentTime; } });
  Object.defineProperty(video, 'ended', { get: () => false });
  video.play = async () => { if (options.blockPlayback) throw new Error('NotAllowedError'); playing = true; };
  doc.querySelector('#submit').onclick = () => {
    records.submissions++;
    if (options.noFeedback) return;
    const submit = doc.querySelector('#submit'); submit.id = 'continue'; submit.textContent = '继续学习';
    const feedback = doc.createElement('div');
    feedback.textContent = options.unknownFeedback ? '已提交' : options.wrong ? '正确答案：D 你选错了' :
      `正确答案：${options.type === 'radio' ? 'A' : 'A、B、C'} 你选对了`;
    submit.before(feedback);
    submit.onclick = () => { records.continues++; doc.querySelector('.quiz').remove(); };
  };
  const answer = options.answer || { status: 'answered', optionIds: options.type === 'radio' ? ['A'] : ['A', 'B', 'C'], reason: '模拟解释', source: 'ai' };
  const gm = { getValue: (key, fallback) => key === 'localToken' ? TOKEN : fallback, setValue() {},
    notification: n => records.notices.push(n),
    request(request) {
      records.requests.push(request);
      if (options.requestImpl) return options.requestImpl(request);
      let cancelled = false;
      const route = new URL(request.url).pathname;
      const id = window.setTimeout(() => {
        if (cancelled) return;
        options.beforeResponse?.(route, doc);
        if (options.networkError && route === '/solve') return request.onerror();
        const error = (options.serviceError && route === '/solve') || (options.feedbackError && route === '/feedback');
        const result = route === '/health' ? { ready: true, model: 'test-model' } : route === '/feedback' ? { saved: true } : answer;
        request.onload({ status: error ? 502 : 200, responseText: JSON.stringify(error ? { error: { message: options.serviceError || options.feedbackError } } : result) });
      }, options.delay || 0);
      return { abort() { cancelled = true; window.clearTimeout(id); request.onabort(); } };
    } };
  const app = createApp(window, gm, { tick: 100000, poll: 3, result: 70, playback: 70, paused: 20 });
  app.mount();
  t.after(() => { app.destroy(); window.close(); });
  return { dom, window, doc, records, app, video };
}
function makeJudgment(f, marks = ['u-icon-correct', 'u-icon-wrong'], literal = false) {
  const rows = [...f.doc.querySelectorAll('.quiz label')];
  rows.slice(2).forEach(row => row.remove());
  rows.slice(0, 2).forEach((row, index) => {
    const input = row.querySelector('input'), icon = f.doc.createElement('span');
    if (literal) icon.textContent = marks[index]; else icon.className = marks[index];
    row.replaceChildren(input, f.doc.createTextNode(String.fromCharCode(65 + index) + '. '), icon);
  });
}
test('reads screenshot-like multi-choice question and excludes next-video checkbox', t => {
  const f = fixture(t), q = readQuiz(f.doc, COURSE);
  assert.equal(q.type, 'multiple'); assert.equal(q.options.length, 4);
  assert.equal(q.stem, 'What are the schools of philosophies that influenced TCM?');
  assert.deepEqual(wireQuestion(q).options.map(o => o.text), ['Taoism', 'Confucianism', 'Buddhism', 'Mohism']);
});
test('native controls hidden by CSS remain readable through visible labels', t => {
  const f = fixture(t); f.doc.querySelectorAll('.quiz input').forEach(input => { input.style.display = 'none'; });
  assert.equal(readQuiz(f.doc, COURSE).options.length, 4);
});
for (const type of ['checkbox', 'radio']) {
  test(`${type}: full solve -> select -> submit -> confirmed feedback -> continue -> playing`, async t => {
    const f = fixture(t, { type }); await f.app.start();
    assert.equal(f.records.submissions, 1); assert.equal(f.records.continues, 1); assert.equal(f.video.paused, false);
    assert.equal(f.app.state.active, true); assert.match(f.app.state.phase, /监测中/);
    assert.equal(f.records.requests.filter(r => r.url.endsWith('/feedback')).length, 1);
    assert.equal(f.app.state.judgment, 'correct');
    assert.match(f.doc.querySelector('[data-field="verdict"]').textContent, /答对了/);
    assert.match(f.app.state.lastResult, /正确答案：A/);
    await f.app.scan(); assert.equal(f.records.submissions, 1);
  });
}
test('uncertain answer never selects or submits', async t => {
  const f = fixture(t, { answer: { status: 'uncertain', optionIds: [], reason: '缺少视频上下文' } }); await f.app.start();
  assert.equal(f.records.submissions, 0); assert.equal(f.doc.querySelectorAll('.quiz input:checked').length, 0);
  assert.equal(f.app.state.active, false); assert.match(f.app.state.phase, /无法可靠判断/);
});
for (const answer of [
  { status: 'answered', optionIds: ['X'] }, { status: 'answered', optionIds: ['A', 'A'] },
  { status: 'answered', optionIds: [] }, { status: 'invalid', optionIds: ['A'] },
]) test(`invalid answer ${JSON.stringify(answer)} never submits`, async t => {
  const f = fixture(t, { answer }); await f.app.start(); assert.equal(f.records.submissions, 0); assert.equal(f.app.state.active, false);
});
test('invalid single-choice answer cardinality never submits', async t => {
  const f = fixture(t, { type: 'radio', answer: { status: 'answered', optionIds: ['A', 'B'] } });
  await f.app.start(); assert.equal(f.records.submissions, 0);
});
for (const serviceError of ['API 密钥无效', 'API 余额不足', 'AI 调用超时']) {
  test(`service failure pauses without selecting: ${serviceError}`, async t => {
    const f = fixture(t, { serviceError }); await f.app.start();
    assert.equal(f.records.submissions, 0); assert.equal(f.doc.querySelectorAll('.quiz input:checked').length, 0);
    assert.match(f.app.state.phase, new RegExp(serviceError));
  });
}
test('network error pauses without submission', async t => {
  const f = fixture(t, { networkError: true }); await f.app.start(); assert.equal(f.records.submissions, 0); assert.equal(f.app.state.active, false);
});
test('platform wrong result is cached but does not click continue or retry', async t => {
  const f = fixture(t, { wrong: true }); await f.app.start();
  assert.equal(f.records.submissions, 1); assert.equal(f.records.continues, 0); assert.equal(f.app.state.active, false);
  const feedback = f.records.requests.find(r => r.url.endsWith('/feedback'));
  assert.deepEqual(JSON.parse(feedback.data).correctOptionIds, ['D']); await f.app.scan(); assert.equal(f.records.submissions, 1);
  assert.equal(f.app.state.judgment, 'wrong');
  assert.match(f.doc.querySelector('[data-field="verdict"]').textContent, /答错了/);
  assert.match(f.app.state.lastResult, /你的答案：A、B、C/);
  assert.match(f.app.state.lastResult, /正确答案：D/);
});
test('unknown platform result does not continue', async t => {
  const f = fixture(t, { unknownFeedback: true }); await f.app.start();
  assert.equal(f.records.submissions, 1); assert.equal(f.records.continues, 0); assert.match(f.app.state.phase, /无法确认/);
  assert.equal(f.app.state.judgment, 'unknown');
  assert.match(f.doc.querySelector('[data-field="verdict"]').textContent, /未确认/);
  assert.doesNotMatch(f.app.state.lastResult, /答错了/);
});
test('ambiguous submission timeout is never retried, even after starting again', async t => {
  const f = fixture(t, { noFeedback: true }); await f.app.start();
  assert.equal(f.records.submissions, 1); assert.match(f.app.state.phase, /停止重试/);
  assert.equal(f.app.state.judgment, 'unknown');
  f.doc.querySelectorAll('.quiz input').forEach(input => { input.checked = false; });
  await f.app.start(); assert.equal(f.records.submissions, 1); assert.match(f.app.state.phase, /已提交过/);
});
test('question text changed while waiting for AI cannot submit', async t => {
  const f = fixture(t, { beforeResponse(route, doc) { if (route === '/solve') doc.querySelector('.quiz p').textContent = 'Different question?'; } });
  await f.app.start(); assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /已变化/);
});
test('option order changed while waiting for AI cannot submit', async t => {
  const f = fixture(t, { beforeResponse(route, doc) { if (route === '/solve') doc.querySelector('.quiz').prepend(doc.querySelector('.quiz label:last-of-type')); } });
  await f.app.start(); assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /已变化/);
});
test('pre-existing manual answer is never overwritten', async t => {
  const f = fixture(t); f.doc.querySelector('.quiz input').checked = true; await f.app.start();
  assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /已有选择/);
  assert.equal(f.records.requests.filter(r => r.url.endsWith('/solve')).length, 0);
});
test('programmatic selection changed during request is detected', async t => {
  const f = fixture(t, { beforeResponse(route, doc) { if (route === '/solve') doc.querySelector('.quiz input').checked = true; } });
  await f.app.start(); assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /被修改/);
});
test('manual interaction cancels a pending answer request', async t => {
  const f = fixture(t, { delay: 15 }); const started = f.app.start();
  await new Promise(ok => f.window.setTimeout(ok, 22));
  f.app.handleUserInteraction({ isTrusted: true, target: f.doc.querySelector('.quiz input') });
  await started; assert.equal(f.records.submissions, 0); assert.equal(f.app.state.active, false); assert.match(f.app.state.phase, /人工操作/);
});
test('Pause button cancels pending work', async t => {
  const f = fixture(t, { delay: 15 }); const started = f.app.start();
  await new Promise(ok => f.window.setTimeout(ok, 22)); f.app.pause(); await started;
  assert.equal(f.records.submissions, 0); assert.equal(f.app.state.active, false);
});
test('browser autoplay block pauses after correct answer', async t => {
  const f = fixture(t, { blockPlayback: true }); await f.app.start();
  assert.equal(f.records.continues, 1); assert.equal(f.app.state.active, false); assert.match(f.app.state.phase, /阻止了自动播放/);
});
test('image questions are rejected before calling AI', async t => {
  const f = fixture(t); f.doc.querySelector('.quiz p').append(f.doc.createElement('img')); await f.app.start();
  assert.equal(f.records.requests.filter(r => r.url.endsWith('/solve')).length, 0); assert.equal(f.records.submissions, 0);
});
test('custom ARIA checkbox controls can be selected and verified', async t => {
  const f = fixture(t);
  for (const input of f.doc.querySelectorAll('.quiz input')) {
    const span = f.doc.createElement('span'); span.setAttribute('role', 'checkbox'); span.setAttribute('aria-checked', 'false');
    span.onclick = () => span.setAttribute('aria-checked', span.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    input.replaceWith(span);
  }
  await f.app.start(); assert.equal(f.records.submissions, 1); assert.equal(f.records.continues, 1);
});
test('custom controls without a verifiable selected state are rejected', async t => {
  const f = fixture(t);
  for (const input of f.doc.querySelectorAll('.quiz input')) {
    const span = f.doc.createElement('span'); span.setAttribute('role', 'checkbox'); input.replaceWith(span);
  }
  await f.app.start(); assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /可验证/);
});
test('diagnostics only reads page and never calls service', t => {
  const f = fixture(t); f.app.diagnose(); assert.match(f.app.state.lastResult, /只读检查成功/); assert.equal(f.records.requests.length, 0);
});
test('MOOC CSS-only correct/wrong icons are read as a true/false single-choice question', t => {
  const f = fixture(t, { type: 'radio' }); makeJudgment(f);
  const q = readQuiz(f.doc, COURSE);
  assert.equal(q.isJudgment, true); assert.equal(q.type, 'single');
  assert.deepEqual(wireQuestion(q).options, [{ id: 'A', text: '正确（True）' }, { id: 'B', text: '错误（False）' }]);
  f.app.diagnose(); assert.match(f.app.state.lastResult, /判断题/); assert.equal(f.records.requests.length, 0);
});
test('literal tick/cross symbols are read as a judgment question', t => {
  const f = fixture(t, { type: 'radio' }); makeJudgment(f, ['✔', '✗'], true);
  const q = readQuiz(f.doc, COURSE); assert.equal(q.isJudgment, true);
  assert.deepEqual(q.options.map(o => o.text), ['正确（True）', '错误（False）']);
});
test('true/false meaning follows actual icon even if A is false and B is true', t => {
  const f = fixture(t, { type: 'radio' }); makeJudgment(f, ['u-icon-wrong', 'u-icon-correct']);
  assert.deepEqual(readQuiz(f.doc, COURSE).options.map(o => o.text), ['错误（False）', '正确（True）']);
});
test('private-use font glyphs are decoded only through verified MOOC icon classes', t => {
  const f = fixture(t, { type: 'radio' }); makeJudgment(f);
  f.doc.querySelector('.u-icon-correct').textContent = '\ue618';
  f.doc.querySelector('.u-icon-wrong').textContent = '\ue616';
  assert.equal(readQuiz(f.doc, COURSE).isJudgment, true);
});
test('unknown empty icon options stop before AI and never assume A/B semantics', async t => {
  const f = fixture(t, { type: 'radio' }); makeJudgment(f, ['unverified-icon', 'unverified-icon']);
  await f.app.start(); assert.equal(f.records.submissions, 0);
  assert.equal(f.records.requests.filter(r => r.url.endsWith('/solve')).length, 0);
  assert.match(f.app.state.phase, /判断题图标无法可靠识别/);
});
test('judgment icons support solve -> submit -> correct feedback -> continued video', async t => {
  const f = fixture(t, { type: 'radio' }); makeJudgment(f); await f.app.start();
  assert.equal(f.records.submissions, 1); assert.equal(f.records.continues, 1); assert.equal(f.video.paused, false);
  const sent = JSON.parse(f.records.requests.find(r => r.url.endsWith('/solve')).data).question;
  assert.deepEqual(sent.options.map(o => o.text), ['正确（True）', '错误（False）']);
  assert.equal(f.app.state.judgment, 'correct');
});
test('new unrecognized quiz clears stale correct verdict and inline display style', async t => {
  const f = fixture(t); await f.app.start();
  assert.equal(f.app.state.judgment, 'correct');
  const next = f.doc.createElement('div'); next.className = 'quiz';
  next.innerHTML = '<p>New judgment statement.</p><label><input type="radio" name="new">A. <span class="unknown"></span></label><label><input type="radio" name="new">B. <span class="unknown"></span></label><button>提交</button>';
  f.doc.body.append(next); await f.app.scan();
  assert.equal(f.app.state.judgment, null); assert.equal(f.app.state.active, false);
  const verdict = f.doc.querySelector('[data-field="verdict"]');
  assert.equal(verdict.hidden, true); assert.equal(f.window.getComputedStyle(verdict).display, 'none');
  assert.match(f.app.state.lastResult, /当前题目尚未提交/); assert.equal(f.records.submissions, 1);
});
test('readonly check of a new quiz clears previous correct result without a paid request', async t => {
  const f = fixture(t); await f.app.start();
  const next = f.doc.createElement('div'); next.className = 'quiz';
  next.innerHTML = '<p>New judgment statement.</p><label><input type="radio" name="new">A. <span class="u-icon-correct"></span></label><label><input type="radio" name="new">B. <span class="u-icon-wrong"></span></label><button>提交</button>';
  f.doc.body.append(next); const requestsBefore = f.records.requests.length; f.app.diagnose();
  assert.equal(f.app.state.judgment, null); assert.match(f.app.state.lastResult, /判断题/);
  assert.equal(f.doc.querySelector('[data-field="verdict"]').style.display, 'none');
  assert.equal(f.records.requests.length, requestsBefore);
});
test('assistant cannot start on another course', async t => {
  const f = fixture(t); f.doc.querySelector('h1').textContent = '另一门课程'; await f.app.start();
  assert.equal(f.records.requests.length, 0); assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /未确认目标课程/);
});
test('changing course during API request cannot submit', async t => {
  const f = fixture(t, { beforeResponse(route, doc) { if (route === '/solve') doc.querySelector('h1').textContent = '另一门课程'; } });
  await f.app.start(); assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /离开目标课程/);
});
test('failed checkbox selection cannot trigger submission', async t => {
  const f = fixture(t); f.doc.querySelector('.quiz input').onclick = event => event.preventDefault();
  await f.app.start(); assert.equal(f.records.submissions, 0); assert.match(f.app.state.phase, /无法验证勾选结果/);
});
test('paused video with unrecognized popup stops monitoring', async t => {
  const f = fixture(t); f.doc.querySelector('.quiz').remove(); await f.app.start();
  await new Promise(ok => f.window.setTimeout(ok, 25)); await f.app.scan();
  assert.equal(f.app.state.active, false); assert.match(f.app.state.phase, /持续暂停/); assert.equal(f.records.submissions, 0);
});
test('platform verdict remains visible when saving confirmed answer fails', async t => {
  const f = fixture(t, { feedbackError: '答案缓存写入失败' }); await f.app.start();
  assert.equal(f.app.state.judgment, 'correct'); assert.equal(f.app.state.active, false);
  assert.match(f.doc.querySelector('[data-field="verdict"]').textContent, /答对了/);
  assert.match(f.app.state.lastResult, /正确答案：A、B、C/);
  assert.equal(f.records.continues, 0);
});
test('readonly diagnostics does not erase the last platform verdict', async t => {
  const f = fixture(t); await f.app.start(); f.app.diagnose();
  assert.match(f.doc.querySelector('[data-field="verdict"]').textContent, /答对了/);
  assert.equal(f.app.state.judgment, 'correct');
});
test('browser and real loopback service complete the full flow and reuse content cache', async t => {
  const { createService, DEFAULTS } = await import('../server.mjs');
  const { mkdtemp, rm, readFile } = require('node:fs/promises');
  const { tmpdir } = require('node:os'); const { join } = require('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'mooc-integration-')); let modelCalls = 0;
  const service = await createService({ dataDir: dir, token: TOKEN, apiKey: 'fake-test-key', config: DEFAULTS,
    fetchImpl: async () => {
      modelCalls++;
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ status: 'answered', optionIds: ['A', 'B', 'C'], reason: '模拟 API 回答' }) }] }] }));
    } });
  await new Promise(ok => service.server.listen(0, '127.0.0.1', ok));
  t.after(async () => { service.server.closeAllConnections(); await new Promise(ok => service.server.close(ok)); await rm(dir, { recursive: true, force: true }); });
  const port = service.server.address().port, sources = [];
  const requestImpl = request => {
    const controller = new AbortController();
    fetch(request.url, { method: request.method, headers: request.headers, body: request.data, signal: controller.signal })
      .then(async response => {
        const responseText = await response.text();
        if (request.url.endsWith('/solve')) sources.push(JSON.parse(responseText).source);
        request.onload({ status: response.status, responseText });
      }).catch(error => { if (error.name === 'AbortError') request.onabort(); else request.onerror(); });
    return { abort: () => controller.abort() };
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = fixture(t, { requestImpl }); f.doc.querySelector('[data-field="port"]').value = port;
    await f.app.start();
    assert.equal(f.records.submissions, 1); assert.equal(f.records.continues, 1); assert.equal(f.video.paused, false);
    assert.equal(f.app.state.active, true); f.app.destroy();
  }
  assert.equal(modelCalls, 1); assert.deepEqual(sources, ['ai', 'cache']);
  assert.ok((await readFile(join(dir, 'answers-cache.json'), 'utf8')).includes('Taoism'));
});
