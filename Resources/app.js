(function () {
  'use strict';

  const C = window.JSONCore;
  if (!C) {
    document.body.innerHTML = '<div style="padding:40px;font-family:-apple-system">JSON 引擎加载失败，请重新安装应用。</div>';
    return;
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const MAX_RENDER_ROWS = 8000;

  const SAMPLE_COMPARE_A = `{
  "orderId": "SO-2026-001",
  "status": "pending",
  "customer": {
    "name": "林小满",
    "vip": false,
    "tags": ["new"]
  },
  "items": [
    { "sku": "A-100", "qty": 2, "price": 39.9 },
    { "sku": "B-200", "qty": 1, "price": 128 }
  ],
  "meta": {
    "source": "web",
    "payload": "{\\"event\\":\\"order.created\\",\\"id\\":\\"42\\"}"
  },
  "total": 207.8
}`;

  const SAMPLE_COMPARE_B = `{
  "status": "paid",
  "orderId": "SO-2026-001",
  "customer": {
    "vip": true,
    "name": "林小满",
    "tags": ["new", "priority"]
  },
  "items": [
    { "sku": "A-100", "price": 35.9, "qty": 2 },
    { "sku": "B-200", "qty": 1, "price": 128 }
  ],
  "coupon": {
    "code": "WELCOME10",
    "discount": 10
  },
  "meta": {
    "payload": "{\\"event\\":\\"order.created\\",\\"id\\":\\"42\\"}",
    "source": "web"
  },
  "total": 207.8
}`;

  const SAMPLE_FORMAT = `{
  "service": "json-studio",
  "version": "1.0.0",
  "enabled": true,
  "owner": {
    "name": "DevTools",
    "team": "Developer Experience",
    "contact": "devtools@example.com"
  },
  "features": {
    "treeView": true,
    "semanticDiff": true,
    "unescape": true,
    "maxDepth": 64
  },
  "endpoints": [
    { "method": "POST", "path": "/v1/format", "auth": true },
    { "method": "POST", "path": "/v1/compare", "auth": true }
  ],
  "tags": ["macOS", "JSON", "Developer Tool"],
  "deprecated": null
}`;

  const state = {
    mode: 'format',
    activePane: 'a',
    parsed: { a: null, b: null },
    errors: { a: null, b: null },
    empty: { a: true, b: true },
    treeExpanded: new Set(),
    resetTree: true,
    treeRows: new Map(),
    diff: null,
    diffKey: null,
    diffExpanded: null,
    diffMs: 0,
    onlyDiff: true,
    importPane: 'a',
    unescapePane: 'a',
    unescapeMode: 'raw',
    unescapeResult: null,
    timers: { a: null, b: null },
    unescapeTimer: null,
    toastTimer: null,
    lastFocus: null
  };

  let editors = {};
  let dom = {};

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function icon(name) {
    return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function esc(value) {
    return C.escapeHTML(value == null ? '' : String(value));
  }

  function setStatusBadge(el, kind, text, title = '') {
    if (!el) return;
    el.className = `status-badge is-${kind}`;
    el.innerHTML = '<span class="status-dot"></span><span class="status-text"></span>';
    $('.status-text', el).textContent = text;
    el.title = title || text;
  }

  function setText(el, text) {
    if (el) el.textContent = text == null ? '' : String(text);
  }

  function showToast(message, type = 'success', duration = 2300) {
    if (!dom.toast) return;
    clearTimeout(state.toastTimer);
    dom.toast.classList.toggle('is-error', type === 'error');
    const use = dom.toast.querySelector('.toast-icon use');
    if (use) use.setAttribute('href', type === 'error' ? '#i-alert' : '#i-check');
    setText(dom.toastText, message);
    dom.toast.hidden = false;
    // Restart the entrance animation when a toast is already visible.
    dom.toast.style.animation = 'none';
    void dom.toast.offsetWidth;
    dom.toast.style.animation = '';
    state.toastTimer = setTimeout(() => { dom.toast.hidden = true; }, duration);
  }

  function nativeLog(level, message) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.appLog) {
        window.webkit.messageHandlers.appLog.postMessage({ level, message: String(message) });
      }
    } catch (_) {}
  }

  async function copyText(text, message = '已复制到剪贴板') {
    if (text == null || text === '') {
      showToast('没有可复制的内容', 'error');
      return false;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch (_) {
      try {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        helper.style.pointerEvents = 'none';
        document.body.appendChild(helper);
        helper.select();
        const ok = document.execCommand('copy');
        helper.remove();
        if (!ok) throw new Error('execCommand copy failed');
      } catch (error) {
        nativeLog('error', `copy failed: ${error.message}`);
        showToast('复制失败，请手动选择文本', 'error');
        return false;
      }
    }
    showToast(message);
    return true;
  }

  function lineCount(text) {
    return text === '' ? 1 : text.split('\n').length;
  }

  function formatTime(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1) return '< 1 ms';
    if (ms < 100) return `${ms.toFixed(1)} ms`;
    return `${Math.round(ms)} ms`;
  }

  // ---------------------------------------------------------------------------
  // Code editor
  // ---------------------------------------------------------------------------

  class CodeEditor {
    constructor(host, pane) {
      this.host = host;
      this.pane = pane;
      this.shell = $('.editor-shell', host);
      this.input = $('.code-input', host);
      this.highlight = $('.code-highlight', host);
      this.gutterInner = $('.gutter-inner', host);
      this.panel = host.closest('.editor-panel');
      this.lineCount = 0;
      this.activeLine = 1;
      this.errorLine = null;
      this.dragDepth = 0;
      this.onChange = null;
      this.onCursor = null;
      this.onFocus = null;
      this.onFile = null;
      this.bind();
      this.refresh();
    }

    bind() {
      this.input.addEventListener('input', () => {
        this.refresh();
        if (this.onChange) this.onChange(this.pane);
      });
      this.input.addEventListener('scroll', () => this.syncScroll(), { passive: true });
      this.input.addEventListener('keydown', (event) => this.handleKeyDown(event));
      this.input.addEventListener('focus', () => {
        if (this.onFocus) this.onFocus(this.pane);
        this.updateCursor();
      });
      ['click', 'keyup', 'select'].forEach((type) => {
        this.input.addEventListener(type, () => this.updateCursor());
      });
      window.addEventListener('resize', () => this.syncScroll());

      this.shell.addEventListener('dragenter', (event) => {
        if (!this.hasFiles(event)) return;
        event.preventDefault();
        this.dragDepth += 1;
        this.shell.classList.add('is-dragging');
      });
      this.shell.addEventListener('dragover', (event) => {
        if (!this.hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      });
      this.shell.addEventListener('dragleave', (event) => {
        event.preventDefault();
        this.dragDepth = Math.max(0, this.dragDepth - 1);
        if (this.dragDepth === 0) this.shell.classList.remove('is-dragging');
      });
      this.shell.addEventListener('drop', (event) => {
        event.preventDefault();
        this.dragDepth = 0;
        this.shell.classList.remove('is-dragging');
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file && this.onFile) this.onFile(file, this.pane);
      });
    }

    hasFiles(event) {
      const types = event.dataTransfer && event.dataTransfer.types;
      if (!types) return false;
      return Array.from(types).includes('Files');
    }

    getText() {
      return this.input.value;
    }

    setText(text, options = {}) {
      const { undo = false, silent = false, resetScroll = false } = options;
      const previous = this.input.value;
      if (previous === text) {
        this.refresh();
        if (resetScroll) this.resetScroll();
        return;
      }

      if (undo) {
        this.input.focus();
        this.input.select();
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, text);
        } catch (_) {
          inserted = false;
        }
        if (!inserted || this.input.value !== text) {
          this.input.value = text;
          this.refresh();
          if (!silent) this.emitChange();
        }
      } else {
        this.input.value = text;
        this.refresh();
        if (!silent) this.emitChange();
      }

      this.input.setSelectionRange(0, 0);
      this.updateCursor();
      if (resetScroll) this.resetScroll();
      this.syncScroll();
    }

    emitChange() {
      if (this.onChange) this.onChange(this.pane);
    }

    resetScroll() {
      this.input.scrollTop = 0;
      this.input.scrollLeft = 0;
      this.syncScroll();
    }

    refresh() {
      const value = this.input.value;
      if (value.length > 1_500_000) {
        this.highlight.textContent = value || ' ';
      } else {
        this.highlight.innerHTML = C.highlightJSON(value) + (value.endsWith('\n') ? '\n' : '');
        if (!this.highlight.innerHTML) this.highlight.innerHTML = ' ';
      }
      this.renderGutter(value);
      this.syncScroll();
      this.updateCursor();
    }

    renderGutter(value) {
      const lines = lineCount(value);
      if (lines !== this.lineCount) {
        const limit = Math.min(lines, 20000);
        const parts = [];
        for (let n = 1; n <= limit; n++) {
          parts.push(`<div class="line-number" data-line="${n}">${n}</div>`);
        }
        if (lines > limit) parts.push('<div class="line-number">…</div>');
        this.gutterInner.innerHTML = parts.join('');
        this.lineCount = lines;
      }
      this.paintGutterState();
    }

    paintGutterState() {
      $$('.line-number.is-active, .line-number.is-error', this.gutterInner).forEach((el) => {
        el.classList.remove('is-active', 'is-error');
      });
      const active = this.gutterInner.querySelector(`[data-line="${this.activeLine}"]`);
      if (active) active.classList.add('is-active');
      if (this.errorLine) {
        const error = this.gutterInner.querySelector(`[data-line="${this.errorLine}"]`);
        if (error) error.classList.add('is-error');
      }
    }

    syncScroll() {
      const x = this.input.scrollLeft;
      const y = this.input.scrollTop;
      this.highlight.style.transform = `translate(${-x}px, ${-y}px)`;
      this.gutterInner.style.transform = `translateY(${-y}px)`;
    }

    updateCursor() {
      const value = this.input.value;
      const pos = this.input.selectionStart;
      const before = value.slice(0, pos);
      const lastBreak = before.lastIndexOf('\n');
      const line = before.split('\n').length;
      const column = pos - lastBreak;
      const selected = Math.abs(this.input.selectionEnd - pos);
      if (line !== this.activeLine) {
        this.activeLine = line;
        this.paintGutterState();
      }
      if (this.onCursor) {
        this.onCursor(this.pane, {
          line,
          column,
          selected,
          pos,
          length: value.length
        });
      }
    }

    setError(error) {
      this.errorLine = error ? error.line : null;
      this.input.setAttribute('aria-invalid', error ? 'true' : 'false');
      this.paintGutterState();
    }

    focusAt(index) {
      const clamped = Math.max(0, Math.min(index == null ? 0 : index, this.input.value.length));
      this.input.focus();
      this.input.setSelectionRange(clamped, clamped);
      const line = C.lineColumnAt(this.input.value, clamped).line;
      const lineHeight = 21;
      this.input.scrollTop = Math.max(0, (line - 1) * lineHeight - this.input.clientHeight / 2);
      this.syncScroll();
      this.updateCursor();
    }

    handleKeyDown(event) {
      if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      const value = this.input.value;
      const start = this.input.selectionStart;
      const end = this.input.selectionEnd;

      const blockStart = value.lastIndexOf('\n', start - 1) + 1;
      const blockEnd = end;
      const hasMultipleLines = value.slice(start, end).includes('\n');

      if (!event.shiftKey && !hasMultipleLines && start === end) {
        this.input.setRangeText('  ', start, end, 'end');
        this.afterProgrammaticEdit();
        return;
      }

      const lines = value.slice(blockStart, blockEnd).split('\n');
      let replacement;
      if (event.shiftKey) {
        replacement = lines.map((line) => line.replace(/^ {1,2}/, '')).join('\n');
      } else {
        replacement = lines.map((line) => '  ' + line).join('\n');
      }
      const oldLength = blockEnd - blockStart;
      this.input.setRangeText(replacement, blockStart, blockEnd, 'end');
      this.input.setSelectionRange(blockStart + (event.shiftKey ? 0 : 2), blockStart + replacement.length);
      if (oldLength === 0) this.input.setSelectionRange(blockStart + 2, blockStart + 2);
      this.afterProgrammaticEdit();
    }

    afterProgrammaticEdit() {
      this.refresh();
      this.emitChange();
    }
  }

  // ---------------------------------------------------------------------------
  // Pane parsing and badges
  // ---------------------------------------------------------------------------

  function updatePaneBadge(pane) {
    const badge = pane === 'a' ? dom.badgeA : dom.badgeB;
    if (state.empty[pane]) {
      setStatusBadge(badge, 'neutral', '等待输入', '等待输入 JSON');
      return;
    }
    if (state.errors[pane]) {
      const error = state.errors[pane];
      setStatusBadge(
        badge,
        'error',
        `第 ${error.line} 行错误`,
        `第 ${error.line} 行第 ${error.column} 列：${error.message}`
      );
      return;
    }
    const parsed = state.parsed[pane];
    setStatusBadge(badge, 'valid', '有效 JSON', `${C.typeLabel(parsed)} · 语法有效`);
  }

  function updatePaneMeta(pane) {
    const meta = pane === 'a' ? dom.metaA : dom.metaB;
    const text = editors[pane].getText();
    if (!text) {
      setText(meta, '0 B');
      return;
    }
    setText(meta, `${C.formatBytes(C.byteLength(text))} · ${lineCount(text)} 行`);
  }

  function updateCursorInfo(pane, info) {
    const el = pane === 'a' ? dom.cursorA : dom.cursorB;
    if (!el) return;
    let text = `第 ${info.line} 行，第 ${info.column} 列`;
    if (info.selected > 0) text += ` · 选中 ${info.selected} 字符`;
    setText(el, text);
  }

  function refreshPane(pane) {
    const editor = editors[pane];
    const text = editor.getText();
    const wasParsed = !!state.parsed[pane];
    const empty = text.trim() === '';
    let parsed = null;
    let error = null;

    if (!empty) {
      try {
        parsed = C.parseJSON(text);
      } catch (caught) {
        if (caught && caught.name === 'JSONParseError') error = caught;
        else {
          error = new C.JSONParseError(caught.message || 'JSON 解析失败', 0, 1, 1);
        }
      }
    }

    state.parsed[pane] = parsed;
    state.errors[pane] = error;
    state.empty[pane] = empty;
    editor.setError(error);
    updatePaneBadge(pane);
    updatePaneMeta(pane);

    if (pane === 'a' && state.mode === 'format') {
      if (empty) {
        renderTreeEmpty();
      } else if (error) {
        renderTreeError(error);
      } else {
        if (!wasParsed || state.resetTree) {
          state.treeExpanded = C.defaultTreeExpanded(parsed);
          state.resetTree = false;
        }
        renderTree();
      }
    }

    return { parsed, error, empty };
  }

  function scheduleRefresh(pane) {
    clearTimeout(state.timers[pane]);
    state.timers[pane] = setTimeout(() => {
      refreshPane(pane);
      if (state.mode === 'compare') renderCompare();
    }, 130);
  }

  function refreshNow(pane) {
    clearTimeout(state.timers[pane]);
    refreshPane(pane);
    if (state.mode === 'compare') renderCompare();
  }

  function refreshAll() {
    refreshPane('a');
    refreshPane('b');
    if (state.mode === 'compare') renderCompare();
  }

  // ---------------------------------------------------------------------------
  // Tree view
  // ---------------------------------------------------------------------------

  function treeRowHTML(row) {
    const node = row.node;
    const depth = Math.min(row.depth, 30);
    const isContainer = C.isContainer(node);
    const expanded = isContainer && state.treeExpanded.has(row.path);
    const chevron = row.hasChildren
      ? `<button class="tree-chevron ${expanded ? 'is-open' : ''}" type="button" data-tree-toggle="${esc(row.path)}" aria-label="${expanded ? '折叠' : '展开'}" aria-expanded="${expanded}">${icon('chevron')}</button>`
      : '<span class="tree-chevron is-empty"></span>';
    const label = row.isRoot ? '$' : row.label;
    const labelClass = row.isRoot ? '' : (node.type === 'object' || node.type === 'array' ? '' : '');
    const colon = row.isRoot ? '' : '<span class="tree-colon">:</span>';
    let valueClass = 'is-container';
    if (node.type === 'string') valueClass = 'is-string';
    else if (node.type === 'number') valueClass = 'is-number';
    else if (node.type === 'boolean') valueClass = 'is-boolean';
    else if (node.type === 'null') valueClass = 'is-null';
    let preview;
    if (isContainer) {
      preview = node.type === 'object'
        ? (node.entries.length ? '{ … }' : '{}')
        : (node.items.length ? '[ … ]' : '[]');
    } else {
      preview = C.describeNode(node, 160);
    }
    const typeChip = isContainer
      ? `<span class="tree-type">${C.typeLabel(node)} · ${node.type === 'object' ? `${node.entries.length} 字段` : `${node.items.length} 项`}</span>`
      : (row.isRoot ? `<span class="tree-type">${C.typeLabel(node)}</span>` : '');
    return `<div class="tree-row ${row.isRoot ? 'is-root' : ''} ${row.hasChildren ? 'has-children' : ''}" data-tree-path="${esc(row.path)}" style="--depth:${row.depth}">
      <span class="tree-indent" style="width:${depth * 15}px"></span>
      ${chevron}
      <span class="tree-label ${labelClass}">${esc(label)}</span>
      ${colon}
      <span class="tree-value ${valueClass}" title="${esc(preview)}">${esc(preview)}</span>
      ${typeChip}
      <span class="row-actions">
        <button class="mini-btn" type="button" title="复制 JSON 值" aria-label="复制 JSON 值" data-copy-tree-value="${esc(row.path)}">${icon('copy')}</button>
        <button class="mini-btn" type="button" title="复制路径" aria-label="复制路径" data-copy-tree-path="${esc(row.path)}">${icon('link')}</button>
      </span>
    </div>`;
  }

  function renderTree() {
    const root = state.parsed.a;
    if (!root) {
      renderTreeEmpty();
      return;
    }
    const flat = C.flattenTree(root, state.treeExpanded, MAX_RENDER_ROWS);
    state.treeRows = new Map(flat.rows.map((row) => [row.path, row.node]));

    if (root.type === 'object') {
      setText(dom.treeKind, `对象 · ${root.entries.length} 个字段`);
    } else if (root.type === 'array') {
      setText(dom.treeKind, `数组 · ${root.items.length} 项`);
    } else {
      setText(dom.treeKind, C.typeLabel(root));
    }

    const text = editors.a.getText();
    setText(dom.treeStats, `${C.countNodes(root)} 个节点 · ${C.formatBytes(C.byteLength(text))}`);
    setText(dom.treeHint, flat.truncated ? `文档过大，仅显示前 ${MAX_RENDER_ROWS} 行` : '点击行或箭头展开');

    const scrollTop = dom.treeBody.scrollTop;
    dom.treeBody.innerHTML = flat.rows.map(treeRowHTML).join('') +
      (flat.truncated ? `<div class="tree-notice">${icon('alert')} 节点过多，仅显示前 ${MAX_RENDER_ROWS} 行</div>` : '');
    dom.treeBody.scrollTop = scrollTop;

    dom.treeExpandBtn.disabled = false;
    dom.treeCollapseBtn.disabled = false;
    dom.treeCopyBtn.disabled = false;
  }

  function renderTreeEmpty() {
    state.treeRows.clear();
    setText(dom.treeKind, '');
    setText(dom.treeStats, '等待 JSON');
    setText(dom.treeHint, '粘贴后自动解析');
    dom.treeBody.innerHTML = `<div class="empty-state">
      <div class="empty-glyph">${icon('braces')}</div>
      <h3>粘贴 JSON，看见结构</h3>
      <p>在左侧输入或导入 JSON，树视图会实时展开。<br>对象、数组、字符串和数字都有独立配色。</p>
      <button class="btn" type="button" data-load-sample="format">载入示例</button>
    </div>`;
    dom.treeExpandBtn.disabled = true;
    dom.treeCollapseBtn.disabled = true;
    dom.treeCopyBtn.disabled = true;
  }

  function renderTreeError(error) {
    state.treeRows.clear();
    setText(dom.treeKind, '解析错误');
    setText(dom.treeStats, '无法生成树');
    setText(dom.treeHint, '修正后自动更新');
    dom.treeBody.innerHTML = `<div class="empty-state error-state">
      <div class="empty-glyph">${icon('alert')}</div>
      <h3>JSON 解析失败</h3>
      <p>编辑器已经标记出错行，修正语法后树视图会自动恢复。</p>
      <div class="error-detail">第 ${error.line} 行第 ${error.column} 列：${esc(error.message)}</div>
      <button class="btn" type="button" data-focus-pane="a">${icon('arrow-right')} 定位到错误</button>
    </div>`;
    dom.treeExpandBtn.disabled = true;
    dom.treeCollapseBtn.disabled = true;
    dom.treeCopyBtn.disabled = true;
  }

  function toggleTreePath(path) {
    if (state.treeExpanded.has(path)) state.treeExpanded.delete(path);
    else state.treeExpanded.add(path);
    renderTree();
  }

  function treeAction(event) {
    const copyValue = event.target.closest('[data-copy-tree-value]');
    if (copyValue) {
      const node = state.treeRows.get(copyValue.dataset.copyTreeValue);
      if (node) copyText(C.formatJSON(node, 2), '已复制 JSON 值');
      return;
    }
    const copyPath = event.target.closest('[data-copy-tree-path]');
    if (copyPath) {
      copyText(copyPath.dataset.copyTreePath, '已复制 JSON 路径');
      return;
    }
    const focusButton = event.target.closest('[data-focus-pane]');
    if (focusButton) {
      focusError(focusButton.dataset.focusPane);
      return;
    }
    const sampleButton = event.target.closest('[data-load-sample]');
    if (sampleButton) {
      loadSample(sampleButton.dataset.loadSample);
      return;
    }
    const row = event.target.closest('.tree-row');
    if (!row) return;
    const toggle = event.target.closest('[data-tree-toggle]');
    const path = toggle ? toggle.dataset.treeToggle : row.dataset.treePath;
    if (row.classList.contains('has-children') && path) toggleTreePath(path);
  }

  function expandTreeAll() {
    if (!state.parsed.a) return;
    const paths = C.allContainerPaths(state.parsed.a);
    state.treeExpanded = new Set(paths);
    renderTree();
    if (paths.length > 1500) showToast(`已展开 ${paths.length} 个容器节点`, 'success', 1800);
  }

  function collapseTreeAll() {
    state.treeExpanded = new Set();
    renderTree();
  }

  // ---------------------------------------------------------------------------
  // Diff view
  // ---------------------------------------------------------------------------

  function statChip(label, value, kind) {
    return `<span class="stat-chip ${kind}">${label} <b>${value}</b></span>`;
  }

  function setDiffBanner(kind, headline, subline, statsHTML = '') {
    dom.diffBanner.className = `diff-banner is-${kind}`;
    const use = $('.headline-icon use', dom.diffBanner);
    if (use) use.setAttribute('href', kind === 'equal' ? '#i-check' : (kind === 'error' ? '#i-alert' : '#i-diff'));
    const strong = $('.headline-text strong', dom.diffBanner);
    const span = $('.headline-text span', dom.diffBanner);
    setText(strong, headline);
    setText(span, subline);
    dom.diffStats.innerHTML = statsHTML;
  }

  function setDiffBadge(kind, text, title) {
    const badge = dom.diffBadge;
    setStatusBadge(badge, kind, text, title || text);
  }

  function setDiffBody(html, resetScroll = false) {
    const old = dom.diffBody.scrollTop;
    dom.diffBody.innerHTML = html;
    dom.diffBody.scrollTop = resetScroll ? 0 : old;
  }

  function diffValueHTML(node) {
    return `<span class="val" title="${esc(C.describeNode(node, 500))}">${esc(C.describeNode(node, 110))}</span>`;
  }

  function diffRowHTML(row) {
    const node = row;
    const depth = Math.min(row.depth, 24);
    const isContainer = row.children.length > 0;
    const expanded = isContainer && state.diffExpanded && state.diffExpanded.has(row.path);
    const chevron = isContainer
      ? `<button class="diff-chevron ${expanded ? 'is-open' : ''}" type="button" data-diff-toggle="${esc(row.path)}" aria-label="${expanded ? '折叠' : '展开'}" aria-expanded="${expanded}">${icon('chevron')}</button>`
      : '<span class="diff-chevron is-empty"></span>';
    const statusLabel = { added: '新增', removed: '删除', changed: '修改', same: '相同' }[row.status];
    let values = '';

    if (row.status === 'added') {
      values = `<span class="val added">+ ${esc(C.describeNode(row.b, 110))}</span>`;
    } else if (row.status === 'removed') {
      values = `<span class="val removed">− ${esc(C.describeNode(row.a, 110))}</span>`;
    } else if (row.status === 'changed') {
      if (row.a && row.b && row.a.type !== row.b.type) {
        values = `<span class="type-pill">${C.typeLabel(row.a)}</span><span class="val old">${esc(C.describeNode(row.a, 64))}</span><span class="arrow">→</span><span class="type-pill">${C.typeLabel(row.b)}</span><span class="val new">${esc(C.describeNode(row.b, 64))}</span>`;
      } else if (row.a && row.b && C.isContainer(row.a)) {
        const aLen = row.a.type === 'object' ? row.a.entries.length : row.a.items.length;
        const bLen = row.b.type === 'object' ? row.b.entries.length : row.b.items.length;
        if (aLen === bLen) {
          values = `<span class="muted">${C.typeLabel(row.a)} · 内容有差异</span>`;
        } else {
          values = `<span class="val old">${esc(C.describeNode(row.a, 110))}</span><span class="arrow">→</span><span class="val new">${esc(C.describeNode(row.b, 110))}</span>`;
        }
      } else {
        values = `<span class="val old">${esc(C.describeNode(row.a, 110))}</span><span class="arrow">→</span><span class="val new">${esc(C.describeNode(row.b, 110))}</span>`;
      }
    } else {
      values = diffValueHTML(row.a);
    }

    return `<div class="diff-row status-${row.status}" data-diff-path="${esc(row.path)}" style="--depth:${depth}" title="${esc(row.path)}">
      ${chevron}
      <span class="diff-path">${esc(row.path)}</span>
      <span class="diff-status ${row.status}">${statusLabel}</span>
      <span class="diff-values">${values}</span>
      <span class="row-actions">
        <button class="mini-btn" type="button" title="复制路径" aria-label="复制路径" data-copy-diff-path="${esc(row.path)}">${icon('link')}</button>
      </span>
    </div>`;
  }

  function renderCompare() {
    if (!dom.diffBody) return;

    const a = state.parsed.a;
    const b = state.parsed.b;
    const errorA = state.errors.a;
    const errorB = state.errors.b;
    const emptyA = state.empty.a;
    const emptyB = state.empty.b;

    dom.diffExpandBtn.disabled = true;
    dom.diffCollapseBtn.disabled = true;

    if (errorA || errorB) {
      const invalid = [];
      if (errorA) invalid.push({ pane: 'a', error: errorA });
      if (errorB) invalid.push({ pane: 'b', error: errorB });
      const names = invalid.map((item) => `JSON ${item.pane.toUpperCase()}`).join('、');
      setDiffBadge('error', '无法比较', `${names} 解析失败`);
      setDiffBanner(
        'error',
        invalid.length === 1 ? `${names} 解析失败` : '两个 JSON 都无法解析',
        '修复语法错误后会自动重新比较'
      );
      const details = invalid.map((item) => `<div class="error-detail">JSON ${item.pane.toUpperCase()} · 第 ${item.error.line} 行第 ${item.error.column} 列：${esc(item.error.message)}</div>`).join('');
      const buttons = invalid.map((item) => `<button class="btn" type="button" data-focus-pane="${item.pane}">${icon('arrow-right')} 定位 JSON ${item.pane.toUpperCase()}</button>`).join('');
      setDiffBody(`<div class="empty-state error-state">
        <div class="empty-glyph">${icon('alert')}</div>
        <h3>暂时无法比较</h3>
        <p>请先修复 ${names} 的语法，差异结果会在输入停止后自动刷新。</p>
        ${details}
        <div class="error-actions">${buttons}</div>
      </div>`, true);
      setText(dom.diffMeta, '等待有效 JSON');
      state.diff = null;
      state.diffKey = null;
      return;
    }

    if (emptyA || emptyB) {
      const waiting = emptyA && emptyB ? '两个 JSON' : (emptyA ? 'JSON A' : 'JSON B');
      setDiffBadge('neutral', '待比较', `等待 ${waiting}`);
      setDiffBanner(
        'neutral',
        `等待 ${waiting}`,
        '在编辑器中粘贴 JSON，差异会实时显示'
      );
      setDiffBody(`<div class="empty-state diff-empty">
        <div class="empty-glyph">${icon('diff')}</div>
        <h3>比较两个 JSON</h3>
        <p>左右各放一个 JSON，即可看到新增、删除和修改。<br>对象 key 顺序会被忽略，数组则按索引比较。</p>
      </div>`, true);
      setText(dom.diffMeta, '等待输入');
      state.diff = null;
      state.diffKey = null;
      return;
    }

    const textA = editors.a.getText();
    const textB = editors.b.getText();
    const key = `${textA}\u0000${textB}`;
    const contentChanged = key !== state.diffKey;
    const started = performance.now();

    if (contentChanged || !state.diff) {
      state.diff = C.diffJSON(a, b);
      state.diffKey = key;
      state.diffMs = performance.now() - started;
    }

    const diff = state.diff;
    const total = diff.stats.added + diff.stats.removed + diff.stats.changed;
    const exact = textA.trim() === textB.trim();

    if (state.diffExpanded === null) {
      state.diffExpanded = C.defaultDiffExpanded(diff);
    }

    const statsHTML = [
      statChip('新增', diff.stats.added, 'added'),
      statChip('删除', diff.stats.removed, 'removed'),
      statChip('修改', diff.stats.changed, 'changed'),
      statChip('相同', diff.stats.same, 'same')
    ].join('');

    if (diff.equal) {
      setDiffBadge('valid', '语义一致', '两个 JSON 在忽略对象 key 顺序后完全一致');
      setDiffBanner(
        'equal',
        '两个 JSON 语义一致',
        exact
          ? '内容逐字节一致'
          : (diff.orderDiff ? '对象 key 顺序不同，但未计入差异' : '忽略格式、空白与 key 顺序后完全一致'),
        statsHTML
      );
    } else {
      setDiffBadge('different', `${total} 处差异`, `新增 ${diff.stats.added}，删除 ${diff.stats.removed}，修改 ${diff.stats.changed}`);
      setDiffBanner(
        'different',
        `发现 ${total} 处差异`,
        `新增 ${diff.stats.added} · 删除 ${diff.stats.removed} · 修改 ${diff.stats.changed} · 对象 key 顺序已忽略`,
        statsHTML
      );
    }

    const flat = C.flattenDiff(diff, state.diffExpanded || new Set(), state.onlyDiff, MAX_RENDER_ROWS);

    if (diff.equal && state.onlyDiff) {
      const reason = exact
        ? '两个 JSON 逐字节一致。'
        : (diff.orderDiff
          ? '检测到对象 key 顺序不同，但语义完全一致。'
          : '忽略格式、空白和 key 顺序后，两个 JSON 完全一致。');
      setDiffBody(`<div class="equal-hero">
        <div class="equal-check">${icon('check')}</div>
        <h3>没有差异</h3>
        <p>${esc(reason)} 当前比较已忽略对象 key 顺序。</p>
        <button class="btn" type="button" data-show-full-diff>${icon('braces')} 查看完整对比树</button>
      </div>`, contentChanged);
    } else if (!flat.rows.length) {
      setDiffBody(`<div class="empty-state diff-empty">
        <div class="empty-glyph">${icon('diff')}</div>
        <h3>${diff.equal ? '所有节点都相同' : '没有可展示的差异'}</h3>
        <p>切换「仅差异」或展开节点以查看更多内容。</p>
      </div>`, contentChanged);
    } else {
      const notice = flat.truncated
        ? `<div class="tree-notice">${icon('alert')} 差异行过多，仅显示前 ${MAX_RENDER_ROWS} 行</div>`
        : '';
      setDiffBody(flat.rows.map(diffRowHTML).join('') + notice, contentChanged);
    }

    dom.diffExpandBtn.disabled = false;
    dom.diffCollapseBtn.disabled = false;
    setText(dom.diffMeta, `比较耗时 ${formatTime(state.diffMs)}`);
  }

  function diffAction(event) {
    const copyPath = event.target.closest('[data-copy-diff-path]');
    if (copyPath) {
      copyText(copyPath.dataset.copyDiffPath, '已复制 JSON 路径');
      return;
    }
    const fullButton = event.target.closest('[data-show-full-diff]');
    if (fullButton) {
      state.onlyDiff = false;
      dom.onlyDiff.checked = false;
      renderCompare();
      return;
    }
    const focusButton = event.target.closest('[data-focus-pane]');
    if (focusButton) {
      focusError(focusButton.dataset.focusPane);
      return;
    }
    const toggle = event.target.closest('[data-diff-toggle]');
    if (toggle) {
      const path = toggle.dataset.diffToggle;
      if (state.diffExpanded.has(path)) state.diffExpanded.delete(path);
      else state.diffExpanded.add(path);
      renderCompare();
      return;
    }
    const row = event.target.closest('.diff-row');
    if (!row) return;
    const path = row.dataset.diffPath;
    const currentNode = findDiffNode(state.diff && state.diff.root, path);
    if (currentNode && currentNode.children.length) {
      if (state.diffExpanded.has(path)) state.diffExpanded.delete(path);
      else state.diffExpanded.add(path);
      renderCompare();
    }
  }

  function findDiffNode(root, path) {
    if (!root) return null;
    if (root.path === path) return root;
    for (const child of root.children) {
      const found = findDiffNode(child, path);
      if (found) return found;
    }
    return null;
  }

  function expandDiffAll() {
    if (!state.diff) return;
    state.diffExpanded = new Set(C.allDiffContainerPaths(state.diff));
    renderCompare();
  }

  function collapseDiffAll() {
    state.diffExpanded = new Set();
    renderCompare();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function activePane() {
    return state.mode === 'format' ? 'a' : state.activePane;
  }

  function formatPane(pane, compact = false) {
    const editor = editors[pane];
    const text = editor.getText();
    if (!text.trim()) {
      showToast('请先输入 JSON', 'error');
      editor.input.focus();
      return;
    }
    let parsed;
    try {
      parsed = C.parseJSON(text);
    } catch (error) {
      state.parsed[pane] = null;
      state.errors[pane] = error;
      state.empty[pane] = false;
      editor.setError(error);
      updatePaneBadge(pane);
      if (pane === 'a' && state.mode === 'format') renderTreeError(error);
      if (state.mode === 'compare') renderCompare();
      showToast(`第 ${error.line} 行第 ${error.column} 列：${error.message}`, 'error', 3600);
      editor.focusAt(error.index);
      return;
    }
    const output = compact ? C.minifyJSON(parsed) : C.formatJSON(parsed, 2);
    if (output === text) {
      showToast(compact ? '已经是压缩后的 JSON' : '已经是格式化后的 JSON');
      return;
    }
    editor.setText(output, { undo: true, resetScroll: true });
    state.resetTree = true;
    refreshNow(pane);
    showToast(compact ? '已压缩 JSON' : '已格式化 JSON');
  }

  function clearPane(pane) {
    const editor = editors[pane];
    if (!editor.getText()) {
      showToast('编辑器已经是空的');
      return;
    }
    editor.setText('', { undo: true });
    state.resetTree = true;
    state.diffExpanded = null;
    refreshNow(pane);
    showToast('已清空，可按 ⌘Z 撤销');
  }

  function focusError(pane) {
    const error = state.errors[pane];
    if (pane === 'b' && state.mode !== 'compare') setMode('compare');
    const editor = editors[pane];
    if (error) editor.focusAt(error.index);
    else editor.input.focus();
  }

  function loadFileIntoPane(pane, file) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) {
      showToast('文件超过 30 MB，建议先拆分', 'error', 3600);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      editors[pane].setText(String(reader.result || ''), { undo: true, resetScroll: true });
      state.resetTree = true;
      state.diffExpanded = null;
      refreshNow(pane);
      showToast(`已导入 ${file.name}`);
    };
    reader.onerror = () => showToast('读取文件失败', 'error');
    reader.readAsText(file, 'utf-8');
  }

  function importText(text, name) {
    const pane = activePane();
    closeAnyModal();
    editors[pane].setText(String(text == null ? '' : text), { undo: true, resetScroll: true });
    state.resetTree = true;
    state.diffExpanded = null;
    refreshNow(pane);
    showToast(`已导入 ${name || 'JSON'}`);
  }

  function setMode(mode, options = {}) {
    if (mode !== 'format' && mode !== 'compare') return;
    const changed = state.mode !== mode;
    state.mode = mode;
    document.body.dataset.mode = mode;
    document.title = mode === 'format' ? 'JSON Studio — 格式化' : 'JSON Studio — 对比';

    dom.formatView.classList.toggle('is-active', mode === 'format');
    dom.compareView.classList.toggle('is-active', mode === 'compare');
    dom.modeSwitch.classList.toggle('is-compare', mode === 'compare');
    $$('.mode-btn').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (mode === 'format') {
      dom.formatEditorA.appendChild(dom.editorCardA);
      setText(dom.titleA, 'JSON 输入');
    } else {
      dom.compareEditorA.appendChild(dom.editorCardA);
      setText(dom.titleA, 'JSON A');
    }

    refreshPane('a');
    if (mode === 'compare') {
      refreshPane('b');
      renderCompare();
    }

    requestAnimationFrame(() => {
      editors.a.syncScroll();
      editors.b.syncScroll();
      clampSplitters();
    });

    if (changed && options.announce) {
      showToast(mode === 'format' ? '已切换到格式化模式' : '已切换到对比模式', 'success', 1400);
    }
  }

  function compareNow(announce = true) {
    if (state.mode !== 'compare') setMode('compare');
    refreshPane('a');
    refreshPane('b');
    renderCompare();
    if (announce) {
      if (state.errors.a || state.errors.b) {
        showToast('存在语法错误，无法比较', 'error');
      } else if (state.empty.a || state.empty.b) {
        showToast('请先输入两个 JSON', 'error');
      } else if (state.diff && state.diff.equal) {
        showToast('两个 JSON 语义一致');
      } else if (state.diff) {
        const total = state.diff.stats.added + state.diff.stats.removed + state.diff.stats.changed;
        showToast(`发现 ${total} 处差异`);
      }
    }
  }

  function loadSample(kind) {
    closeSampleMenu();
    if (kind === 'format') {
      editors.a.setText(SAMPLE_FORMAT, { silent: true, resetScroll: true });
      state.resetTree = true;
      state.diffExpanded = null;
      setMode('format');
      refreshNow('a');
      showToast('已载入格式化示例');
      return;
    }
    if (kind === 'compare') {
      editors.a.setText(SAMPLE_COMPARE_A, { silent: true, resetScroll: true });
      editors.b.setText(SAMPLE_COMPARE_B, { silent: true, resetScroll: true });
      state.resetTree = true;
      state.diffExpanded = null;
      state.diffKey = null;
      setMode('compare');
      renderCompare();
      showToast('已载入对比示例');
      return;
    }
    if (kind === 'clear') {
      editors.a.setText('', { silent: true, resetScroll: true });
      editors.b.setText('', { silent: true, resetScroll: true });
      state.treeExpanded = new Set();
      state.resetTree = false;
      state.diffExpanded = null;
      state.diffKey = null;
      if (state.mode === 'format') renderTreeEmpty();
      refreshPane('a');
      refreshPane('b');
      if (state.mode === 'compare') renderCompare();
      showToast('已清空两个编辑器');
    }
  }

  // ---------------------------------------------------------------------------
  // Unescape modal
  // ---------------------------------------------------------------------------

  function openUnescape(pane) {
    state.unescapePane = pane || activePane();
    state.unescapeMode = 'raw';
    dom.unescapeInput.value = editors[state.unescapePane].getText();
    $$('#unescapeModes button').forEach((button) => {
      const active = button.dataset.unescapeMode === 'raw';
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    openModal('unescapeModal');
    updateUnescape();
    setTimeout(() => {
      dom.unescapeInput.focus();
      dom.unescapeInput.setSelectionRange(0, 0);
    }, 40);
  }

  function updateUnescape() {
    const input = dom.unescapeInput.value;
    clearTimeout(state.unescapeTimer);
    if (!input.trim()) {
      dom.unescapeOutput.value = '';
      dom.unescapeNote.className = 'modal-note';
      setText(dom.unescapeNote, '支持 \\n、\\t、\\"、\\\\、\\uXXXX、\\u{1F680} 等转义序列。');
      dom.unescapeState.className = 'output-state';
      setText(dom.unescapeState, '—');
      dom.unescapeApply.disabled = true;
      dom.unescapeCopy.disabled = true;
      state.unescapeResult = null;
      return;
    }

    const result = C.transformUnescape(input, state.unescapeMode);
    state.unescapeResult = result;
    dom.unescapeOutput.value = result.output || '';
    const hasOutput = !!result.output;
    dom.unescapeApply.disabled = !hasOutput;
    dom.unescapeCopy.disabled = !hasOutput;

    if (result.error) {
      dom.unescapeNote.className = 'modal-note is-error';
      setText(dom.unescapeNote, result.error);
      dom.unescapeState.className = 'output-state is-error';
      setText(dom.unescapeState, '无法解析');
      return;
    }

    dom.unescapeNote.className = result.validJSON ? 'modal-note is-success' : 'modal-note';
    setText(dom.unescapeNote, result.note || '');
    dom.unescapeState.className = result.validJSON ? 'output-state is-valid' : 'output-state';
    setText(dom.unescapeState, result.validJSON ? '合法 JSON' : '纯文本');
  }

  function scheduleUnescape() {
    clearTimeout(state.unescapeTimer);
    state.unescapeTimer = setTimeout(updateUnescape, 90);
  }

  function applyUnescape() {
    const output = dom.unescapeOutput.value;
    if (!output) return;
    const pane = state.unescapePane;
    closeModal('unescapeModal', false);
    editors[pane].setText(output, { undo: true, resetScroll: true });
    state.resetTree = true;
    state.diffExpanded = null;
    refreshNow(pane);
    setTimeout(() => editors[pane].input.focus(), 20);
    showToast(`已应用到 JSON ${pane.toUpperCase()}`);
  }

  function setUnescapeMode(mode) {
    state.unescapeMode = mode;
    $$('#unescapeModes button').forEach((button) => {
      const active = button.dataset.unescapeMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    updateUnescape();
  }

  // ---------------------------------------------------------------------------
  // Modals & sample menu
  // ---------------------------------------------------------------------------

  function openModal(id) {
    $$('.modal-layer').forEach((layer) => { layer.hidden = layer.id !== id; });
    state.lastFocus = document.activeElement;
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('is-modal-open');
    const focusable = modal.querySelector('textarea, input, button:not([disabled])');
    if (focusable) setTimeout(() => focusable.focus(), 30);
  }

  function closeModal(id, restoreFocus = true) {
    const modal = document.getElementById(id);
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (!$$('.modal-layer').some((layer) => !layer.hidden)) {
      document.body.classList.remove('is-modal-open');
    }
    if (restoreFocus && state.lastFocus && typeof state.lastFocus.focus === 'function') {
      setTimeout(() => {
        if (state.lastFocus && document.contains(state.lastFocus) && !state.lastFocus.closest('[hidden]')) {
          state.lastFocus.focus();
        }
      }, 20);
    }
  }

  function closeAnyModal() {
    const open = $$('.modal-layer').find((layer) => !layer.hidden);
    if (open) {
      closeModal(open.id);
      return true;
    }
    return false;
  }

  function closeSampleMenu() {
    dom.sampleMenu.hidden = true;
    dom.sampleBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleSampleMenu() {
    const willOpen = dom.sampleMenu.hidden;
    dom.sampleMenu.hidden = !willOpen;
    dom.sampleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  // ---------------------------------------------------------------------------
  // Splitter
  // ---------------------------------------------------------------------------

  function clampSplitters() {
    const layoutRect = dom.formatLayout.getBoundingClientRect();
    const leftRaw = dom.formatLayout.style.getPropertyValue('--format-left');
    if (leftRaw && layoutRect.width > 0) {
      const current = parseFloat(leftRaw);
      const max = Math.max(340, layoutRect.width - 340 - 9);
      const next = Math.max(340, Math.min(current, max));
      dom.formatLayout.style.setProperty('--format-left', `${next}px`);
    }
    const compareRect = dom.compareLayout.getBoundingClientRect();
    const topRaw = dom.compareLayout.style.getPropertyValue('--compare-top');
    if (topRaw && compareRect.height > 0) {
      const current = parseFloat(topRaw);
      const max = Math.max(200, compareRect.height - 190 - 10);
      const next = Math.max(200, Math.min(current, max));
      dom.compareLayout.style.setProperty('--compare-top', `${next}px`);
    }
  }

  function initVerticalSplitter() {
    const splitter = dom.formatSplitter;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    let maxWidth = 0;

    const move = (event) => {
      if (!dragging) return;
      const next = Math.max(340, Math.min(maxWidth, startWidth + (event.clientX - startX)));
      dom.formatLayout.style.setProperty('--format-left', `${next}px`);
      editors.a.syncScroll();
    };
    const up = () => {
      dragging = false;
      splitter.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing', 'is-resizing-col');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    splitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = dom.formatLayout.getBoundingClientRect();
      startWidth = dom.formatEditorA.getBoundingClientRect().width;
      maxWidth = Math.max(340, rect.width - 340 - 9);
      startX = event.clientX;
      dragging = true;
      splitter.classList.add('is-dragging');
      document.body.classList.add('is-resizing', 'is-resizing-col');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    splitter.addEventListener('dblclick', () => {
      dom.formatLayout.style.removeProperty('--format-left');
      editors.a.syncScroll();
    });
    splitter.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const rect = dom.formatLayout.getBoundingClientRect();
      const current = dom.formatEditorA.getBoundingClientRect().width;
      const max = Math.max(340, rect.width - 340 - 9);
      const next = Math.max(340, Math.min(max, current + (event.key === 'ArrowRight' ? 24 : -24)));
      dom.formatLayout.style.setProperty('--format-left', `${next}px`);
      editors.a.syncScroll();
    });
  }

  function initHorizontalSplitter() {
    const splitter = dom.compareSplitter;
    let dragging = false;
    let startY = 0;
    let startHeight = 0;
    let maxHeight = 0;

    const move = (event) => {
      if (!dragging) return;
      const next = Math.max(200, Math.min(maxHeight, startHeight + (event.clientY - startY)));
      dom.compareLayout.style.setProperty('--compare-top', `${next}px`);
      editors.a.syncScroll();
      editors.b.syncScroll();
    };
    const up = () => {
      dragging = false;
      splitter.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing', 'is-resizing-row');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    splitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = dom.compareLayout.getBoundingClientRect();
      startHeight = dom.compareEditors.getBoundingClientRect().height;
      maxHeight = Math.max(200, rect.height - 190 - 10);
      startY = event.clientY;
      dragging = true;
      splitter.classList.add('is-dragging');
      document.body.classList.add('is-resizing', 'is-resizing-row');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    splitter.addEventListener('dblclick', () => {
      dom.compareLayout.style.removeProperty('--compare-top');
      editors.a.syncScroll();
      editors.b.syncScroll();
    });
    splitter.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const rect = dom.compareLayout.getBoundingClientRect();
      const current = dom.compareEditors.getBoundingClientRect().height;
      const max = Math.max(200, rect.height - 190 - 10);
      const next = Math.max(200, Math.min(max, current + (event.key === 'ArrowDown' ? 24 : -24)));
      dom.compareLayout.style.setProperty('--compare-top', `${next}px`);
      editors.a.syncScroll();
      editors.b.syncScroll();
    });
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  function handleGlobalKeyDown(event) {
    if (event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (event.key === 'Escape') {
      if (!dom.sampleMenu.hidden) {
        closeSampleMenu();
        dom.sampleBtn.focus();
        return;
      }
      if (closeAnyModal()) return;
      return;
    }

    const modalOpen = $$('.modal-layer').some((layer) => !layer.hidden);
    if (modalOpen) return;

    if (mod && !event.shiftKey && key === '1') {
      event.preventDefault();
      setMode('format');
      return;
    }
    if (mod && !event.shiftKey && key === '2') {
      event.preventDefault();
      setMode('compare');
      return;
    }
    if (mod && event.shiftKey && key === 'f') {
      event.preventDefault();
      formatPane(activePane(), false);
      return;
    }
    if (mod && event.shiftKey && key === 'm') {
      event.preventDefault();
      formatPane(activePane(), true);
      return;
    }
    if (mod && event.shiftKey && key === 'u') {
      event.preventDefault();
      openUnescape(activePane());
      return;
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      compareNow(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function bindEditors() {
    ['a', 'b'].forEach((pane) => {
      const editor = editors[pane];
      editor.onChange = (changedPane) => scheduleRefresh(changedPane);
      editor.onCursor = (changedPane, info) => updateCursorInfo(changedPane, info);
      editor.onFocus = (focusedPane) => {
        state.activePane = focusedPane;
      };
      editor.onFile = (file, changedPane) => loadFileIntoPane(changedPane, file);
    });
  }

  function bindUi() {
    $$('.mode-btn').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });

    $$('.js-format').forEach((button) => {
      button.addEventListener('click', () => formatPane(button.dataset.pane, false));
    });
    $$('.js-minify').forEach((button) => {
      button.addEventListener('click', () => formatPane(button.dataset.pane, true));
    });
    $$('.js-unescape').forEach((button) => {
      button.addEventListener('click', () => openUnescape(button.dataset.pane));
    });
    $$('.js-clear').forEach((button) => {
      button.addEventListener('click', () => clearPane(button.dataset.pane));
    });
    $$('.js-import').forEach((button) => {
      button.addEventListener('click', () => {
        state.importPane = button.dataset.pane;
        dom.fileInput.value = '';
        dom.fileInput.click();
      });
    });

    dom.fileInput.addEventListener('change', () => {
      const file = dom.fileInput.files && dom.fileInput.files[0];
      if (file) loadFileIntoPane(state.importPane, file);
    });

    dom.treeBody.addEventListener('click', treeAction);
    dom.treeExpandBtn.addEventListener('click', expandTreeAll);
    dom.treeCollapseBtn.addEventListener('click', collapseTreeAll);
    dom.treeCopyBtn.addEventListener('click', () => {
      if (!state.parsed.a) {
        showToast('没有可复制的 JSON', 'error');
        return;
      }
      copyText(C.formatJSON(state.parsed.a, 2), '已复制格式化 JSON');
    });

    dom.onlyDiff.addEventListener('change', () => {
      state.onlyDiff = dom.onlyDiff.checked;
      renderCompare();
    });
    dom.diffExpandBtn.addEventListener('click', expandDiffAll);
    dom.diffCollapseBtn.addEventListener('click', collapseDiffAll);
    dom.diffBody.addEventListener('click', diffAction);

    dom.sampleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSampleMenu();
    });
    $$('#sampleMenu [data-sample]').forEach((button) => {
      button.addEventListener('click', () => loadSample(button.dataset.sample));
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.menu-wrap')) closeSampleMenu();
    });

    dom.helpBtn.addEventListener('click', () => openModal('shortcutsModal'));

    $$('.modal-close, [data-close]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.close || button.closest('.modal-layer').id;
        closeModal(id);
      });
    });
    $$('.modal-layer').forEach((layer) => {
      layer.addEventListener('mousedown', (event) => {
        if (event.target === layer) closeModal(layer.id);
      });
    });

    $$('#unescapeModes button').forEach((button) => {
      button.addEventListener('click', () => setUnescapeMode(button.dataset.unescapeMode));
    });
    dom.unescapeInput.addEventListener('input', scheduleUnescape);
    dom.unescapeCopy.addEventListener('click', () => {
      if (state.unescapeResult) copyText(dom.unescapeOutput.value, '已复制反转义结果');
    });
    dom.unescapeApply.addEventListener('click', applyUnescape);

    document.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('resize', () => {
      clampSplitters();
      editors.a.syncScroll();
      editors.b.syncScroll();
    });
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => clampSplitters());
      observer.observe(dom.formatLayout);
      observer.observe(dom.compareLayout);
    }

    window.addEventListener('error', (event) => {
      nativeLog('error', `${event.message} @ ${event.filename}:${event.lineno}`);
    });
    window.addEventListener('unhandledrejection', (event) => {
      nativeLog('error', `Unhandled rejection: ${event.reason && event.reason.message ? event.reason.message : event.reason}`);
    });
  }

  function init() {
    dom = {
      formatView: $('#formatView'),
      compareView: $('#compareView'),
      modeSwitch: $('.mode-switch'),
      formatLayout: $('#formatLayout'),
      compareLayout: $('#compareLayout'),
      formatEditorA: $('#formatEditorA'),
      compareEditorA: $('#compareEditorA'),
      editorCardA: $('#editorCardA'),
      compareEditors: $('.compare-editors'),
      formatSplitter: $('#formatSplitter'),
      compareSplitter: $('#compareSplitter'),
      titleA: $('#titleA'),
      titleB: $('#titleB'),
      badgeA: $('#badgeA'),
      badgeB: $('#badgeB'),
      cursorA: $('#cursorA'),
      cursorB: $('#cursorB'),
      metaA: $('#metaA'),
      metaB: $('#metaB'),
      treeKind: $('#treeKind'),
      treeBody: $('#treeBody'),
      treeStats: $('#treeStats'),
      treeHint: $('#treeHint'),
      treeExpandBtn: $('#treeExpandBtn'),
      treeCollapseBtn: $('#treeCollapseBtn'),
      treeCopyBtn: $('#treeCopyBtn'),
      diffBadge: $('#diffBadge'),
      diffBanner: $('#diffBanner'),
      diffStats: $('#diffStats'),
      diffBody: $('#diffBody'),
      diffMeta: $('#diffMeta'),
      diffExpandBtn: $('#diffExpandBtn'),
      diffCollapseBtn: $('#diffCollapseBtn'),
      onlyDiff: $('#onlyDiff'),
      sampleBtn: $('#sampleBtn'),
      sampleMenu: $('#sampleMenu'),
      helpBtn: $('#helpBtn'),
      toast: $('#toast'),
      toastText: $('#toastText'),
      fileInput: $('#fileInput'),
      unescapeInput: $('#unescapeInput'),
      unescapeOutput: $('#unescapeOutput'),
      unescapeModes: $('#unescapeModes'),
      unescapeNote: $('#unescapeNote'),
      unescapeState: $('#unescapeState'),
      unescapeCopy: $('#unescapeCopy'),
      unescapeApply: $('#unescapeApply')
    };

    editors = {
      a: new CodeEditor($('#editorHostA'), 'a'),
      b: new CodeEditor($('#editorHostB'), 'b')
    };

    bindEditors();
    bindUi();

    editors.a.setText(SAMPLE_COMPARE_A, { silent: true, resetScroll: true });
    editors.b.setText(SAMPLE_COMPARE_B, { silent: true, resetScroll: true });

    state.onlyDiff = dom.onlyDiff.checked;
    state.mode = 'format';
    document.body.dataset.mode = 'format';
    setMode('format');
    refreshPane('a');
    refreshPane('b');
    renderCompare();
    initVerticalSplitter();
    initHorizontalSplitter();

    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'compare' || window.location.hash === '#compare') {
      setMode('compare');
    }

    window.JSONStudio = {
      setMode: (mode) => setMode(mode),
      formatActive: () => formatPane(activePane(), false),
      minifyActive: () => formatPane(activePane(), true),
      openUnescape: () => openUnescape(activePane()),
      compareNow: () => compareNow(true),
      showShortcuts: () => openModal('shortcutsModal'),
      loadCompareSample: () => loadSample('compare'),
      focusActive: () => editors[activePane()].input.focus(),
      loadText: (text, name) => importText(text, name),
      loadBase64: (base64, name) => {
        try {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const text = new TextDecoder('utf-8').decode(bytes);
          importText(text, name);
        } catch (error) {
          nativeLog('error', `loadBase64 failed: ${error.message}`);
          showToast('读取文件失败：不是有效的 UTF-8 文本', 'error', 3600);
        }
      },
      ready: true
    };

    document.documentElement.dataset.ready = 'true';
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.appReady) {
        window.webkit.messageHandlers.appReady.postMessage({ mode: state.mode });
      }
    } catch (_) {}
    nativeLog('info', 'JSON Studio ready');
  }

  try {
    init();
  } catch (error) {
    nativeLog('error', `init failed: ${error && error.stack ? error.stack : error}`);
    document.body.innerHTML = `<div style="padding:40px;font-family:-apple-system;color:#b42318">
      <h2 style="margin:0 0 8px">JSON Studio 启动失败</h2>
      <pre style="white-space:pre-wrap;font-size:12px">${String(error && error.stack ? error.stack : error)}</pre>
    </div>`;
  }
})();
