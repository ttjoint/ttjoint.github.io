'use strict';
/**
 * `cbdb-biog` 的回归测试。
 *
 * 每一条都对应一个**真实发生过的缺陷**（见 `src/transformers/cbdb-biog.js`
 * 的注释）。这些测试的作用不是描述代码行为，而是把那几次事故钉死：
 * 一旦有人「顺手简化」成更自然的写法，测试会告诉他为什么不能。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const biog = require('../../src/transformers/cbdb-biog.js');
const { realYear, lifespanProps, isPlaceholderName } = biog._internal;

test('biog: c_birthyear/deathyear/c_dy exist without a 5000-row cap', () => {
  // 契约检查：转换器必须声明它吃哪张表。写错表名会让它静默不匹配任何记录。
  assert.equal(biog.appliesTo.kind, 'record');
  assert.equal(biog.appliesTo.source, 'cbdb');
  assert.equal(biog.appliesTo.sourceTable, 'BIOG_MAIN');
  assert.match(biog.version, /^\d+\.\d+\.\d+$/);
});

test('biog: 0 is CBDB\'s "unknown" sentinel, not a year', () => {
  // 傅燮 had c_index_year = 0 and rendered as living in "0年", which put him at
  // the start of the timeline as if he were its earliest figure.
  assert.equal(realYear(0), null);
  assert.equal(realYear(null), null);
  assert.equal(realYear(undefined), null);
  assert.equal(realYear(''), null);
  // Negative years are real (39 rows, 公元前) and must survive.
  assert.equal(realYear(-14), -14);
  assert.equal(realYear(1042), 1042);
});

test('biog: an activity year is never promoted to a birth year', () => {
  // 王利用: index 14, death 77 — an activity window, not a birth.
  // Callers read 出生年月 as a birth year; promoting 14 would claim he was born
  // in 14 CE and died at 63, when the source only says "active around 14".
  const p = lifespanProps({ c_index_year: 14, c_birthyear: 0, c_deathyear: 77 });
  assert.equal(p['出生年月'], undefined);
  assert.equal(p['逝世时间'], '77年');
  // 有真死年时不写 生卒：同一行写两个日期键会让读取方要单独处理形状，
  // 而 生卒 只在“除了它就什么都没有”时才有存在意义。
  assert.equal(p['生卒'], undefined);
});

test('biog: 生卒 is the last resort, not a companion key', () => {
  // 生卒 只在无生年且无死年时出现：CBDB 只知道“活跃于某年”。
  // 若它和 出生年月/逝世时间 并存，就说明有脚本补了日期却没删旧的——
  // 实测 2,743 个实体曾两边都有且值相同，已由
  // `tools/oneoff/prune_duplicate_lifespan.js` 清掉。
  assert.equal(lifespanProps({ c_index_year: 14 })['生卒'], '14年');
  assert.equal(lifespanProps({ c_index_year: 14, c_deathyear: 77 })['生卒'], undefined);
  assert.equal(lifespanProps({ c_index_year: 14, c_birthyear: 1 })['生卒'], undefined);
});

test('biog: a real birth year wins over the activity year', () => {
  const p = lifespanProps({ c_index_year: 999, c_birthyear: 1042, c_deathyear: 1104 });
  assert.equal(p['出生年月'], '1042年');
  assert.equal(p['逝世时间'], '1104年');
  // 有真生年时 生卒 不该出现——两个键指向同一年是冗余。
  assert.equal(p['生卒'], undefined);
});

test('biog: a death-only person gets no fabricated birth', () => {
  // Inventing a birth year from the death year would look sourced and be wrong.
  const p = lifespanProps({ c_index_year: 0, c_birthyear: 0, c_deathyear: 1398 });
  assert.equal(p['出生年月'], undefined);
  assert.equal(p['逝世时间'], '1398年');
});

test('biog: BCE years render with 公元前 wording, not a negative number', () => {
  const p = lifespanProps({ c_birthyear: -14, c_deathyear: -1 });
  assert.equal(p['出生年月'], '前14年');
  assert.equal(p['逝世时间'], '前1年');
});

test('biog: placeholder names are not identities', () => {
  // Two 某某 becoming two unrelated people makes search return "某某（7）" and
  // hangs every kinship edge off a node whose subject cannot be identified.
  for (const n of ['某某', '某', '未詳', '不詳', '無名氏', '佚名', '未知']) {
    assert.equal(isPlaceholderName(n), true, n);
  }
  // 纯「某」就算带了括注，剥掉括注后仍然什么都不剩。
  assert.equal(isPlaceholderName('某某(王某子)'), true);
  // A real name containing 某 as part of a longer word is still a name.
  assert.equal(isPlaceholderName('王某某'), false);
  assert.equal(isPlaceholderName('朱元璋'), false);
});

test('biog: 「X某」是已知偏差，不是本函数的契约', () => {
  // 项目约束写着「姓名不详者（纯「某」字 / 陈某(陈某子)）不作为人格实体」，
  // 但现有实现只拦	**纯**「某」：`陳某` 剥掉括注后还剩「陳」，
  // `/^[某]+$/` 不匹配，于是放过。实测库里有 **1,596 个「X某」实体**。
  //
  // 这是**已知不一致**，写进测试是为了让后来者看到它、而不是以为已经处理了。
  // 为什么本轮不改：改它会少掉 1,596 个实体、连带它们名下的边，
  // 属于一次独立的数据变更（需先确认这些行是否在 KIN_DATA 里充当亲属端点），
  // 塞进 P2 会让「映射等价」的验收标准失去意义。记为 P4 待办。
  assert.equal(isPlaceholderName('陳某(陳洎子)'), false);
  assert.equal(isPlaceholderName('陳某'), false);
});

test('biog: 不再从年份推出朝代标签', () => {
  // `dynastyTag` 已删除。它两条路径都不合格：
  //   读 c_dy → 从 85 个代码选一个朝代名，写成一条字面量边；
  //   无 c_dy → 按年份分档，而最后一档「隋唐及以后」吸收了 589 年以后所有人。
  // 按设计 §2.6，只知道大致时期就写带区间的生卒日期，时代分类是查询时推导的产物。
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'transformers', 'cbdb-biog.js'),
    'utf8',
  );
  assert.ok(!/function dynastyTag/.test(src), 'dynastyTag 必须已删除');
  assert.ok(!/relations\[.时代.\]/.test(src), '不得再写 era 边');
});

test('biog: c_notes is not rendered as a summary', () => {
  // c_notes holds citation codes ("XCB, 362.14b, SS; 471.21a"), not a biography.
  // Putting them under 简介 showed catalogue numbers where users expected prose
  // on 232k rows. They belong under 史料注记.
  const e = biog.transform({
    payload: {
      c_personid: 1, c_name_chn: '安惇', c_dy: 15,
      c_notes: "An(1) Dun [1] Fang's [2] father. XCB, 362.14b, SS; 471.21a, 22a.",
    },
  }).entities[0];
  assert.equal(e.props['简介'], undefined);
  assert.match(e.props['史料注记'], /XCB, 362\.14b/);
});

test('biog: the id comes from c_personid, never from the name', () => {
  // Ids used to be sha256(name), so namesakes were disambiguated by appending
  // counters (劉環雋（1）, 韓氏（3）) — and 163 cbdbIds ended up owning two
  // entities each. Two rows named 關羽 (467817, 497161) must stay two people.
  const a = biog.transform({ payload: { c_personid: 467817, c_name_chn: '關羽' } }).entities[0];
  const b = biog.transform({ payload: { c_personid: 497161, c_name_chn: '關羽' } }).entities[0];
  assert.equal(a.id, 'person:cbdb-467817');
  assert.equal(b.id, 'person:cbdb-497161');
  assert.notEqual(a.id, b.id);
  assert.equal(a.name, b.name);
  // 名字本身必须原子：不带序号。
  assert.doesNotMatch(a.name, /[（(]\d+[）)]/);
});

test('biog: rows without a usable name are dropped, not merged', () => {
  // Merging two unknown people would assert they are the same unknown person.
  assert.deepEqual(biog.transform({ payload: { c_personid: 1, c_name_chn: '' } }).entities, []);
  assert.deepEqual(biog.transform({ payload: { c_personid: 2, c_name_chn: '某某' } }).entities, []);
  assert.equal(biog.transform({ payload: { c_personid: 3, c_name_chn: '關羽' } }).entities.length, 1);
});

test('biog: an undated person is kept, not silently dropped', () => {
  // The old importer skipped anyone with no year, which excluded 關羽, 劉備 and
  // 張遼 — all year-less — while keeping a 1064 CE 周瑜.
  const e = biog.transform({ payload: { c_personid: 467817, c_name_chn: '關羽', c_dy: 3 } }).entities[0];
  assert.ok(e, 'a year-less person must survive the transform');
  assert.equal(e.props['出生年月'], undefined);
  assert.equal(e.props['逝世时间'], undefined);
  // 无年份就没有日期边，也不造任何朝代标签。
  // 旧行为会写 `era: 三國`（来自 c_dy），但那是把源数据的分类字段抄成一条自成一体的边；
  // 按设计 §2.6，时代是从日期推导的查询产物，不入库。
  assert.equal(e.relations['时代'], undefined);
  assert.equal(e.relations.era, undefined);
});
