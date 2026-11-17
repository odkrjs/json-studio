import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333;
const profile = mkdtempSync(path.join(tmpdir(), 'jsonstudio-ui-'));
const pageURL = `file://${path.join(root, 'Resources', 'index.html')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
let chrome;
let ws;
let sequence = 0;
const pending = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function waitFor(fn, timeout = 6000, interval = 80) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return;
    await sleep(interval);
  }
  throw new Error('Timed out waiting for condition');
}

async function send(method, params = {}) {
  const id = ++sequence;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(payload);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 10000);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`Page exception: ${description}`);
  }
  return result.result.value;
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join('/tmp', name);
  writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log(`screenshot: ${file}`);
}

async function setPane(pane, text) {
  await evaluate(`(() => {
    const input = document.querySelector('#editorHost${pane.toUpperCase()} .code-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value.length;
  })()`);
  await sleep(250);
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await sleep(160);
}

async function main() {
  chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,920',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    pageURL
  ], { stdio: 'ignore' });

  let target = null;
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      return !!target;
    } catch (_) {
      return false;
    }
  }, 10000);

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text || 'Runtime exception');
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(message.params.entry.text);
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await waitFor(() => evaluate("document.documentElement.dataset.ready === 'true'"), 10000);
  await sleep(300);

  console.log('Initial state:', await evaluate(`({
    title: document.title,
    badgeA: document.querySelector('#badgeA').textContent.trim(),
    treeRows: document.querySelectorAll('.tree-row').length,
    lines: document.querySelectorAll('.line-number').length,
    mode: document.body.dataset.mode
  })`));
  assert(await evaluate("document.querySelector('#badgeA .status-text').textContent === '有效 JSON'"), 'sample A should be valid');
  assert(await evaluate("document.querySelectorAll('.tree-row').length > 5"), 'tree should have rows');
  await screenshot('jsonstudio-format-final.png');

  // Tree expand/collapse
  const beforeExpand = await evaluate("document.querySelectorAll('.tree-row').length");
  await click('#treeExpandBtn');
  const afterExpand = await evaluate("document.querySelectorAll('.tree-row').length");
  assert(afterExpand > beforeExpand, 'expand all should add tree rows');
  await click('#treeCollapseBtn');
  assert((await evaluate("document.querySelectorAll('.tree-row').length")) === 1, 'collapse all should leave the root row');
  await click('#treeExpandBtn');

  // Format and minify
  await setPane('a', '{"b":2,"a":1,"nested":{"x":true}}');
  assert(await evaluate("document.querySelector('#badgeA .status-text').textContent === '有效 JSON'"), 'compact JSON should be valid');
  await click('.js-format[data-pane="a"]');
  const formatted = await evaluate("document.querySelector('#editorHostA .code-input').value");
  assert(formatted.includes('\n  "b": 2') && formatted.includes('\n  "a": 1'), 'format should pretty-print');
  await click('.js-minify[data-pane="a"]');
  const minified = await evaluate("document.querySelector('#editorHostA .code-input').value");
  assert(minified === '{"b":2,"a":1,"nested":{"x":true}}', `minify mismatch: ${minified}`);

  // Programmatic formatting must still be undoable.
  const undoResult = await evaluate("document.execCommand('undo')");
  await sleep(180);
  const afterUndo = await evaluate("document.querySelector('#editorHostA .code-input').value");
  console.log('Undo result:', undoResult, afterUndo.slice(0, 40).replace(/\n/g, '\\n'));
  assert(afterUndo.includes('\n  "b": 2'), 'format/minify should create an undoable edit');

  // Unescape modal
  const escaped = '{\\"name\\":\\"张三\\",\\"nested\\":{\\"ok\\":true}}';
  await setPane('a', escaped);
  assert(await evaluate("document.querySelector('#badgeA .status-text').textContent !== '有效 JSON'"), 'escaped doc should be invalid JSON');
  await click('.js-unescape[data-pane="a"]');
  await waitFor(() => evaluate("document.querySelector('#unescapeModal').hidden === false"));
  await evaluate(`(() => {
    const input = document.querySelector('#unescapeInput');
    input.value = ${JSON.stringify(escaped)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const unescapeOutput = await evaluate("document.querySelector('#unescapeOutput').value");
  assert(unescapeOutput.includes('"name": "张三"') && unescapeOutput.includes('"ok": true'), 'raw unescape output should be formatted JSON');
  await screenshot('jsonstudio-unescape.png');
  await click('#unescapeApply');
  await sleep(300);
  assert(await evaluate("document.querySelector('#unescapeModal').hidden === true"), 'unescape modal should close');
  assert(await evaluate("document.querySelector('#badgeA .status-text').textContent === '有效 JSON'"), 'unescape result should be valid');
  assert(await evaluate("document.querySelectorAll('.tree-row').length > 1"), 'tree should render unescaped JSON');

  // Nested JSON unescape
  await click('.js-unescape[data-pane="a"]');
  await waitFor(() => evaluate("document.querySelector('#unescapeModal').hidden === false"));
  await evaluate(`(() => {
    const input = document.querySelector('#unescapeInput');
    input.value = JSON.stringify({ id: 7, payload: JSON.stringify({ user: '张三', admin: true }) });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-unescape-mode="nested"]').click();
  })()`);
  await sleep(250);
  const nestedOutput = await evaluate("document.querySelector('#unescapeOutput').value");
  const nestedNote = await evaluate("document.querySelector('#unescapeNote').textContent");
  assert(nestedOutput.includes('"user": "张三"'), 'nested unescape should expand payload');
  assert(nestedNote.includes('1 个嵌套'), `nested note should report count: ${nestedNote}`);
  await click('.modal-close');

  // Compare sample
  await evaluate('window.JSONStudio.loadCompareSample()');
  await sleep(500);
  assert(await evaluate("document.body.dataset.mode === 'compare'"), 'should be in compare mode');
  const compareInfo = await evaluate(`({
    banner: document.querySelector('.headline-text strong').textContent,
    chips: document.querySelector('#diffStats').textContent.replace(/\\s+/g, ' ').trim(),
    rows: document.querySelectorAll('.diff-row').length,
    badge: document.querySelector('#diffBadge .status-text').textContent
  })`);
  console.log('Compare state:', compareInfo);
  assert(compareInfo.banner.includes('6 处差异'), 'sample should produce six differences');
  assert(compareInfo.badge.includes('6 处差异'), 'diff badge should show count');
  assert(compareInfo.rows >= 6, 'diff rows should render');
  await screenshot('jsonstudio-compare-final.png');

  // Only differences toggle
  const onlyRows = await evaluate("document.querySelectorAll('.diff-row').length");
  await evaluate("document.querySelector('#onlyDiff').click()");
  await sleep(250);
  const fullRows = await evaluate("document.querySelectorAll('.diff-row').length");
  assert(fullRows > onlyRows, 'disabling only-diff should show unchanged nodes');
  await evaluate("document.querySelector('#onlyDiff').click()");
  await sleep(180);

  // Semantic equality with different key order
  await setPane('a', '{"a":1,"b":{"c":2,"d":3},"arr":[1,2]}');
  await setPane('b', '{"b":{"d":3,"c":2},"arr":[1,2],"a":1}');
  await sleep(400);
  const equalInfo = await evaluate(`({
    banner: document.querySelector('.headline-text strong').textContent,
    sub: document.querySelector('.headline-text span').textContent,
    equal: document.querySelector('.diff-banner').classList.contains('is-equal'),
    hero: !!document.querySelector('.equal-hero')
  })`);
  console.log('Equal state:', equalInfo);
  assert(equalInfo.equal, 'reordered keys should compare equal');
  assert(equalInfo.banner.includes('一致'), 'equal banner should say equal');
  assert(equalInfo.sub.includes('key 顺序'), 'should mention key order');
  assert(equalInfo.hero, 'equal hero should render');
  await screenshot('jsonstudio-equal.png');

  // Array order is significant
  await setPane('a', '[1,2,3]');
  await setPane('b', '[1,3,2]');
  await sleep(350);
  assert(await evaluate("!document.querySelector('.diff-banner').classList.contains('is-equal')"), 'array order should matter');
  console.log('Array diff DOM:', await evaluate(`({
    a: document.querySelector('#editorHostA .code-input').value,
    b: document.querySelector('#editorHostB .code-input').value,
    rows: Array.from(document.querySelectorAll('.diff-row')).map(r => r.className + ' | ' + r.textContent.trim()),
    banner: document.querySelector('.diff-banner').className
  })`));
  assert(await evaluate("document.querySelectorAll('.diff-row.status-changed').length >= 2"), 'array swaps should show changes');

  // Error state
  await setPane('a', '{"broken":}');
  await sleep(350);
  const errorInfo = await evaluate(`({
    bannerError: document.querySelector('.diff-banner').classList.contains('is-error'),
    badge: document.querySelector('#badgeA .status-text').textContent,
    errorText: document.querySelector('#diffBody').textContent
  })`);
  assert(errorInfo.bannerError, 'invalid JSON should set error banner');
  assert(errorInfo.badge.includes('错误'), 'badge should show error');
  assert(errorInfo.errorText.includes('暂时无法比较'), 'error card should render');
  await screenshot('jsonstudio-error.png');

  // Restore and dark mode screenshot
  await evaluate('window.JSONStudio.loadCompareSample()');
  await sleep(500);
  await evaluate("window.JSONStudio.setMode('format')");
  await sleep(250);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(400);
  await screenshot('jsonstudio-dark.png');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  const fatal = errors.filter((entry) => !/favicon|Failed to load resource/i.test(entry));
  if (fatal.length) {
    throw new Error(`Browser errors: ${fatal.join(' | ')}`);
  }
  console.log('UI checks passed.');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch (_) {}
  try { chrome?.kill('SIGTERM'); } catch (_) {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
