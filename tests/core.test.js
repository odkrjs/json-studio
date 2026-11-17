'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = require(path.join(__dirname, '..', 'Resources', 'core.js'));

function parse(text) {
  return core.parseJSON(text);
}

test('parses all JSON value types', () => {
  const value = parse('{"s":"中文","n":-12.5e2,"b":true,"z":null,"a":[1,2],"o":{}}');
  assert.equal(value.type, 'object');
  assert.equal(value.entries[0].key, 's');
  assert.equal(value.entries[0].value.value, '中文');
  assert.equal(value.entries[1].value.raw, '-12.5e2');
  assert.equal(value.entries[2].value.value, true);
  assert.equal(value.entries[3].value.type, 'null');
  assert.equal(value.entries[4].value.items.length, 2);
  assert.equal(value.entries[5].value.entries.length, 0);
});

test('formats and minifies while preserving key order and number spelling', () => {
  const value = parse('{"z":1e3,"a":{"b":[1,2]},"m":0.50}');
  const pretty = core.formatJSON(value, 2);
  assert.equal(pretty, [
    '{',
    '  "z": 1e3,',
    '  "a": {',
    '    "b": [',
    '      1,',
    '      2',
    '    ]',
    '  },',
    '  "m": 0.50',
    '}'
  ].join('\n'));
  assert.equal(core.minifyJSON(value), '{"z":1e3,"a":{"b":[1,2]},"m":0.50}');
  assert.equal(core.formatJSON(value, 4).split('\n')[1], '    "z": 1e3,');
});

test('parses escaped strings and surrogate pairs', () => {
  const value = parse('"a\\n\\u4F60\\u597D\\uD83D\\uDE00"');
  assert.equal(value.value, 'a\n你好😀');
});

test('reports useful parse positions', () => {
  assert.throws(
    () => parse('{\n  "a": 1,\n  "b": 2\n  "c": 3\n}'),
    (error) => {
      assert.equal(error.name, 'JSONParseError');
      assert.equal(error.line, 4);
      assert.match(error.message, /逗号|右花括号/);
      return true;
    }
  );
});

test('rejects duplicate keys, trailing commas and leading zeroes', () => {
  assert.throws(() => parse('{"a":1,"a":2}'), /重复的 key/);
  assert.throws(() => parse('[1,2,]'), /多余的逗号/);
  assert.throws(() => parse('{"a":1,}'), /多余的逗号/);
  assert.throws(() => parse('01'), /前导零/);
  assert.throws(() => parse('{"a":1} x'), /多余内容/);
  assert.throws(() => parse('   '), /输入为空/);
});

test('canonicalizes numbers for semantic equality', () => {
  assert.equal(core.canonicalNumber('1'), core.canonicalNumber('1.0'));
  assert.equal(core.canonicalNumber('100'), core.canonicalNumber('1e2'));
  assert.equal(core.canonicalNumber('-0'), core.canonicalNumber('0'));
  assert.equal(core.canonicalNumber('0.00120'), core.canonicalNumber('1.2e-3'));
  assert.notEqual(core.canonicalNumber('1'), core.canonicalNumber('1.0000001'));
});

test('builds readable paths', () => {
  assert.equal(core.pathForKey('$', 'user'), '$.user');
  assert.equal(core.pathForKey('$', 'user-name'), '$["user-name"]');
  assert.equal(core.pathForKey('$.a', '0'), '$.a["0"]');
  assert.equal(core.pathForKey('$', 'line\nbreak'), '$["line\\nbreak"]');
});

test('diff ignores object key order entirely', () => {
  const a = parse('{"a":1,"b":{"x":true,"y":[1,2]}}');
  const b = parse('{"b":{"y":[1,2],"x":true},"a":1}');
  const diff = core.diffJSON(a, b);
  assert.equal(diff.equal, true);
  assert.equal(diff.orderDiff, true);
  assert.equal(diff.stats.added, 0);
  assert.equal(diff.stats.removed, 0);
  assert.equal(diff.stats.changed, 0);
  assert.ok(diff.stats.same >= 4);
});

test('diff reports added, removed and changed leaves', () => {
  const a = parse('{"id":1,"name":"old","tags":["a","b"],"gone":{"x":1}}');
  const b = parse('{"id":"1","name":"new","tags":["a","c","d"],"extra":{"p":1,"q":2}}');
  const diff = core.diffJSON(a, b);
  assert.equal(diff.equal, false);
  assert.equal(diff.stats.changed, 3); // id type change, name, tags[1]
  assert.equal(diff.stats.removed, 1); // gone.x
  // tags[2] = 1, extra.p + extra.q = 2
  assert.equal(diff.stats.added, 3);
  assert.equal(diff.stats.removed, 1);
  assert.equal(diff.stats.changed, 3);
});

test('arrays are compared by index and extra elements are marked', () => {
  const diff = core.diffJSON(parse('[1,2,3]'), parse('[1,9,3,4]'));
  assert.equal(diff.stats.changed, 1);
  assert.equal(diff.stats.added, 1);
  assert.equal(diff.stats.removed, 0);
  const changed = diff.root.children.find((child) => child.path === '$[1]');
  assert.equal(changed.status, 'changed');
});

test('string escapes are compared by decoded value, not spelling', () => {
  const diff = core.diffJSON(parse('{"x":"中"}'), parse('{"x":"\\u4e2d"}'));
  assert.equal(diff.equal, true);
  assert.equal(diff.stats.same, 1);
});

test('numbers are compared by numeric value', () => {
  const diff = core.diffJSON(parse('{"x":1.0}'), parse('{"x":1}'));
  assert.equal(diff.equal, true);
  assert.equal(core.diffJSON(parse('{"x":1}'), parse('{"x":2}')).stats.changed, 1);
});

test('empty containers compare equal and count once', () => {
  const diff = core.diffJSON(parse('{"a":{},"b":[]}'), parse('{"b":[],"a":{}}'));
  assert.equal(diff.equal, true);
  assert.equal(diff.stats.same, 2);
});

test('tree flattening respects expansion state', () => {
  const root = parse('{"a":{"b":{"c":1}},"d":[true]}');
  const expanded = core.defaultTreeExpanded(root);
  let flat = core.flattenTree(root, expanded);
  assert.ok(flat.rows.some((row) => row.path === '$.a.b'));
  assert.ok(flat.rows.some((row) => row.path === '$.d[0]'));
  assert.ok(!flat.rows.some((row) => row.path === '$.a.b.c'));

  const all = new Set(core.allContainerPaths(root));
  flat = core.flattenTree(root, all);
  assert.ok(flat.rows.some((row) => row.path === '$.a.b.c'));
});

test('diff flattening hides unchanged nodes when requested', () => {
  const diff = core.diffJSON(
    parse('{"same":1,"change":1,"remove":2}'),
    parse('{"same":1,"change":2,"add":3}')
  );
  const expanded = new Set(core.allDiffContainerPaths(diff));
  const onlyDiff = core.flattenDiff(diff, expanded, true);
  assert.ok(!onlyDiff.rows.some((row) => row.path === '$.same'));
  assert.ok(onlyDiff.rows.some((row) => row.path === '$.change'));
  assert.ok(onlyDiff.rows.some((row) => row.path === '$.remove'));
  assert.ok(onlyDiff.rows.some((row) => row.path === '$.add'));

  const full = core.flattenDiff(diff, expanded, false);
  assert.ok(full.rows.some((row) => row.path === '$.same'));
});

test('flattening truncates very large trees', () => {
  const items = Array.from({ length: 100 }, (_, i) => `{"i":${i}}`).join(',');
  const root = parse(`[${items}]`);
  const flat = core.flattenTree(root, new Set(['$', ...Array.from({ length: 100 }, (_, i) => `$[${i}]`)]), 10);
  assert.equal(flat.rows.length, 10);
  assert.equal(flat.truncated, true);
});

test('raw unescape handles common sequences and keeps unknown escapes', () => {
  assert.equal(core.unescapeRaw('{\\"a\\":\\"中\\"}'), '{"a":"中"}');
  assert.equal(core.unescapeRaw('a\\nb\\tc'), 'a\nb\tc');
  assert.equal(core.unescapeRaw('\\u4F60\\u597D'), '你好');
  assert.equal(core.unescapeRaw('\\uD83D\\uDE00'), '😀');
  assert.equal(core.unescapeRaw('\\u{1F680}'), '🚀');
  assert.equal(core.unescapeRaw('C:\\\\tmp'), 'C:\\tmp');
  assert.equal(core.unescapeRaw('line\\\ncontinuation'), 'linecontinuation');
  assert.equal(core.unescapeRaw('\\q'), '\\q');
});

test('raw unescape turns a globally escaped document into formatted JSON', () => {
  const result = core.transformUnescape('{\\"name\\":\\"张三\\",\\"ok\\":true}', 'raw');
  assert.equal(result.error, null);
  assert.equal(result.validJSON, true);
  assert.equal(result.output, '{\n  "name": "张三",\n  "ok": true\n}');
});

test('raw unescape decodes a quoted JSON string literal', () => {
  const result = core.transformUnescape('"{\\"a\\":[1,2]}"', 'raw');
  assert.equal(result.validJSON, true);
  assert.match(result.output, /"a": \[/);
});

test('raw unescape protects an already valid JSON document', () => {
  const input = '{"a":1}';
  const result = core.transformUnescape(input, 'raw');
  assert.equal(result.output, '{\n  "a": 1\n}');
  assert.equal(result.validJSON, true);
  assert.match(result.note, /已是合法 JSON/);
});

test('nested unescape expands JSON strings and reports a count', () => {
  const input = JSON.stringify({
    id: 7,
    payload: JSON.stringify({ user: '张三', tags: ['a'] }),
    list: [JSON.stringify([1, 2])],
    plain: 'hello'
  });
  const result = core.transformUnescape(input, 'nested');
  assert.equal(result.error, null);
  assert.equal(result.expansions, 2);
  const root = parse(result.output);
  const payload = root.entries.find((entry) => entry.key === 'payload').value;
  assert.equal(payload.type, 'object');
  assert.equal(payload.entries.find((entry) => entry.key === 'user').value.value, '张三');
  assert.equal(root.entries.find((entry) => entry.key === 'list').value.items[0].type, 'array');
});

test('nested unescape handles double-escaped JSON', () => {
  const input = JSON.stringify({ payload: '{\\"a\\":1}' });
  const result = core.transformUnescape(input, 'nested');
  assert.equal(result.error, null);
  assert.equal(result.expansions, 1);
  assert.match(result.output, /"a": 1/);
});

test('nested unescape rejects invalid JSON', () => {
  const result = core.transformUnescape('{"a":}', 'nested');
  assert.match(result.error, /不是合法 JSON/);
  assert.equal(result.output, '');
});

test('highlighting escapes HTML and marks JSON tokens', () => {
  const html = core.highlightJSON('{"key":"<tag>&\\n","n":1,"b":true,"z":null}');
  assert.match(html, /class="tok-key"/);
  assert.match(html, /class="tok-string"/);
  assert.match(html, /class="tok-number"/);
  assert.match(html, /class="tok-boolean"/);
  assert.match(html, /class="tok-null"/);
  assert.match(html, /&lt;tag&gt;&amp;/);
  assert.match(html, /\\n/);
  assert.doesNotMatch(html, /<tag>/);
});

test('describes nodes and counts bytes', () => {
  const root = parse('{"a":[1,2],"b":{}}');
  assert.equal(core.countNodes(root), 5);
  assert.equal(core.countLeaves(root), 3);
  assert.equal(core.describeNode(root), '{ 2 个字段 }');
  assert.equal(core.byteLength('中'), 3);
  assert.equal(core.formatBytes(2048), '2.0 KB');
});

// ---------------------------------------------------------------------------
// Deterministic property tests
// ---------------------------------------------------------------------------

function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomString(random) {
  const pool = ['a', 'Z', '中', '🚀', '"', '\\', '\n', '\t', '/', ' ', '0', '-'];
  const length = Math.floor(random() * 8);
  let result = '';
  for (let i = 0; i < length; i++) result += pool[Math.floor(random() * pool.length)];
  return result;
}

function randomValue(random, depth) {
  if (depth <= 0) {
    const kind = Math.floor(random() * 4);
    if (kind === 0) return null;
    if (kind === 1) return random() > 0.5;
    if (kind === 2) return Math.round((random() - 0.5) * 100000) / 100;
    return randomString(random);
  }
  const kind = Math.floor(random() * 5);
  if (kind === 0) return null;
  if (kind === 1) return randomString(random);
  if (kind === 2) return Math.floor((random() - 0.5) * 1e6);
  if (kind === 3) {
    return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(random, depth - 1));
  }
  const entries = [];
  const used = new Set();
  const count = Math.floor(random() * 5);
  for (let i = 0; i < count; i++) {
    let key = randomString(random).slice(0, 3) || 'k';
    while (used.has(key)) key += 'x';
    used.add(key);
    entries.push({ key, value: randomValue(random, depth - 1) });
  }
  return { type: 'object', entries };
}

function nodeToJS(node) {
  if (node.type === 'object') {
    const out = {};
    for (const entry of node.entries) out[entry.key] = nodeToJS(entry.value);
    return out;
  }
  if (node.type === 'array') return node.items.map(nodeToJS);
  if (node.type === 'number') return Number(node.raw);
  if (node.type === 'null') return null;
  return node.value;
}

function shuffledObject(value, random) {
  if (Array.isArray(value)) return value.map((item) => shuffledObject(item, random));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const out = {};
    for (const key of keys) out[key] = shuffledObject(value[key], random);
    return out;
  }
  return value;
}

test('random JSON round-trips through parse, format and minify', () => {
  const random = makeRandom(20261117);
  for (let i = 0; i < 250; i++) {
    const value = randomValue(random, 4);
    const source = JSON.stringify(value);
    const parsed = parse(source);
    assert.ok(core.nodesEqual(parsed, parse(core.formatJSON(parsed, 2))));
    assert.ok(core.nodesEqual(parsed, parse(core.minifyJSON(parsed))));
    assert.deepEqual(nodeToJS(parsed), value);
  }
});

test('random object key reordering never changes semantic diff', () => {
  const random = makeRandom(424242);
  for (let i = 0; i < 200; i++) {
    const value = randomValue(random, 4);
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const shuffled = shuffledObject(value, random);
    const diff = core.diffJSON(parse(JSON.stringify(value)), parse(JSON.stringify(shuffled)));
    assert.equal(diff.equal, true, `diff should ignore order for ${JSON.stringify(value)}`);
  }
});

test('random strings survive a JSON unescape round-trip', () => {
  const random = makeRandom(7);
  for (let i = 0; i < 300; i++) {
    const value = randomString(random);
    const escapedBody = JSON.stringify(value).slice(1, -1);
    assert.equal(core.unescapeRaw(escapedBody), value);
  }
});
