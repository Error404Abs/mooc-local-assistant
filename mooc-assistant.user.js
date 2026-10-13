// ==UserScript==
// @name         中国大学MOOC 视频弹题助手（Moflux 本机版）
// @namespace    local.mooc-assistant
// @version      1.0.2
// @description  识别文字单选/多选及判断题弹窗，经本机服务答题；遇到异常暂停。
// @match        https://www.icourse163.org/*
// @match        https://icourse163.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const COURSE = '中国文化传承与科技创新';
  const PANEL_ID = 'mooc-local-assistant';
  const clean = text => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const textOf = el => clean(el.tagName === 'INPUT' ? el.value : el.textContent);
  function visible(el) {
    if (!el?.isConnected || el.closest('#' + PANEL_ID)) return false;
    const win = el.ownerDocument.defaultView;
    for (let p = el; p; p = p.parentElement) {
      const css = win.getComputedStyle(p);
      if (p.hidden || css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse') return false;
    }
    return true;
  }
  function documents(root) {
    const found = [root];
    for (let i = 0; i < found.length && i < 12; i++) {
      for (const frame of found[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument?.body && !found.includes(frame.contentDocument)) found.push(frame.contentDocument); } catch { /* Cross-origin frame. */ }
      }
    }
    return found;
  }
  function findActions(doc, labels) {
    const nodes = [...doc.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"],span,div')]
      .filter(el => visible(el) && labels.includes(textOf(el)));
    return nodes.filter(el => !nodes.some(child => child !== el && el.contains(child)));
  }
  const rawControls = container => [...container.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')]
    .filter(el => !el.closest('#' + PANEL_ID))
    .filter(el => !el.matches('[role="radio"],[role="checkbox"]') || !el.querySelector('input[type="radio"],input[type="checkbox"]'));
  function optionRow(control) {
    if (control.labels?.length) {
      const label = [...control.labels].find(visible);
      if (label && textOf(label)) return label;
    }
    let row = control.matches('[role]') && textOf(control) ? control : control.parentElement;
    for (let i = 0; row && i < 5; i++, row = row.parentElement) {
      if (rawControls(row).length !== 1) break;
      if (/^[A-Z]\s*[.、:：)．]/.test(textOf(row))) return row;
      if (row.matches('label,li,.j-option,.option,.u-tbi') && textOf(row)) return row;
    }
    return null;
  }
  function selected(control) {
    if (control.tagName === 'INPUT') return Boolean(control.checked);
    const aria = control.getAttribute('aria-checked');
    if (aria === 'true' || aria === 'false') return aria === 'true';
    throw new Error('自定义选项没有可验证的选中状态，已暂停。');
  }
  function booleanMeaning(option) {
    const text = clean(option.text).replace(/[\uFE0E\uFE0F]/g, '');
    if (/^(?:[✓✔√☑✅]|正确|对|true|correct)$/i.test(text)) return true;
    if (/^(?:[✗✘×✕❌❎]|错误|错|false|incorrect)$/i.test(text)) return false;
    if (text && !/^[\uE000-\uF8FF]+$/.test(text)) return null;
    // Verified from MOOC's public stylesheet: these classes render e618/e616 via :before.
    // Never assume A=True/B=False, or infer meaning from a checked radio's decoration.
    const icons = [...option.row.querySelectorAll('.u-icon-correct,.u-icon-wrong')]
      .filter(el => visible(el) && el !== option.control && !option.control.contains(el));
    const trueIcon = icons.some(el => el.classList.contains('u-icon-correct'));
    const falseIcon = icons.some(el => el.classList.contains('u-icon-wrong'));
    return trueIcon === falseIcon ? null : trueIcon;
  }
  function extractQuestion(submit, course) {
    let container = submit.parentElement;
    for (let depth = 0; container && depth < 9; depth++, container = container.parentElement) {
      if (['BODY', 'HTML'].includes(container.tagName)) break;
      const pairs = rawControls(container).map(control => ({ control, row: optionRow(control) }))
        .filter(pair => pair.row && visible(pair.row));
      if (pairs.length < 2) continue;
      if (pairs.length > 26 || new Set(pairs.map(p => p.row)).size !== pairs.length) throw new Error('选项布局存在歧义，已暂停。');
      const types = pairs.map(p => p.control.type || p.control.getAttribute('role'));
      if (!types.every(type => type === types[0]) || !['checkbox', 'radio'].includes(types[0])) throw new Error('无法确认单选或多选题型。');
      const options = pairs.map(({ control, row }, index) => {
        const raw = textOf(row), match = raw.match(/^([A-Z])\s*[.、:：)．]\s*(.*)$/);
        return { id: match ? match[1] : String.fromCharCode(65 + index), text: match ? match[2] : raw,
          control, row, initiallySelected: selected(control) };
      });
      let isJudgment = false;
      if (options.length === 2 && types[0] === 'radio') {
        const meanings = options.map(booleanMeaning);
        if (meanings.every(value => value !== null) && meanings[0] !== meanings[1]) {
          isJudgment = true;
          options.forEach((option, index) => { option.text = meanings[index] ? '正确（True）' : '错误（False）'; });
        } else if (options.some(option => !option.text || /^[\uE000-\uF8FF]+$/.test(option.text))) {
          throw new Error('判断题图标无法可靠识别，已暂停；不会猜测 A/B 的含义。');
        }
      }
      if (options.some(o => !o.text) || new Set(options.map(o => o.id)).size !== options.length ||
          new Set(options.map(o => o.text)).size !== options.length) throw new Error('选项内容为空、重复或编号不明确。');
      if (container.querySelector('img,canvas,svg,math,video,iframe') ||
          [...container.querySelectorAll('*')].some(el => visible(el) && el.ownerDocument.defaultView.getComputedStyle(el).backgroundImage !== 'none' &&
            /url\(/i.test(el.ownerDocument.defaultView.getComputedStyle(el).backgroundImage))) {
        throw new Error('题目包含图片、公式或媒体，第一版仅支持纯文字题。');
      }
      const walker = container.ownerDocument.createTreeWalker(container, 4); // SHOW_TEXT
      const texts = []; let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || !visible(parent) || parent.closest('script,style,button,[role="button"]') ||
            submit.contains(node) || options.some(o => o.row.contains(node))) continue;
        texts.push(node.nodeValue);
      }
      const stem = clean(texts.join(' '));
      if (!stem || stem.length > 10000) throw new Error('无法完整读取题干。');
      return { kind: 'question', container, submit, course, type: types[0] === 'radio' ? 'single' : 'multiple', isJudgment, stem, options };
    }
    throw new Error('发现提交按钮，但无法读取文字选项；可能使用了尚未适配的自定义控件。');
  }
  function readQuiz(root, course) {
    const docs = documents(root);
    const continues = docs.flatMap(doc => findActions(doc, ['继续学习', '继续观看', 'Continue']));
    if (continues.length > 1) throw new Error('发现多个继续按钮，无法确定答题弹窗。');
    if (continues.length === 1) return { kind: 'result', button: continues[0] };
    const submits = docs.flatMap(doc => findActions(doc, ['提交', '提交答案', 'Submit']));
    if (submits.length > 1) throw new Error('发现多个提交按钮，无法确定答题弹窗。');
    return submits.length ? extractQuestion(submits[0], course) : null;
  }
  function wireQuestion(q) {
    return { course: q.course, type: q.type, stem: q.stem, options: q.options.map(o => ({ id: o.id, text: o.text })) };
  }
  const identity = q => JSON.stringify(wireQuestion(q));
  const semanticIdentity = q => JSON.stringify([q.course, q.type, q.stem, q.options.map(o => o.text).sort()]);
  function readFeedback(button, q, expectedIds) {
    let container = button.parentElement, text = '';
    for (let i = 0; container && i < 9; i++, container = container.parentElement) {
      if (['BODY', 'HTML'].includes(container.tagName)) break;
      text = textOf(container);
      if (/正确答案|你选对了|你选错了|回答正确|回答错误|答对了|答错|Your answer is (correct|incorrect)/i.test(text)) break;
    }
    const match = text.match(/正确答案\s*[:：]\s*([A-Z](?:[\s、，,;；]*[A-Z])*)/);
    const ids = match ? [...new Set(match[1].match(/[A-Z]/g))] : [];
    const correctOptionIds = ids.length && q && ids.every(id => q.options.some(o => o.id === id)) ? ids : [];
    const wrong = /你选错了|回答错误|答错|不正确|Your answer is incorrect/i.test(text);
    const positive = /你选对了|回答正确|答对了|Your answer is correct/i.test(text);
    const matches = correctOptionIds.length && expectedIds && [...correctOptionIds].sort().join('') === [...expectedIds].sort().join('');
    return { correctOptionIds, outcome: wrong ? 'wrong' : correctOptionIds.length && expectedIds ? (matches ? 'correct' : 'wrong') : positive ? 'correct' : 'unknown' };
  }
  function validateAnswer(answer, q) {
    if (answer?.status === 'uncertain') throw new Error('AI 无法可靠判断：' + (answer.reason || '请人工作答。'));
    if (answer?.status !== 'answered' || !Array.isArray(answer.optionIds) || !answer.optionIds.length ||
        new Set(answer.optionIds).size !== answer.optionIds.length ||
        answer.optionIds.some(id => !q.options.some(o => o.id === id)) ||
        (q.type === 'single' && answer.optionIds.length !== 1)) throw new Error('答案编号或数量无效，已暂停。');
    return answer;
  }
  function createApp(win, gm, timings = {}) {
    const doc = win.document;
    const timing = { tick: 750, poll: 200, result: 15000, playback: 10000, paused: 20000, ...timings };
    const state = { active: false, busy: false, phase: '尚未开始', generation: 0, question: null,
      answer: null, lastResult: '', judgment: null, submitted: new Set(), request: null, pausedAt: null };
    let panel, timer, fields, status, recent, verdict;
    const boundDocs = new WeakSet();
    function courseMatches() {
      const walker = doc.createTreeWalker(doc.body, 4), parts = [doc.title];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.parentElement?.closest('#' + PANEL_ID + ',script,style')) parts.push(node.nodeValue);
      }
      return clean(parts.join(' ')).includes(COURSE);
    }
    function render() {
      if (!panel) return;
      status.textContent = state.phase;
      recent.textContent = state.lastResult || '暂无答题记录';
      verdict.hidden = !state.judgment;
      if (!state.judgment) {
        verdict.textContent = '';
        verdict.style.display = 'none';
      } else {
        const looks = {
          correct: ['✅ 答对了（平台判定）', '#166534', '#edf9f0', '#a7dcb8'],
          wrong: ['❌ 答错了（平台判定）', '#b91c1c', '#fff0f0', '#efb2b2'],
          unknown: ['⚠️ 平台结果未确认', '#92400e', '#fff8e5', '#ecd390'],
        };
        const [label, color, background, border] = looks[state.judgment];
        verdict.textContent = label;
        verdict.style.cssText = `display:block;padding:9px;margin-top:9px;border:1px solid ${border};border-radius:6px;font-weight:bold;color:${color};background:${background}`;
      }
      fields.start.disabled = state.active || state.busy;
      fields.stop.disabled = !state.active;
      fields.token.disabled = state.active; fields.port.disabled = state.active;
    }
    function phase(text) { state.phase = text; render(); }
    function pause(reason = '已手动暂停', notify = false) {
      state.active = false; state.generation++;
      state.request?.abort?.(); state.request = null;
      phase(reason);
      if (notify) {
        try { gm.notification?.({ title: 'MOOC 弹题助手已暂停', text: reason.slice(0, 250), timeout: 10000 }); } catch { /* Panel still displays error. */ }
      }
    }
    function request(path, body, generation) {
      const port = Number(fields.port.value), token = fields.token.value.trim();
      return new Promise((ok, fail) => {
        const handle = gm.request({ url: `http://127.0.0.1:${port}${path}`, method: body ? 'POST' : 'GET',
          headers: { 'X-MOOC-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          data: body ? JSON.stringify(body) : undefined, timeout: 125000,
          onload(response) {
            if (generation !== state.generation) return fail(new Error('操作已取消。'));
            let data;
            try { data = JSON.parse(response.responseText); } catch { return fail(new Error('本机服务返回格式无效。')); }
            if (response.status < 200 || response.status >= 300) return fail(new Error(data.error?.message || `本机服务 HTTP ${response.status}`));
            state.request = null; ok(data);
          },
          onerror() { fail(new Error('无法连接本机服务。请先打开启动.cmd，并检查端口。')); },
          ontimeout() { fail(new Error('本机服务请求超时，已暂停。')); },
          onabort() { fail(new Error('操作已取消。')); },
        });
        state.request = handle;
      });
    }
    const current = generation => state.active && state.generation === generation;
    const sleep = ms => new Promise(ok => win.setTimeout(ok, ms));
    async function waitUntil(check, timeout, generation, message) {
      const end = Date.now() + timeout;
      while (current(generation) && Date.now() < end) {
        const value = check(); if (value) return value;
        await sleep(timing.poll);
      }
      if (!current(generation)) throw new Error('操作已取消。');
      throw new Error(message);
    }
    function checkedLive(original) {
      if (!courseMatches()) throw new Error('页面已离开目标课程，已暂停。');
      const live = readQuiz(doc, COURSE);
      if (live?.kind !== 'question' || identity(live) !== identity(original) || live.container !== original.container ||
          live.options.some((o, index) => o.control !== original.options[index].control) ||
          live.options.some(o => o.control.disabled) || live.submit.disabled) throw new Error('题目、选项或弹窗状态已变化，已暂停。');
      return live;
    }
    function videos() {
      return documents(doc).flatMap(d => [...d.querySelectorAll('video')]).filter(visible);
    }
    async function continuePlayback(result, generation) {
      if (!current(generation)) return;
      phase('答案已确认，正在继续学习…');
      result.button.click();
      await waitUntil(() => !readQuiz(doc, COURSE), timing.result, generation, '继续学习后弹窗未关闭，已暂停。');
      const video = await waitUntil(() => {
        const list = videos(); return list.length === 1 ? list[0] : null;
      }, timing.playback, generation, '无法唯一确认视频播放器，需人工检查。');
      if (!current(generation)) return;
      if (video.paused) {
        try { await video.play(); } catch { throw new Error('浏览器阻止了自动播放，请手动播放后再开始。'); }
      }
      const before = video.currentTime;
      await waitUntil(() => !video.paused && (video.currentTime > before + 0.05 || video.ended), timing.playback, generation,
        '视频没有恢复播放，可能正在缓冲或被浏览器阻止。');
      state.question = null; state.answer = null; state.pausedAt = null;
      phase('监测中，等待下一道弹题');
    }
    async function handleResult(result, generation) {
      const feedback = readFeedback(result.button, state.question, state.answer?.optionIds);
      state.judgment = feedback.outcome;
      const outcomeText = { correct: '答对了', wrong: '答错了', unknown: '平台结果未确认' }[feedback.outcome];
      const details = [`答题结果：${outcomeText}`];
      if (state.question) details.push(`题目：${state.question.stem}`);
      details.push(`你的答案：${state.answer?.optionIds.join('、') || '手动作答'}`);
      if (feedback.correctOptionIds.length) details.push(`正确答案：${feedback.correctOptionIds.join('、')}`);
      else if (feedback.outcome !== 'correct') details.push('未读到明确的正确答案，请查看平台反馈。');
      state.lastResult = details.join('\n');
      render(); // Show the platform result even if saving the confirmed answer subsequently fails.
      if (feedback.correctOptionIds.length && state.question) {
        await request('/feedback', { question: wireQuestion(state.question), correctOptionIds: feedback.correctOptionIds }, generation);
      }
      if (!current(generation)) return;
      if (feedback.outcome === 'wrong') throw new Error('平台显示答错，已记录可读取的正确答案；请人工处理后继续。');
      if (feedback.outcome !== 'correct') throw new Error('无法确认平台判题结果，已暂停，请人工检查。');
      render(); await continuePlayback(result, generation);
    }
    async function answerQuestion(q, generation) {
      if (state.submitted.has(semanticIdentity(q))) throw new Error('这道题在本次运行中已提交过，停止重复提交。');
      if (q.options.some(o => o.initiallySelected)) throw new Error('题目已有选择，请先人工处理，避免覆盖你的答案。');
      state.question = q; state.answer = null; state.judgment = null;
      state.lastResult = `当前题目：${q.stem}\n正在请求答案…`;
      phase('正在读取题目并请求答案…');
      const answer = validateAnswer(await request('/solve', { question: wireQuestion(q) }, generation), q);
      if (!current(generation)) return;
      let live = checkedLive(q);
      if (live.options.some(o => selected(o.control))) throw new Error('请求答案期间选项被修改，已暂停。');
      state.answer = answer;
      state.lastResult = `${answer.source === 'cache' ? '已确认题库' : 'AI'}建议：${answer.optionIds.join('、')}。${answer.reason || ''}`;
      phase('正在选择答案…');
      for (const option of live.options) {
        if (!current(generation)) return;
        if (answer.optionIds.includes(option.id)) option.control.click();
      }
      live = checkedLive(q);
      const chosen = live.options.filter(o => selected(o.control)).map(o => o.id).sort();
      if (chosen.join('') !== [...answer.optionIds].sort().join('')) throw new Error('无法验证勾选结果，已停止提交。');
      if (!current(generation)) return;
      state.submitted.add(semanticIdentity(q)); // Set BEFORE clicking, including ambiguous submit outcomes.
      phase('正在提交，等待平台反馈…');
      live.submit.click();
      const result = await waitUntil(() => {
        const quiz = readQuiz(doc, COURSE);
        if (quiz && quiz.kind === 'question' && identity(quiz) !== identity(q)) throw new Error('提交后出现了另一道题，需人工确认上一题结果。');
        return quiz?.kind === 'result' ? quiz : null;
      }, timing.result, generation, '提交后未读到判题结果，停止重试，请人工检查。').catch(error => {
        if (current(generation)) {
          state.judgment = 'unknown';
          state.lastResult = `答题结果：平台结果未确认\n你的答案：${answer.optionIds.join('、')}\n${error.message}`;
          render();
        }
        throw error;
      });
      await handleResult(result, generation);
    }
    function handleUserInteraction(event) {
      if (!state.active || !event.isTrusted || panel?.contains(event.target)) return;
      let onResult = false;
      try {
        const quiz = readQuiz(doc, COURSE);
        onResult = quiz?.kind === 'result' && (quiz.button === event.target || quiz.button.contains(event.target));
      } catch { /* scan will pause unsupported layouts. */ }
      if (state.question?.container.contains(event.target) || event.target?.tagName === 'VIDEO' || onResult) {
        pause('检测到人工操作，已暂停自动答题。');
      }
    }
    function bindDocuments() {
      for (const d of documents(doc)) if (!boundDocs.has(d)) {
        boundDocs.add(d);
        d.addEventListener('pointerdown', handleUserInteraction, true);
        d.addEventListener('keydown', handleUserInteraction, true);
      }
    }
    async function scan() {
      if (!state.active || state.busy) return;
      const generation = state.generation;
      state.busy = true; render();
      try {
        if (!courseMatches()) throw new Error('页面已离开目标课程，已暂停。');
        bindDocuments();
        let q;
        try { q = readQuiz(doc, COURSE); }
        catch (error) {
          state.judgment = null;
          state.lastResult = `当前题目尚未提交。\n题目识别失败：${error.message}`;
          throw error;
        }
        if (q?.kind === 'question') await answerQuestion(q, generation);
        else if (q?.kind === 'result') await handleResult(q, generation);
        else {
          state.question = null;
          const list = videos();
          if (list.length === 1 && list[0].paused && !list[0].ended) {
            state.pausedAt ??= Date.now();
            if (Date.now() - state.pausedAt >= timing.paused) throw new Error('视频持续暂停，但未发现可识别弹题；请人工检查。');
          } else if (!list.length) {
            state.pausedAt ??= Date.now();
            if (Date.now() - state.pausedAt >= timing.paused) throw new Error('无法读取视频播放器，可能位于跨域框架中，需适配页面。');
          } else state.pausedAt = null;
        }
      } catch (error) { if (current(generation)) pause(error.message, true); }
      finally { state.busy = false; render(); }
    }
    async function start() {
      if (state.active || state.busy) return;
      const token = fields.token.value.trim(), port = Number(fields.port.value);
      if (!/^[a-f0-9]{48}$/.test(token)) return pause('请填写启动窗口中的 48 位连接码（不是 API key）。');
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return pause('端口无效。');
      if (!courseMatches()) return pause('未确认目标课程：中国文化传承与科技创新。请打开该课程的视频页。');
      gm.setValue('localToken', token); gm.setValue('localPort', port);
      state.active = true; state.generation++; state.pausedAt = null;
      const generation = state.generation;
      state.busy = true; phase('正在连接本机服务…');
      try {
        const health = await request('/health', null, generation);
        if (!health.ready) throw new Error('本机服务未配置 API 密钥。');
        if (current(generation)) phase(`监测中（${health.model}）`);
      } catch (error) { if (current(generation)) pause(error.message, true); }
      finally { state.busy = false; render(); }
      if (current(generation)) await scan();
    }
    function diagnose() {
      try {
        const quiz = readQuiz(doc, COURSE);
        if (quiz?.kind === 'question') state.judgment = null;
        state.lastResult = quiz?.kind === 'question' ? `只读检查成功：${quiz.isJudgment ? '判断题' : quiz.type === 'single' ? '单选' : '多选'}；题干：${quiz.stem}\n${quiz.options.map(o => o.id + '. ' + o.text).join('\n')}` :
          quiz?.kind === 'result' ? '发现“继续学习”按钮。当前为判题结果界面。' :
          `未发现答题弹窗。可读页面数：${documents(doc).length}；可见视频数：${videos().length}。`;
      } catch (error) { state.judgment = null; state.lastResult = '只读检查：' + error.message; }
      render();
    }
    function mount() {
      if (doc.getElementById(PANEL_ID)) return false;
      panel = doc.createElement('aside'); panel.id = PANEL_ID;
      panel.style.cssText = 'position:fixed;right:16px;top:150px;width:300px;z-index:2147483000;background:white;color:#222;padding:14px;border:1px solid #ccc;border-radius:10px;box-shadow:0 4px 18px #0003;font:13px/1.6 sans-serif;max-height:70vh;overflow:auto;text-align:left';
      panel.innerHTML = '<strong>MOOC 视频弹题助手</strong><div style="color:#666">仅支持：中国文化传承与科技创新</div>' +
        '<label style="display:block;margin-top:8px">本机连接码（不是 API key）<input data-field="token" type="password" autocomplete="off" style="box-sizing:border-box;width:100%"></label>' +
        '<label>本机端口 <input data-field="port" type="number" min="1024" max="65535" style="width:90px"></label>' +
        '<div style="margin:10px 0;display:flex;gap:6px"><button data-field="start">开始</button><button data-field="stop">暂停</button><button data-field="check">检查页面</button></div>' +
        '<div data-field="status" role="status" style="white-space:pre-wrap"></div><div data-field="verdict" role="status" hidden></div><details style="margin-top:8px" open><summary>最近结果</summary><div data-field="recent" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto"></div></details>' +
        '<small style="color:#777">AI 可能答错；不确定、答错或异常时会暂停。</small>';
      doc.body.append(panel);
      const field = name => panel.querySelector(`[data-field="${name}"]`);
      fields = { token: field('token'), port: field('port'), start: field('start'), stop: field('stop') };
      status = field('status'); recent = field('recent'); verdict = field('verdict');
      fields.token.value = gm.getValue('localToken', ''); fields.port.value = gm.getValue('localPort', 17863);
      fields.start.addEventListener('click', () => { void start(); });
      fields.stop.addEventListener('click', () => pause());
      field('check').addEventListener('click', diagnose);
      bindDocuments(); render(); timer = win.setInterval(() => { void scan(); }, timing.tick);
      win.addEventListener('pagehide', () => { pause('页面已离开'); win.clearInterval(timer); });
      return true;
    }
    return { mount, start, pause, scan, state, diagnose, handleUserInteraction,
      destroy() { pause(); win.clearInterval(timer); panel?.remove(); } };
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { createApp, readQuiz, readFeedback, wireQuestion, validateAnswer, selected, identity, semanticIdentity };
  } else {
    createApp(window, { request: options => GM_xmlhttpRequest(options), getValue: (key, fallback) => GM_getValue(key, fallback),
      setValue: (key, value) => GM_setValue(key, value),
      notification: options => { if (typeof GM_notification === 'function') GM_notification(options); } }).mount();
  }
})();
