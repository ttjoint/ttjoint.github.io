'use strict';
/**
 * Tests for the structured-extraction helpers.
 *
 * This logic decides what a scraped profile turns into before a human reviews
 * it, so the failure mode is subtle: a wrong suffix strip merges two different
 * people, or a death date gets invented. Both are pinned below.
 */

const test = require('node:test');
const assert = require('node:assert');

const s = require('../../src/importers/structured');

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

test('canon: birthDate drops the trailing 出生/生 decoration', () => {
  assert.strictEqual(s.canonicalise('birthDate', '1955年3月出生'), '1955年3月');
  assert.strictEqual(s.canonicalise('birthDate', '1955年3月 生'), '1955年3月');
  // Internal spaces are noise, not data.
  assert.strictEqual(s.canonicalise('birthDate', '1955 年 3 月'), '1955年3月');
});

test('canon: nativePlace drops the trailing 人/籍', () => {
  assert.strictEqual(s.canonicalise('nativePlace', '江苏南京人'), '江苏南京');
  assert.strictEqual(s.canonicalise('nativePlace', '江苏南京籍'), '江苏南京');
  // A place whose real name ends in 人 must not be truncated mid-word.
  assert.strictEqual(s.canonicalise('nativePlace', '山西人'), '山西');
});

test('canon: name loses internal whitespace', () => {
  assert.strictEqual(s.canonicalise('name', ' 习 近 平 '), '习近平');
});

test('canon: unknown fields are only trimmed', () => {
  assert.strictEqual(s.canonicalise('summary', '  某 人  '), '某 人');
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('normalise: empty strings and nulls are dropped, not stored as blank', () => {
  const out = s.normalise({ name: '张三', gender: '', summary: null, confidence: 0 });
  assert.deepStrictEqual(Object.keys(out).sort(), ['confidence', 'name']);
  assert.strictEqual(out.confidence, 0, 'a numeric 0 must survive');
});

test('normalise: arrays of objects lose empty entries', () => {
  const out = s.normalise({
    name: '李四',
    career: [
      { date: '2010', organization: '某部', role: '处长' },
      { date: '', organization: '', role: '' },   // entirely empty -> dropped
      null,                                         // junk -> dropped
      { date: '2015', organization: '  ', role: '主任' }, // partial -> kept, blanks trimmed
    ],
  });
  assert.strictEqual(out.career.length, 2);
  // Blank fields inside a kept row are removed rather than stored as ''.
  assert.deepStrictEqual(out.career[1], { date: '2015', role: '主任' });
});

test('normalise: an array that empties out is dropped entirely', () => {
  const out = s.normalise({ name: '王五', career: [{}] });
  assert.ok(!('career' in out));
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('requireStructured: rejects non-objects and a missing name', () => {
  assert.throws(() => s.requireStructured(null), /non-object/);
  assert.throws(() => s.requireStructured('[]'), /non-object/);
  assert.throws(() => s.requireStructured({}), /missing name/);
  assert.throws(() => s.requireStructured({ name: '   ' }), /missing name/);
});

test('requireStructured: rejects an array field that is not an array', () => {
  assert.throws(() => s.requireStructured({ name: '甲', career: 'x' }), /career must be array/);
  assert.throws(() => s.requireStructured({ name: '甲', currentPositions: {} }), /currentPositions must be array/);
});

test('requireStructured: a valid payload comes back normalised', () => {
  const out = s.requireStructured({ name: ' 张三 ', birthDate: '1960年1月生', currentPositions: [] });
  assert.strictEqual(out.name, '张三');
  assert.strictEqual(out.birthDate, '1960年1月');
  assert.ok(!('currentPositions' in out), 'an empty array carries no information');
});

// ---------------------------------------------------------------------------
// Rule-based fallback
// ---------------------------------------------------------------------------

test('rules: pull birth date and native place out of plain text', () => {
  const out = s.extractByRules('张三', '张三，男，1960年1月出生，籍贯：江苏南京，现任某职。', 'https://example.gov.cn/a');
  assert.strictEqual(out.birthDate, '1960年1月');
  assert.strictEqual(out.nativePlace, '江苏南京');
  assert.strictEqual(out.sourceUrl, 'https://example.gov.cn/a');
});

test('rules: missing facts stay absent rather than guessed', () => {
  const out = s.extractByRules('李四', '李四，男，现任某职。', 'https://example.gov.cn/b');
  assert.ok(!('birthDate' in out));
  assert.ok(!('nativePlace' in out));
  assert.strictEqual(out.name, '李四');
});

// ---------------------------------------------------------------------------
// Death enrichment
// ---------------------------------------------------------------------------

test('death: only fires when the text states it', () => {
  const alive = s.enrichDeath({ name: '甲' }, '甲，男，现任某职。');
  assert.ok(!('deceased' in alive));

  const dead = s.enrichDeath({ name: '乙' }, '乙同志于2023年5月逝世，享年80岁。');
  assert.strictEqual(dead.deceased, true);
  assert.strictEqual(dead.deceasedDate, '2023年5月');
});

test('death: appends the date to the summary exactly once', () => {
  const once = s.enrichDeath({ name: '丙', summary: '某部原部长。' }, '丙于2021年2月病逝。');
  assert.strictEqual(once.summary, '某部原部长。（2021年2月逝世）');

  // Running enrichment twice must not double the tag.
  const twice = s.enrichDeath(once, '丙于2021年2月病逝。');
  assert.strictEqual(twice.summary, once.summary);
});

test('death: does not mutate the input candidate', () => {
  const input = { name: '丁', summary: '简介。' };
  const out = s.enrichDeath(input, '丁于2020年1月去世。');
  assert.ok(!('deceased' in input), 'input must be left alone');
  assert.strictEqual(out.deceased, true);
});

// ---------------------------------------------------------------------------
// Fence stripping
// ---------------------------------------------------------------------------

test('fences: markdown code fences are removed', () => {
  assert.strictEqual(s.stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.strictEqual(s.stripFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.strictEqual(s.stripFences('{"a":1}'), '{"a":1}');
  assert.strictEqual(s.stripFences(null), '');
});
