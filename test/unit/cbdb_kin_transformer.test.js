'use strict';
/**
 * `cbdb-kin` transform 的回归测试。
 *
 * 重点不是「映射对不对」（那是 `cbdb_kinship.test.js` 的事），而是
 * **transformer 层的三条边界**：
 *   1. 方向（`A --X--> B` = 「A 的 X 是 B」）
 *   2. 什么情况下**不建边**（复合路径、模糊符号、码表缺失、自指）
 *   3. 配偶谓词的细化（`spouse` → `husband`/`wife`）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const kin = require('../../src/transformers/cbdb-kin.js');
const { resolveKinCode, refineSpouse, KIN_REL } = kin._internal;

/** 造一条 raw record。 */
const row = (personid, kinId, code) => ({
  rawId: `raw:cbdb/KIN_DATA/${personid}|${kinId}|${code}`,
  payload: { c_personid: personid, c_kin_id: kinId, c_kin_code: code },
});

test('cbdb-kin: appliesTo names KIN_DATA', () => {
  assert.equal(kin.appliesTo.kind, 'record');
  assert.equal(kin.appliesTo.source, 'cbdb');
  assert.equal(kin.appliesTo.sourceTable, 'KIN_DATA');
  assert.match(kin.version, /^\d+\.\d+\.\d+$/);
});

test('cbdb-kin: the edge runs subject=personid, object=kin_id', () => {
  // 「A 的 X 是 B」: c_personid 是主语，c_kin_id 是那个亲属。
  // 手写表曾把父/母映射到 maleChild，方向整个反了。
  const { edges } = kin.transform(row(45940, 3, 134)); // H 丈夫
  assert.equal(edges.length, 1);
  assert.equal(edges[0].subject, 'person:cbdb-45940');
  assert.equal(edges[0].object, 'person:cbdb-3');
  assert.equal(edges[0].predicate, 'husband');
});

test('cbdb-kin: father points from child to father, not the reverse', () => {
  const { edges } = kin.transform(row(2, 1, 75)); // F 父
  assert.equal(edges[0].subject, 'person:cbdb-2');
  assert.equal(edges[0].predicate, 'father');
  assert.equal(edges[0].object, 'person:cbdb-1');
});

test('cbdb-kin: every single-step base letter maps to a registered predicate', () => {
  const { PredicateRegistry } = require('../../src/predicates/registry.js');
  const reg = new PredicateRegistry();
  // CBDB 的单字母符号中，只有这些能映射到真正的谓词。
  // `A`（姻親）与 `U`（未詳）、`G`/`K`/`P` 一样模糊，不出边（见 VAGUE）。
  const symbols = ['F', 'M', 'S', 'D', 'B', 'Z', 'H', 'W', 'C'];
  let checked = 0;
  for (const [code, kinrel] of Object.entries(KIN_REL)) {
    if (!symbols.includes(kinrel)) continue;
    checked++;
    const hit = resolveKinCode(Number(code));
    assert.ok(hit && hit.predicate, `code ${code} (${kinrel}) unresolved`);
    assert.ok(reg.get(hit.predicate), `${hit.predicate} not in registry`);
  }
  // 至少要有父/母/子/女/兄/姊/夫/妻 这几种，否则测试名不副实。
  assert.ok(checked >= 8, `只检查了 ${checked} 个单步码`);
});

test('cbdb-kin: a composite path produces no edge', () => {
  // §8.6: `FF`(祖父) = A --F--> X --F--> B。由两条单步边组合得出，
  // 另存一条 grandfather 边会让同一事实有两个来源，改一处就矛盾。
  const ff = Object.keys(KIN_REL).find((c) => KIN_REL[c] === 'FF');
  const res = kin.transform(row(1, 2, Number(ff)));
  assert.equal(res.edges.length, 0);
  assert.deepEqual(res.derivedChart, ['F', 'F']);
});

test('cbdb-kin: a vague symbol produces no edge', () => {
  // G 直系祖先 = 往上几代、几代未知。建边相当于把「不知道」记成一条事实，
  // 而 `A --kin--> B` 读作「A 的亲属是 B」，听起来像我们知道了什么。
  //
  // 实测 `G` / `K` / `P` 在 `KINSHIP_CODES` 里**没有单字母行**（只有 `GG`
  // 这类带数字的），所以真正以单字母出现的模糊符号只有 `U`（code 0，未詳）。
  // 模糊判定仍按 `VAGUE` 全集写，因为 CBDB 换版本时可能出现单字母 G。
  const u = Object.keys(KIN_REL).find((c) => KIN_REL[c] === 'U');
  const res = kin.transform(row(1, 2, Number(u)));
  assert.equal(res.edges.length, 0);
  assert.equal(res.vagueStep, 'U');
});

test('cbdb-kin: 姻親 A 不建边（说不出具体关系）', () => {
  // 「姻親」并没说出是岳父、女婿还是连衿——它和 G（说不出）一样模糊。
  //
  // 旧行为把它落成 `kin`，而 `kin` 谓词已删除（与 era/tags 同类的杂物箱）。
  // 按 §8.1「有称呼就用称呼」，说不出的就不记。
  const a = Object.keys(KIN_REL).find((c) => KIN_REL[c] === 'A');
  const res = kin.transform(row(1, 2, Number(a)));
  assert.equal(res.edges.length, 0, '姻親不应建边');
  assert.equal(res.vagueStep, 'A', '应归入 vagueStep 而不是静默丢弃');
});

test('cbdb-kin: an unknown code is skipped, not guessed as kin', () => {
  // 猜一个 `kin` 会让「码表里没这一项」这种真问题消失得无声无息。
  const res = kin.transform(row(1, 2, 99999));
  assert.equal(res.edges.length, 0);
  assert.match(res.skipped, /unknown c_kin_code 99999/);
});

test('cbdb-kin: a self-reference is a data error, not a kinship', () => {
  const res = kin.transform(row(7, 7, 75));
  assert.equal(res.edges.length, 0);
  assert.equal(res.skipped, 'self-reference');
});

test('cbdb-kin: spouse is refined by which letter produced it', () => {
  // P5-5b 把亲缘谓词拆成性别原语：H→husband、W→wife，spouse 退为性别未知。
  assert.equal(refineSpouse('H', 'spouse'), 'husband');
  assert.equal(refineSpouse('W', 'spouse'), 'wife');
  // C 妾 也是配偶且是女性，但「妾」是主体的角色而非另一种关系（§8.4）。
  assert.equal(refineSpouse('C', 'spouse'), 'husband');
  // 不是 spouse 的一律不动。
  assert.equal(refineSpouse('F', 'father'), 'father');
});

test('cbdb-kin: the edge carries its rawRef', () => {
  // 一条边只是两人之间的一个断言，没有出处无从核验。
  const { edges } = kin.transform(row(2, 1, 75));
  assert.equal(edges[0].rawRef, 'raw:cbdb/KIN_DATA/2|1|75');
});

test('cbdb-kin: malformed payloads yield nothing rather than throwing', () => {
  for (const bad of [null, {}, { payload: {} }, { payload: { c_personid: 'x', c_kin_id: 1 } }]) {
    const res = kin.transform(bad);
    assert.equal(res.edges.length, 0);
  }
});

test('cbdb-kin: resolveKinCode is memoised but returns the same shape', () => {
  // 559,940 行只用到 438 个 code；不缓存会让全量重算多花几分钟。
  const a = resolveKinCode(75);
  const b = resolveKinCode(75);
  assert.deepEqual(a, b);
});
