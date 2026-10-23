'use strict';
/**
 * Tests for CBDB kinship → predicate derivation.
 *
 * These tests exist because this repo previously shipped two hand-written
 * kinship tables that were partly fabricated, and the bug was invisible: the
 * data imported cleanly, it was just wrong. The tests below pin the specific
 * mistakes so they cannot come back:
 *
 *   - `scripts/import_cbdb.js` mapped code 75 (父) and 111 (母) to 子女.
 *   - `src/importers/cbdb.js` mapped code 63 (妻之祖父) to teacherOf,
 *     64 (伯叔祖) to studentOf, 165/166 (長兄/季弟) to friend, and referenced
 *     code 300 which CBDB does not define.
 *
 * Where possible we assert against the real CBDB database, not a fixture, so
 * the mapping stays honest if CBDB is upgraded.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const kinship = require('../../src/importers/cbdb_kinship');

const DB_PATH = path.join(__dirname, '..', '..', 'cbdb_20260801', 'cbdb_20260801.sqlite3');
const hasDb = fs.existsSync(DB_PATH);

/** Load the real CBDB database, or return null when unavailable. */
async function loadDb() {
  if (!hasDb) return null;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', f),
  });
  return new SQL.Database(fs.readFileSync(DB_PATH));
}

function readRows(db, table) {
  const st = db.prepare('SELECT * FROM "' + table + '"');
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

// ---------------------------------------------------------------------------
// Pure derivation rules (no database needed)
// ---------------------------------------------------------------------------

test('single-step symbols map to dedicated predicates', () => {
  // 映射到具体谓词，不降级到 `sibling`/`spouse` 兜底。
  //
  // `B`/`Z` 已经说了性别，降到 `sibling` 等于把已知信息丢掉；
  // `H`/`W` 已说了是夫还是妻，降到 `spouse` 同理。
  // 设计 §8.4 裁定 brother/sister/husband/wife 是基础原语。
  const cases = [
    ['F', 'father'], ['M', 'mother'],
    ['S', 'maleChild'], ['D', 'femaleChild'],
    ['B', 'brother'], ['Z', 'sister'],
    ['H', 'husband'], ['W', 'wife'],
    // `C`（妾）不新设谓词（§8.4 实施修正）：
    // `郭氏 --concubine--> 劉仁` 会读作「郭氏的妾是刘仁」，荒谬。
    ['C', 'husband'],
  ];
  for (const [sym, expected] of cases) {
    const d = kinship.derivePredicate({ c_kincode: 1, c_kinrel: sym, c_kinrel_chn: sym });
    assert.strictEqual(d.key, expected, `${sym} should map to ${expected}`);
    assert.strictEqual(d.resolved, true, `${sym} should be resolved`);
  }

  // `A`（姻親）与 `U`（未詳）、`G`/`K`/`P` 一样说不出具体关系，
  // key 为 null、不出边。「姻親」不是一类关系，是「不知道是哪种」。
  const a = kinship.derivePredicate({ c_kincode: 117, c_kinrel: 'A', c_kinrel_chn: '姻親' });
  assert.strictEqual(a.key, null, 'A 姻親不得映射到任何谓词');
});

test('parent symbols never map to child predicates (the inversion bug)', () => {
  // Code 75 = 父, code 111 = 母 in CBDB. The old scripts table mapped both to 子女.
  const father = kinship.derivePredicate({ c_kincode: 75, c_kinrel: 'F', c_kinrel_chn: '父' });
  const mother = kinship.derivePredicate({ c_kincode: 111, c_kinrel: 'M', c_kinrel_chn: '母' });
  assert.strictEqual(father.key, 'father');
  assert.strictEqual(mother.key, 'mother');

  const childish = ['maleChild', 'femaleChild', 'childOfFather', 'childOfMother'];
  assert.ok(!childish.includes(father.key), '父亲 must not become a child predicate');
  assert.ok(!childish.includes(mother.key), '母亲 must not become a child predicate');
});

test('the fabricated social mappings are gone', () => {
  // 妻之祖父 is a wife's grandfather, not a teacher.
  const c63 = kinship.derivePredicate({ c_kincode: 63, c_kinrel: 'WFF', c_kinrel_chn: '妻之祖父' });
  assert.notStrictEqual(c63.key, 'teacherOf');
  // 复合路径不是谓词，key 为 null（由单步边组合，§8.6）。
  assert.strictEqual(c63.key, null);

  // 伯叔祖 is a great-uncle, not a student.
  const c64 = kinship.derivePredicate({ c_kincode: 64, c_kinrel: 'FFB', c_kinrel_chn: '從祖;伯叔祖' });
  assert.notStrictEqual(c64.key, 'studentOf');
  assert.strictEqual(c64.key, null);

  // 長兄 / 季弟 are brothers, not friends.
  const c165 = kinship.derivePredicate({ c_kincode: 165, c_kinrel: 'B1', c_kinrel_chn: '長兄' });
  const c166 = kinship.derivePredicate({ c_kincode: 166, c_kinrel: 'By', c_kinrel_chn: '季弟' });
  assert.notStrictEqual(c165.key, 'friend');
  assert.notStrictEqual(c166.key, 'friend');
  // `brother` 而不是 `kin`：数字 1 / y 只是长幼（无法与谓词表对应），
  // 基础字母 B 本身已经明说是兄弟。这里曾一律降成 `kin`，与下面 Tier 2
  // 的注释（"we know it is a sibling"）矛盾，实测 `B+/B-` 共 86,219 行
  // 因此凭空变成了「知道是亲属但说不出哪种」。长幼丢失是**已知的信息缺失**，
  // 不是「不知道是什么关系」。
  assert.strictEqual(c165.key, 'brother');
  assert.strictEqual(c166.key, 'brother');
});

test('multi-step chains keep the generational path', () => {
  const gt = kinship.derivePredicate({ c_kincode: 62, c_kinrel: 'FF', c_kinrel_chn: '祖父' });
  assert.strictEqual(gt.key, null, '复合路径不建边，也不是谓词');
  assert.deepStrictEqual(gt.chain, ['F', 'F']);
  assert.strictEqual(gt.chainLabel, '祖父');

  const gg = kinship.derivePredicate({ c_kincode: 48, c_kinrel: 'FFF', c_kinrel_chn: '曾祖' });
  assert.deepStrictEqual(gg.chain, ['F', 'F', 'F']);

  const wff = kinship.derivePredicate({ c_kincode: 63, c_kinrel: 'WFF', c_kinrel_chn: '妻之祖父' });
  assert.deepStrictEqual(wff.chain, ['W', 'F', 'F'], 'wife is recorded as a step, not dropped');
});

test('modifiers keep the predicate but are flagged', () => {
  const elder = kinship.derivePredicate({ c_kincode: 165, c_kinrel: 'B1', c_kinrel_chn: '長兄' });
  assert.strictEqual(elder.resolved, true);
  assert.strictEqual(elder.modified, true);
  assert.deepStrictEqual(elder.chain, ['B']);

  // Placeholder depth (G-n = 直系祖先 of unknown depth) is still a real step.
  const anc = kinship.derivePredicate({ c_kincode: 2, c_kinrel: 'G-n', c_kinrel_chn: '直系祖先' });
  assert.strictEqual(anc.resolved, true);
  assert.deepStrictEqual(anc.chain, ['G']);
});

test('CBDB sentinel rows are rejected, not parsed as letters', () => {
  // "[missing data]" literally contains M, S, G, D, A — it must not become a path.
  const missing = kinship.derivePredicate({
    c_kincode: -1, c_kinrel: '[missing data]', c_kinrel_chn: '[missing data]',
  });
  assert.strictEqual(missing.resolved, false);
  assert.deepStrictEqual(missing.chain, []);

  const na = kinship.derivePredicate({
    c_kincode: -10000, c_kinrel: '\t\r\nNot Applicable', c_kinrel_chn: '非可用',
  });
  assert.strictEqual(na.resolved, false);
  assert.deepStrictEqual(na.chain, []);
});

test('unknown codes yield no edge, never a guess', () => {
  const custom = new Map();
  assert.strictEqual(kinship.kinshipCoverage(custom).total, 0);
  const d = kinship.derivePredicate({ c_kincode: 99999, c_kinrel: '', c_kinrel_chn: '' });
  assert.strictEqual(d.key, null, '未知码不得猜成任何谓词');
  assert.strictEqual(d.resolved, false);
});

// ---------------------------------------------------------------------------
// Against the real CBDB database
// ---------------------------------------------------------------------------

test('every CBDB kinship code is classified', async (t) => {
  const db = await loadDb();
  if (!db) return t.skip('CBDB database not present');

  const map = kinship.buildKinshipMap(db, readRows);
  assert.ok(map.size > 400, `expected hundreds of codes, got ${map.size}`);

  const cov = kinship.kinshipCoverage(map);
  assert.strictEqual(cov.total, map.size);

  // Only the two sentinel rows may be unresolved; anything else means we
  // silently stopped understanding part of CBDB.
  const unresolved = [...map.values()].filter((v) => !v.resolved);
  assert.strictEqual(unresolved.length, 2,
    'only CBDB sentinel rows should be unresolved, got: ' +
    unresolved.map((v) => `${v.code}:${v.kinrelChn}`).join(', ').slice(0, 300));
  for (const v of unresolved) {
    assert.ok([-1, -10000].includes(v.code), `unexpected unresolved code ${v.code}`);
  }
});

test('real CBDB codes 75/111 mean father/mother, not child', async (t) => {
  const db = await loadDb();
  if (!db) return t.skip('CBDB database not present');

  const map = kinship.buildKinshipMap(db, readRows);
  assert.strictEqual(map.get(75).key, 'father', 'CBDB code 75 is 父');
  assert.strictEqual(map.get(111).key, 'mother', 'CBDB code 111 is 母');
  assert.strictEqual(map.get(180).key, 'maleChild', 'CBDB code 180 is 子');
  assert.strictEqual(map.get(176).key, 'femaleChild', 'CBDB code 176 is 女兒');
});

test('no CBDB code inverts parent/child direction', async (t) => {
  const db = await loadDb();
  if (!db) return t.skip('CBDB database not present');

  const map = kinship.buildKinshipMap(db, readRows);
  const problems = kinship.assertNoDirectionInversion(map);
  assert.deepStrictEqual(problems, [], 'kinship mapping must not invert direction');
});

test('code 300 does not exist in CBDB', async (t) => {
  const db = await loadDb();
  if (!db) return t.skip('CBDB database not present');

  // The old hand table invented code 300 -> sibling.
  const rows = readRows(db, 'KINSHIP_CODES').filter((r) => r.c_kincode === 300);
  assert.strictEqual(rows.length, 0, 'CBDB defines no kinship code 300');
});

test('every derived predicate exists in the predicate registry', async (t) => {
  const db = await loadDb();
  if (!db) return t.skip('CBDB database not present');

  const { BUILTIN } = require('../../src/predicates/registry');
  const known = new Set(BUILTIN.map((p) => p.key));
  const map = kinship.buildKinshipMap(db, readRows);

  const missing = new Set();
  for (const v of map.values()) {
    // `key: null` 是模糊符号（A/U/G/K/P）：说不出具体关系，不出边。
    // 它们不该被当成「未注册谓词」——那会要求我们为「不知道」发明一个谓词。
    if (!v.key) continue;
    if (v.resolved && !known.has(v.key)) missing.add(v.key);
  }
  assert.deepStrictEqual([...missing], [],
    'derived kinship predicates must be registered, otherwise edges are orphaned');
});

// ---------------------------------------------------------------------------
// Guard against the mapping being hand-written again
// ---------------------------------------------------------------------------

test('no hand-written kinship code table remains in the importer or script', () => {
  const files = [
    path.join(__dirname, '..', '..', 'src', 'importers', 'cbdb.js'),
    path.join(__dirname, '..', '..', 'scripts', 'import_cbdb.js'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // A literal `75: 'father'`-style table is what drifted before. Allow prose
    // mentions in comments but reject an actual object keyed by CBDB codes.
    assert.ok(!/KIN_CODE_MAP\s*=\s*\{/.test(src), `${path.basename(f)} must not define KIN_CODE_MAP`);
    assert.ok(!/KIN_MAP\s*=\s*\{/.test(src), `${path.basename(f)} must not define KIN_MAP`);
    // Chinese-label guessing (父 -> father via string compare) is equally fragile.
    assert.ok(!/label === '父'/.test(src), `${path.basename(f)} must not guess predicates from Chinese labels`);
  }
});
