'use strict';
// Tests of main.js's pure functions, with Obsidian and CodeMirror stubbed: `node tests/run.js` from the plugin's folder.
const Module = require('module');
const assert = require('assert');
const path = require('path');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    class Stub {}
    return { Plugin: Stub, PluginSettingTab: Stub, Setting: Stub, Notice: Stub, MarkdownView: Stub, Platform: {}, TFile: Stub };
  }
  if (request.startsWith('@codemirror/')) return { Decoration: {}, ViewPlugin: {}, RangeSetBuilder: Stub2, syntaxTree() {}, tokenClassNodeProp: {} };
  return realLoad.call(this, request, ...rest);
};
function Stub2() {}

const { internals } = require(path.join(__dirname, '..', 'main.js'));
const { markerLine, citationsIn, skipFolders, inFolders, danglingReport } = internals;

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const keys = (text) => citationsIn(text).map((c) => `${c.key}:${c.line}`);

test('marker with printed label and PDF page', () => {
  const text = 'a\n<!-- page 203 (213 / 595) -->\nb\n<!-- page 204 (214 / 595) -->\nc';
  assert.strictEqual(markerLine(text, '204'), 3);
  assert.strictEqual(markerLine(text, 214), -1, 'the PDF page is not the label');
});

test('marker without printed labels', () => {
  assert.strictEqual(markerLine('x\n<!-- page 3 / 9 -->\ny', '3'), 1);
  assert.strictEqual(markerLine('<!-- page 13 / 90 -->', '3'), -1, 'no prefix match');
});

test('roman page labels and a missing page', () => {
  assert.strictEqual(markerLine('<!-- page xii (12 / 300) -->', 'xii'), 0);
  assert.strictEqual(markerLine('<!-- caption: page 4 -->\ntext', '4'), -1);
});

test('keys with digits and hyphens are kept whole', () => {
  assert.deepStrictEqual(keys('As [@iso-12345-6, p. 4] and @smith2020a say.'), ['iso-12345-6:1', 'smith2020a:1']);
});

test('keys ending a sentence and with underscores', () => {
  assert.deepStrictEqual(keys('See @scipy_distance.\n[@ab; @b2]'), ['scipy_distance:1', 'ab:2', 'b2:2']);
});

test('addresses and handles are not citations', () => {
  assert.deepStrictEqual(keys('mail me@example.com or https://medium.com/@writer or x@y'), []);
  // `[[@key, p. 4]]` is a citation written as a link to the source's literature note: it counts
  assert.deepStrictEqual(keys('a link [[@linked2020, p. 4]] and [@real]'), ['linked2020:1', 'real:1']);
});

test('properties, code and math are skipped, lines kept', () => {
  const text = [
    '---',
    'note: "@notakey"',
    '---',
    'Text @real1.',
    '```python',
    '@decorator',
    '```',
    'Inline `@code` and $@math$ but @real2',
    '$$',
    '@inmath',
    '$$',
    '- [@real3, p. 2]',
  ].join('\n');
  assert.deepStrictEqual(keys(text), ['real1:4', 'real2:8', 'real3:12']);
});

test('money is not math', () => {
  assert.deepStrictEqual(keys('It cost $5 and $10 per @cost2021 run.'), ['cost2021:1']);
});

test('folders to skip', () => {
  const f = skipFolders('Sources\n /Templates/ , Archive');
  assert.deepStrictEqual(f, ['Sources', 'Templates', 'Archive']);
  assert.ok(inFolders('Sources/a.md', f));
  assert.ok(!inFolders('SourcesOld/a.md', f));
});

test('report lists each key with its notes and lines', () => {
  const missing = new Map([['zz', [{ path: 'A/b.md', lines: [3, 9] }]], ['aa', [{ path: 'c.md', lines: [1] }]]]);
  const text = danglingReport({ missing, ambiguous: new Map([['dup', 2]]), checkedWith: 'Zotero', keys: 5, notes: 2, when: 'now' });
  assert.ok(text.indexOf('## @aa') < text.indexOf('## @zz'), 'sorted by key');
  assert.ok(text.includes('- [[A/b|b]], lines 3, 9'));
  assert.ok(text.includes('- [[c|c]], line 1'));
  assert.ok(text.includes('- @dup: 2 items'));
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
