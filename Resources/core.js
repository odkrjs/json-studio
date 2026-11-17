/*
 * JSON Studio — core engine
 * A dependency-free JSON parser, formatter, unescaper and semantic diff.
 * Object key order is ignored by the diff; array order is significant.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.JSONCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Errors & small helpers
  // ---------------------------------------------------------------------------

  class JSONParseError extends Error {
    constructor(message, index, line, column) {
      super(message);
      this.name = 'JSONParseError';
      this.index = index;
      this.line = line;
      this.column = column;
    }
  }

  function lineColumnAt(text, index) {
    let line = 1;
    let column = 1;
    const limit = Math.max(0, Math.min(index, text.length));
    for (let i = 0; i < limit; i++) {
      if (text[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    return { line, column };
  }

  function typeLabel(node) {
    if (!node) return '缺失';
    switch (node.type) {
      case 'object': return '对象';
      case 'array': return '数组';
      case 'string': return '字符串';
      case 'number': return '数字';
      case 'boolean': return '布尔';
      case 'null': return 'null';
      default: return '未知';
    }
  }

  function isContainer(node) {
    return !!node && (node.type === 'object' || node.type === 'array');
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function stringPreview(value, max = 110) {
    const quoted = JSON.stringify(value);
    if (quoted.length <= max) return quoted;
    return quoted.slice(0, Math.max(1, max - 1)) + '…';
  }

  function describeNode(node, maxString = 110) {
    if (!node) return '—';
    switch (node.type) {
      case 'object':
        return node.entries.length === 0 ? '{}' : `{ ${node.entries.length} 个字段 }`;
      case 'array':
        return node.items.length === 0 ? '[]' : `[ ${node.items.length} 项 ]`;
      case 'string':
        return stringPreview(node.value, maxString);
      case 'number':
        return node.raw;
      case 'boolean':
        return node.value ? 'true' : 'false';
      case 'null':
        return 'null';
      default:
        return '—';
    }
  }

  function countNodes(node) {
    if (!node) return 0;
    if (node.type === 'object') {
      return 1 + node.entries.reduce((total, entry) => total + countNodes(entry.value), 0);
    }
    if (node.type === 'array') {
      return 1 + node.items.reduce((total, item) => total + countNodes(item), 0);
    }
    return 1;
  }

  function countLeaves(node) {
    if (!node) return 0;
    if (node.type === 'object') {
      if (node.entries.length === 0) return 1;
      return node.entries.reduce((total, entry) => total + countLeaves(entry.value), 0);
    }
    if (node.type === 'array') {
      if (node.items.length === 0) return 1;
      return node.items.reduce((total, item) => total + countLeaves(item), 0);
    }
    return 1;
  }

  function byteLength(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------------------
  // Parser
  // ---------------------------------------------------------------------------

  function parseJSON(input, options = {}) {
    if (typeof input !== 'string') {
      throw new TypeError('JSON 输入必须是字符串');
    }
    let text = input;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const maxDepth = options.maxDepth || 256;

    let i = 0;
    const n = text.length;

    function fail(message, at) {
      const index = at === undefined ? i : at;
      const { line, column } = lineColumnAt(text, index);
      throw new JSONParseError(message, index, line, column);
    }

    function skipWhitespace() {
      while (i < n) {
        const code = text.charCodeAt(i);
        if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) i++;
        else break;
      }
    }

    function readString() {
      if (text[i] !== '"') fail('字符串必须以双引号开始');
      i++;
      let output = '';
      while (i < n) {
        const ch = text[i];
        if (ch === '"') {
          i++;
          return output;
        }
        if (ch === '\\') {
          i++;
          if (i >= n) fail('字符串中的转义序列不完整');
          const escaped = text[i++];
          switch (escaped) {
            case '"': output += '"'; break;
            case '\\': output += '\\'; break;
            case '/': output += '/'; break;
            case 'b': output += '\b'; break;
            case 'f': output += '\f'; break;
            case 'n': output += '\n'; break;
            case 'r': output += '\r'; break;
            case 't': output += '\t'; break;
            case 'u': {
              const hex = text.slice(i, i + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                fail('\\u 后必须跟 4 位十六进制数字', i);
              }
              let code = parseInt(hex, 16);
              i += 4;
              // Combine a valid UTF-16 surrogate pair into one code point.
              if (code >= 0xd800 && code <= 0xdbff && text[i] === '\\' && text[i + 1] === 'u') {
                const lowHex = text.slice(i + 2, i + 6);
                if (/^[0-9a-fA-F]{4}$/.test(lowHex)) {
                  const low = parseInt(lowHex, 16);
                  if (low >= 0xdc00 && low <= 0xdfff) {
                    code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                    i += 6;
                    output += String.fromCodePoint(code);
                    break;
                  }
                }
              }
              output += String.fromCharCode(code);
              break;
            }
            default:
              fail(`无效的转义字符 “\\${escaped}”`, i - 2);
          }
        } else {
          const code = text.charCodeAt(i);
          if (code < 0x20) fail('字符串中不允许出现未转义的控制字符', i);
          output += ch;
          i++;
        }
      }
      fail('字符串缺少结束引号', n);
    }

    function readNumber() {
      const start = i;
      if (text[i] === '-') i++;
      if (text[i] === '0') {
        i++;
        if (text[i] >= '0' && text[i] <= '9') fail('数字不允许有前导零', i);
      } else if (text[i] >= '1' && text[i] <= '9') {
        while (text[i] >= '0' && text[i] <= '9') i++;
      } else {
        fail('无效的数字', i);
      }
      if (text[i] === '.') {
        i++;
        if (!(text[i] >= '0' && text[i] <= '9')) fail('小数点后必须跟至少一位数字', i);
        while (text[i] >= '0' && text[i] <= '9') i++;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        if (!(text[i] >= '0' && text[i] <= '9')) fail('指数部分必须跟至少一位数字', i);
        while (text[i] >= '0' && text[i] <= '9') i++;
      }
      const raw = text.slice(start, i);
      return { type: 'number', raw, value: Number(raw) };
    }

    function parseValue(depth) {
      if (depth > maxDepth) fail(`JSON 嵌套层级超过 ${maxDepth} 层`, i);
      skipWhitespace();
      if (i >= n) fail('缺少 JSON 值');
      const ch = text[i];

      if (ch === '{') return parseObject(depth + 1);
      if (ch === '[') return parseArray(depth + 1);
      if (ch === '"') return { type: 'string', value: readString() };
      if (ch === '-' || (ch >= '0' && ch <= '9')) return readNumber();
      if (text.startsWith('true', i)) {
        i += 4;
        return { type: 'boolean', value: true };
      }
      if (text.startsWith('false', i)) {
        i += 5;
        return { type: 'boolean', value: false };
      }
      if (text.startsWith('null', i)) {
        i += 4;
        return { type: 'null' };
      }
      fail(`意外的字符 “${ch}”`);
    }

    function parseObject(depth) {
      i++; // {
      const entries = [];
      const firstIndexByKey = new Map();
      skipWhitespace();
      if (text[i] === '}') {
        i++;
        return { type: 'object', entries };
      }
      while (true) {
        skipWhitespace();
        if (i >= n) fail('对象缺少右花括号');
        if (text[i] !== '"') fail('对象的 key 必须是双引号字符串');
        const keyIndex = i;
        const key = readString();
        skipWhitespace();
        if (text[i] !== ':') fail('对象 key 后缺少冒号');
        i++;
        const value = parseValue(depth);
        if (firstIndexByKey.has(key)) {
          const first = lineColumnAt(text, firstIndexByKey.get(key));
          fail(`对象中存在重复的 key ${JSON.stringify(key)}（首次出现在第 ${first.line} 行）`, keyIndex);
        }
        firstIndexByKey.set(key, keyIndex);
        entries.push({ key, value });
        skipWhitespace();
        if (text[i] === ',') {
          i++;
          skipWhitespace();
          if (text[i] === '}') fail('对象的最后一个成员后不允许多余的逗号', i);
          continue;
        }
        if (text[i] === '}') {
          i++;
          return { type: 'object', entries };
        }
        fail('对象的成员之间缺少逗号，或缺少右花括号');
      }
    }

    function parseArray(depth) {
      i++; // [
      const items = [];
      skipWhitespace();
      if (text[i] === ']') {
        i++;
        return { type: 'array', items };
      }
      while (true) {
        items.push(parseValue(depth));
        skipWhitespace();
        if (text[i] === ',') {
          i++;
          skipWhitespace();
          if (text[i] === ']') fail('数组的最后一个元素后不允许多余的逗号', i);
          continue;
        }
        if (text[i] === ']') {
          i++;
          return { type: 'array', items };
        }
        fail('数组的元素之间缺少逗号，或缺少右方括号');
      }
    }

    skipWhitespace();
    if (i >= n) fail('输入为空，请粘贴 JSON 文本', 0);
    const value = parseValue(0);
    skipWhitespace();
    if (i < n) fail('JSON 结束后还有多余内容', i);
    return value;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  function normalizeIndent(indent) {
    if (typeof indent === 'number') {
      const width = Math.max(0, Math.min(8, Math.floor(indent)));
      return width === 0 ? '' : ' '.repeat(width);
    }
    if (typeof indent === 'string') return indent;
    return '  ';
  }

  function formatJSON(node, indent = 2) {
    const unit = normalizeIndent(indent);
    if (unit === '') return minifyJSON(node);

    function format(node, depth) {
      if (!node) return 'null';
      switch (node.type) {
        case 'object': {
          if (node.entries.length === 0) return '{}';
          const pad = unit.repeat(depth);
          const childPad = unit.repeat(depth + 1);
          const body = node.entries.map((entry) =>
            childPad + JSON.stringify(entry.key) + ': ' + format(entry.value, depth + 1)
          ).join(',\n');
          return '{\n' + body + '\n' + pad + '}';
        }
        case 'array': {
          if (node.items.length === 0) return '[]';
          const pad = unit.repeat(depth);
          const childPad = unit.repeat(depth + 1);
          const body = node.items.map((item) => childPad + format(item, depth + 1)).join(',\n');
          return '[\n' + body + '\n' + pad + ']';
        }
        case 'string': return JSON.stringify(node.value);
        case 'number': return node.raw;
        case 'boolean': return node.value ? 'true' : 'false';
        case 'null': return 'null';
        default: return 'null';
      }
    }

    return format(node, 0);
  }

  function minifyJSON(node) {
    if (!node) return 'null';
    switch (node.type) {
      case 'object':
        return '{' + node.entries.map((entry) =>
          JSON.stringify(entry.key) + ':' + minifyJSON(entry.value)
        ).join(',') + '}';
      case 'array':
        return '[' + node.items.map(minifyJSON).join(',') + ']';
      case 'string': return JSON.stringify(node.value);
      case 'number': return node.raw;
      case 'boolean': return node.value ? 'true' : 'false';
      case 'null': return 'null';
      default: return 'null';
    }
  }

  // ---------------------------------------------------------------------------
  // Paths & numeric equality
  // ---------------------------------------------------------------------------

  const SIMPLE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function pathForKey(basePath, key) {
    if (SIMPLE_KEY.test(key)) return `${basePath}.${key}`;
    return `${basePath}[${JSON.stringify(key)}]`;
  }

  function canonicalNumber(raw) {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
    if (!match) return raw;
    const fraction = match[3] || '';
    let digits = match[2] + fraction;
    let exponent = BigInt(match[4] || '0') - BigInt(fraction.length);
    digits = digits.replace(/^0+/, '');
    if (digits === '') return '0';
    while (digits.endsWith('0')) {
      digits = digits.slice(0, -1);
      exponent += 1n;
    }
    return `${match[1] ? '-' : ''}${digits}e${exponent.toString()}`;
  }

  function numbersEqual(a, b) {
    return canonicalNumber(a.raw) === canonicalNumber(b.raw);
  }

  function nodesEqual(a, b) {
    if (!a || !b) return a === b;
    if (a.type !== b.type) return false;
    switch (a.type) {
      case 'object': {
        if (a.entries.length !== b.entries.length) return false;
        const bMap = new Map(b.entries.map((entry) => [entry.key, entry.value]));
        return a.entries.every((entry) => bMap.has(entry.key) && nodesEqual(entry.value, bMap.get(entry.key)));
      }
      case 'array':
        return a.items.length === b.items.length && a.items.every((item, index) => nodesEqual(item, b.items[index]));
      case 'string': return a.value === b.value;
      case 'number': return numbersEqual(a, b);
      case 'boolean': return a.value === b.value;
      case 'null': return true;
      default: return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Semantic diff (object key order is ignored)
  // ---------------------------------------------------------------------------

  function diffJSON(a, b) {
    const stats = { added: 0, removed: 0, changed: 0, same: 0 };
    let orderDiff = false;

    function markSubtree(path, label, depth, node, status) {
      const children = [];
      if (node.type === 'object') {
        for (const entry of node.entries) {
          children.push(markSubtree(
            pathForKey(path, entry.key), entry.key, depth + 1, entry.value, status
          ));
        }
      } else if (node.type === 'array') {
        node.items.forEach((item, index) => {
          children.push(markSubtree(`${path}[${index}]`, `[${index}]`, depth + 1, item, status));
        });
      }
      return {
        path,
        label,
        depth,
        status,
        a: status === 'removed' ? node : null,
        b: status === 'added' ? node : null,
        children,
        hasDiff: true
      };
    }

    function build(path, label, depth, aNode, bNode) {
      if (!aNode && bNode) {
        stats.added += countLeaves(bNode);
        return markSubtree(path, label, depth, bNode, 'added');
      }
      if (aNode && !bNode) {
        stats.removed += countLeaves(aNode);
        return markSubtree(path, label, depth, aNode, 'removed');
      }
      if (aNode.type !== bNode.type) {
        stats.changed += 1;
        return {
          path, label, depth, status: 'changed',
          a: aNode, b: bNode, children: [], hasDiff: true
        };
      }

      if (aNode.type === 'object') {
        const bMap = new Map(bNode.entries.map((entry) => [entry.key, entry.value]));
        const aKeys = aNode.entries.map((entry) => entry.key);
        const bKeys = bNode.entries.map((entry) => entry.key);
        const bKeySet = new Set(bKeys);
        const aKeySet = new Set(aKeys);
        const children = [];

        for (const entry of aNode.entries) {
          if (bMap.has(entry.key)) {
            children.push(build(
              pathForKey(path, entry.key), entry.key, depth + 1,
              entry.value, bMap.get(entry.key)
            ));
          } else {
            stats.removed += countLeaves(entry.value);
            children.push(markSubtree(
              pathForKey(path, entry.key), entry.key, depth + 1,
              entry.value, 'removed'
            ));
          }
        }
        for (const entry of bNode.entries) {
          if (!aKeySet.has(entry.key)) {
            stats.added += countLeaves(entry.value);
            children.push(markSubtree(
              pathForKey(path, entry.key), entry.key, depth + 1,
              entry.value, 'added'
            ));
          }
        }

        const changed = children.some((child) => child.status !== 'same');
        if (!changed && aKeys.length === bKeys.length && aKeys.every((key) => bKeySet.has(key))) {
          for (let index = 0; index < aKeys.length; index++) {
            if (aKeys[index] !== bKeys[index]) {
              orderDiff = true;
              break;
            }
          }
        }
        if (!children.length) stats.same += 1; // two empty objects
        return {
          path, label, depth,
          status: changed ? 'changed' : 'same',
          a: aNode, b: bNode, children,
          hasDiff: changed
        };
      }

      if (aNode.type === 'array') {
        const max = Math.max(aNode.items.length, bNode.items.length);
        const children = [];
        for (let index = 0; index < max; index++) {
          const pathItem = `${path}[${index}]`;
          const labelItem = `[${index}]`;
          if (index >= aNode.items.length) {
            stats.added += countLeaves(bNode.items[index]);
            children.push(markSubtree(pathItem, labelItem, depth + 1, bNode.items[index], 'added'));
          } else if (index >= bNode.items.length) {
            stats.removed += countLeaves(aNode.items[index]);
            children.push(markSubtree(pathItem, labelItem, depth + 1, aNode.items[index], 'removed'));
          } else {
            children.push(build(pathItem, labelItem, depth + 1, aNode.items[index], bNode.items[index]));
          }
        }
        const changed = children.some((child) => child.status !== 'same');
        if (!children.length) stats.same += 1; // two empty arrays
        return {
          path, label, depth,
          status: changed ? 'changed' : 'same',
          a: aNode, b: bNode, children,
          hasDiff: changed
        };
      }

      // Primitive values.
      let equal = false;
      if (aNode.type === 'number') equal = numbersEqual(aNode, bNode);
      else if (aNode.type === 'string') equal = aNode.value === bNode.value;
      else if (aNode.type === 'boolean') equal = aNode.value === bNode.value;
      else if (aNode.type === 'null') equal = true;

      if (!equal) stats.changed += 1;
      else stats.same += 1;

      return {
        path, label, depth,
        status: equal ? 'same' : 'changed',
        a: aNode, b: bNode, children: [],
        hasDiff: !equal
      };
    }

    const root = build('$', '$', 0, a, b);
    const equal = stats.added === 0 && stats.removed === 0 && stats.changed === 0;
    return {
      root,
      stats,
      equal,
      orderDiff: equal ? orderDiff : false
    };
  }

  // ---------------------------------------------------------------------------
  // Tree flattening
  // ---------------------------------------------------------------------------

  function defaultTreeExpanded(root) {
    const expanded = new Set();
    if (!root) return expanded;
    expanded.add('$');
    if (isContainer(root)) {
      const children = root.type === 'object'
        ? root.entries.map((entry) => ({ path: pathForKey('$', entry.key), value: entry.value }))
        : root.items.map((item, index) => ({ path: `$[${index}]`, value: item }));
      for (const child of children) {
        if (isContainer(child.value)) expanded.add(child.path);
      }
    }
    return expanded;
  }

  function allContainerPaths(root) {
    const paths = [];
    function walk(node, path, depth) {
      if (!isContainer(node)) return;
      paths.push(path);
      if (node.type === 'object') {
        for (const entry of node.entries) {
          walk(entry.value, pathForKey(path, entry.key), depth + 1);
        }
      } else {
        node.items.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      }
    }
    if (root) walk(root, '$', 0);
    return paths;
  }

  function flattenTree(root, expanded, maxRows = 8000) {
    const rows = [];
    let truncated = false;

    function walk(node, path, label, depth, isRoot) {
      if (!node) return;
      if (rows.length >= maxRows) {
        truncated = true;
        return;
      }
      const hasChildren = isContainer(node) &&
        (node.type === 'object' ? node.entries.length > 0 : node.items.length > 0);
      const isOpen = expanded.has(path);
      rows.push({
        node, path, label, depth, isRoot,
        hasChildren,
        expanded: hasChildren && isOpen,
        childCount: node.type === 'object' ? node.entries.length : (node.type === 'array' ? node.items.length : 0)
      });
      if (!hasChildren || !isOpen) return;
      if (node.type === 'object') {
        for (const entry of node.entries) {
          walk(entry.value, pathForKey(path, entry.key), entry.key, depth + 1, false);
          if (truncated) return;
        }
      } else {
        node.items.forEach((item, index) => {
          walk(item, `${path}[${index}]`, `[${index}]`, depth + 1, false);
        });
      }
    }

    if (root) walk(root, '$', '$', 0, true);
    return { rows, truncated };
  }

  // ---------------------------------------------------------------------------
  // Diff flattening
  // ---------------------------------------------------------------------------

  function defaultDiffExpanded(diff) {
    const expanded = new Set();
    if (!diff || !diff.root) return expanded;
    function walk(node) {
      if (!node) return;
      if (node.depth === 0) expanded.add(node.path);
      else if (node.children.length && node.status === 'changed' && node.depth <= 2) {
        expanded.add(node.path);
      }
      for (const child of node.children) walk(child);
    }
    walk(diff.root);
    return expanded;
  }

  function allDiffContainerPaths(diff) {
    const paths = [];
    function walk(node) {
      if (!node) return;
      if (node.children.length) paths.push(node.path);
      for (const child of node.children) walk(child);
    }
    if (diff) walk(diff.root);
    return paths;
  }

  function flattenDiff(diff, expanded, onlyDiff = true, maxRows = 8000) {
    const rows = [];
    let truncated = false;

    function walk(node) {
      if (!node) return;
      if (onlyDiff && node.status === 'same') return;
      if (rows.length >= maxRows) {
        truncated = true;
        return;
      }
      rows.push({
        ...node,
        expanded: node.children.length > 0 && expanded.has(node.path),
        childCount: node.children.length
      });
      if (!node.children.length || !expanded.has(node.path)) return;
      for (const child of node.children) walk(child);
    }

    walk(diff.root);
    return { rows, truncated };
  }

  // ---------------------------------------------------------------------------
  // Unescape
  // ---------------------------------------------------------------------------

  function unescapeRaw(text) {
    return text.replace(
      /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(["'\\/bfnrt])|(\r\n|\n|\r))/g,
      (match, codePointHex, unicodeHex, hex, simple, continuation) => {
        if (codePointHex !== undefined) {
          const cp = parseInt(codePointHex, 16);
          if (cp <= 0x10ffff) {
            try { return String.fromCodePoint(cp); } catch (_) { return match; }
          }
          return match;
        }
        if (unicodeHex !== undefined) return String.fromCharCode(parseInt(unicodeHex, 16));
        if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
        if (continuation !== undefined) return '';
        const map = {
          '"': '"', "'": "'", '\\': '\\', '/': '/',
          b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
        };
        return Object.prototype.hasOwnProperty.call(map, simple) ? map[simple] : match;
      }
    );
  }

  function tryParse(text) {
    try {
      return { value: parseJSON(text), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }

  function isJSONContainerText(text) {
    const trimmed = String(text).trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }

  function transformUnescape(text, mode = 'raw') {
    if (typeof text !== 'string') {
      return { output: '', note: '', error: '输入必须是字符串', validJSON: false, expansions: 0 };
    }
    if (!text.trim()) {
      return { output: '', note: '', error: '请先粘贴需要反转义的文本', validJSON: false, expansions: 0 };
    }

    if (mode === 'nested') {
      const parsed = tryParse(text);
      if (parsed.error) {
        return {
          output: '',
          note: '',
          error: `输入不是合法 JSON：第 ${parsed.error.line} 行第 ${parsed.error.column} 列，${parsed.error.message}`,
          validJSON: false,
          expansions: 0
        };
      }
      let expansions = 0;
      const seen = new Set();

      function expandValue(node, depth) {
        if (depth > 32) return node;
        if (node.type === 'string') {
          let candidate = node.value;
          const trimmed = candidate.trim();
          if (!isJSONContainerText(trimmed)) return node;
          if (trimmed.length > 8 * 1024 * 1024) return node;
          let nested = tryParse(trimmed);
          let usedUnescape = false;
          if (nested.error) {
            const unescaped = unescapeRaw(candidate).trim();
            if (isJSONContainerText(unescaped)) {
              const second = tryParse(unescaped);
              if (!second.error) {
                nested = second;
                usedUnescape = true;
              }
            }
          }
          if (nested.error || !nested.value || !isContainer(nested.value)) return node;
          if (seen.has(candidate) || expansions >= 1000) return node;
          seen.add(candidate);
          expansions += 1;
          const expanded = expandValue(nested.value, depth + 1);
          if (usedUnescape && expanded !== nested.value) {
            // The nested JSON was only valid after an extra unescape pass.
          }
          return expanded;
        }
        if (node.type === 'object') {
          return {
            type: 'object',
            entries: node.entries.map((entry) => ({
              key: entry.key,
              value: expandValue(entry.value, depth + 1)
            }))
          };
        }
        if (node.type === 'array') {
          return {
            type: 'array',
            items: node.items.map((item) => expandValue(item, depth + 1))
          };
        }
        return node;
      }

      const expandedRoot = expandValue(parsed.value, 0);
      return {
        output: formatJSON(expandedRoot, 2),
        note: expansions > 0
          ? `解析了 ${expansions} 个嵌套 JSON 字符串，并格式化为缩进 2 个空格的 JSON。`
          : '没有发现可展开的嵌套 JSON 字符串。',
        error: null,
        validJSON: true,
        expansions
      };
    }

    // Raw mode. Protect an already-valid JSON document so Unescape never
    // silently mangles ordinary JSON. A whole quoted JSON string is decoded.
    const trimmed = text.trim();
    if (isJSONContainerText(trimmed)) {
      const parsed = tryParse(text);
      if (!parsed.error) {
        return {
          output: formatJSON(parsed.value, 2),
          note: '输入本身已是合法 JSON，已保留其结构。若要展开内部的 JSON 字符串，请切换到「解析嵌套 JSON」。',
          error: null,
          validJSON: true,
          expansions: 0
        };
      }
    }

    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      const parsed = tryParse(trimmed);
      if (!parsed.error && parsed.value.type === 'string') {
        let output = parsed.value.value;
        const nested = tryParse(output);
        if (!nested.error && isContainer(nested.value)) {
          output = formatJSON(nested.value, 2);
        }
        return {
          output,
          note: '已按 JSON 字符串字面量解码。',
          error: null,
          validJSON: !nested.error,
          expansions: 0
        };
      }
    }

    const unescaped = unescapeRaw(text);
    const parsed = tryParse(unescaped);
    if (!parsed.error) {
      return {
        output: isContainer(parsed.value) ? formatJSON(parsed.value, 2) : unescaped,
        note: isContainer(parsed.value)
          ? '反转义成功，结果已格式化为 JSON。'
          : '反转义成功。',
        error: null,
        validJSON: true,
        expansions: 0
      };
    }

    return {
      output: unescaped,
      note: '反转义完成；结果不是合法 JSON，仍可复制或应用为纯文本。',
      error: null,
      validJSON: false,
      expansions: 0
    };
  }

  // ---------------------------------------------------------------------------
  // Syntax highlighting (tolerant of incomplete/invalid input)
  // ---------------------------------------------------------------------------

  function highlightJSON(text) {
    if (!text) return '';
    let output = '';
    let i = 0;
    const n = text.length;

    while (i < n) {
      const ch = text[i];

      if (ch === '"') {
        const start = i;
        i++;
        while (i < n) {
          if (text[i] === '\\') {
            i += 2;
          } else if (text[i] === '"') {
            i++;
            break;
          } else {
            i++;
          }
        }
        let lookahead = i;
        while (lookahead < n && /\s/.test(text[lookahead])) lookahead++;
        const isKey = text[lookahead] === ':';
        const content = escapeHTML(text.slice(start, Math.min(i, n)));
        output += `<span class="${isKey ? 'tok-key' : 'tok-string'}">${content}</span>`;
        continue;
      }

      if (ch === '-' || (ch >= '0' && ch <= '9')) {
        const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
        if (match) {
          output += `<span class="tok-number">${escapeHTML(match[0])}</span>`;
          i += match[0].length;
          continue;
        }
      }

      if (text.startsWith('true', i)) {
        output += '<span class="tok-boolean">true</span>';
        i += 4;
        continue;
      }
      if (text.startsWith('false', i)) {
        output += '<span class="tok-boolean">false</span>';
        i += 5;
        continue;
      }
      if (text.startsWith('null', i)) {
        output += '<span class="tok-null">null</span>';
        i += 4;
        continue;
      }

      if ('{}[],:'.includes(ch)) {
        output += `<span class="tok-punct">${escapeHTML(ch)}</span>`;
        i++;
        continue;
      }

      output += escapeHTML(ch);
      i++;
    }

    return output;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    JSONParseError,
    parseJSON,
    formatJSON,
    minifyJSON,
    diffJSON,
    nodesEqual,
    numbersEqual,
    canonicalNumber,
    pathForKey,
    typeLabel,
    describeNode,
    stringPreview,
    countNodes,
    countLeaves,
    byteLength,
    formatBytes,
    defaultTreeExpanded,
    allContainerPaths,
    flattenTree,
    defaultDiffExpanded,
    allDiffContainerPaths,
    flattenDiff,
    unescapeRaw,
    transformUnescape,
    highlightJSON,
    escapeHTML,
    isContainer,
    lineColumnAt
  };
});
