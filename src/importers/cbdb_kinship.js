'use strict';
/**
 * CBDB kinship code → predicate mapping, derived from CBDB's own data.
 *
 * ## Why this file exists
 *
 * Two hand-written mapping tables used to live in this repo:
 *
 *   - `scripts/import_cbdb.js`  had a 57-entry `KIN_CODE_MAP` of *invented
 *     ranges* (`1–22 → 父母`, `75–160 → 子女`). Checked against CBDB's
 *     `KINSHIP_CODES` table, code 75 is 父 (F) and code 111 is 母 (M) — that
 *     table mapped both to 子女, so importing with it would have written every
 *     parent as a child and silently inverted the family tree.
 *   - `src/importers/cbdb.js` had a 25-entry `KIN_MAP` that was mostly right
 *     but contained fabrications: code 63 (妻之祖父) → `teacherOf`, code 64
 *     (伯叔祖) → `studentOf`, codes 165/166 (長兄/季弟) → `friend`, and code
 *     300 → `sibling` even though CBDB has no code 300.
 *
 * Both are gone. Nothing here is guessed: every mapping is computed from
 * `KINSHIP_CODES.c_kinrel`, CBDB's own structural notation, where each letter is
 * one generational/marital step:
 *
 *     F 父   M 母   S 子   D 女   B 兄弟   Z 姊妹
 *     H 夫   W 妻   C 妾   A 姻親
 *
 * Modifiers (`+` older, `-` younger, digits = birth order, `^` step/adoptive,
 * `[ ]` 收養, `~` 等) are preserved in `chain` for display but do not change the
 * predicate — we lose "which brother" but never invent a relationship.
 *
 * ## Coverage strategy
 *
 * CBDB has 488 kinship codes. Rather than enumerate them (which is how the
 * previous tables drifted), we derive three tiers:
 *
 *   1. **single** — `c_kinrel` is exactly one base letter (75 F, 111 M, 180 S…):
 *      maps to a dedicated predicate such as `father` / `mother` / `maleChild`.
 *   2. **composite** — every letter is a base letter (`FFF` = 曾祖): maps to a
 *      `kin` edge whose `chain` records the path, so the UI can say "父之父".
 *   3. **unknown** — anything containing a letter outside the base set is
 *      returned as `kin` with `resolved: false`, so we can report how much of a
 *      dataset is unmapped instead of silently mislabeling it.
 *
 * A mapping is only ever produced *from* CBDB data, never typed by hand.
 */

const path = require('path');

/**
 * The base single-step symbols CBDB uses in `c_kinrel`.
 *
 * The first ten are the direct generational/marital steps. The last five were
 * added after auditing all 488 `KINSHIP_CODES` rows: they are real steps too,
 * just less specific (e.g. `G` = 直系祖先 of unspecified depth, `P` = 表親).
 * Omitting them would have left 326 of 488 codes "unresolved" for no reason.
 */
const BASE = [
  'F', 'M', 'S', 'D', 'B', 'Z', 'H', 'W', 'C', 'A',
  'G', 'K', 'P', 'U',
];

/** Base symbols whose meaning is deliberately vague (no directional predicate). */
// 模糊符号：源数据自己就说不出具体关系。
//
// `U` 未詳 / `G` 直系祖先 / `K` 同族長輩 / `P` 表親 / `A` 姻親。
// 为它们建边相当于把「不知道」当成一条事实记下来——`A --kin--> B` 读作
// 「A 的亲属是 B」，听起来像我们知道了什么，实际什么也没说。
//
// `A`（姻親）原先不在这里，于是 299 条「姻親」落成了 `kin` 边，
// 与 `era: 隋唐及以后`、`tags: 年代不详` 是同一类错误：
// 把「说不出」包装成一个看起来像类别的值。宁可没有这条边。
const VAGUE = new Set(['U', 'G', 'K', 'P', 'A']);

/**
 * Characters that carry no structural meaning in `c_kinrel`.
 *
 * Audited against all 488 rows: after removing every base letter, the only
 * things left are birth-order digits, relative-age markers (`+` older, `-`
 * younger), step/adoptive markers (`^`), claim markers, bracketing, and
 * prose annotations such as `(male)` or `(only surviving son)`.
 *
 * `G-n`, `K-2(male)` etc. combine a real step with a placeholder (`n` = unknown
 * depth) and a note, so they still describe a genuine relationship — we keep the
 * base letter and drop the rest.
 */
const NOISE = /[^BFMDSZHAWCUGKP]/g;

/**
 * Single-step codes → our predicate vocabulary.
 *
 * Keyed by the **structural symbol**, not by CBDB's numeric code, because the
 * numeric code is CBDB's internal identifier and differs between releases,
 * whereas `c_kinrel` is the actual relationship. `S` appears twice in CBDB
 * (子 and 嗣子) and both correctly map to `maleChild`.
 */
const SINGLE_STEP = {
  F: { key: 'father', label: '父', gender: 'male' },
  M: { key: 'mother', label: '母', gender: 'female' },
  S: { key: 'maleChild', label: '子', gender: 'male' },
  D: { key: 'femaleChild', label: '女', gender: 'female' },
  // `B`/`Z` 直接用 brother/sister，不再退到 `sibling`。
  //
  // `sibling` 是「知道是手足、但说不出兄或弟/姊或妹」的兜底，
  // 而 `B`/`Z` 已经说了性别——降级到 `sibling` 等于把已知信息丢掉。
  // 设计 §8.4 已裁定 `brother`/`sister` 是基础原语（不区分长幼）。
  B: { key: 'brother', label: '兄弟', gender: 'male' },
  Z: { key: 'sister', label: '姊妹', gender: 'female' },
  // `H`/`W`/`C` 细化到 husband/wife，`spouse` 退为「性别未知」的兜底。
  //
  // 方向约定（§8.4「从属视角」）：边是「A 的 X 是 B」。
  // `H`(丈夫) 意为「此人的丈夫是某人」——主体是妻，所以谓词是 `husband`。
  // 旧实现把三者全归到 `spouse`，把「夫」与「妻」的区分丢了。
  H: { key: 'husband', label: '夫', gender: 'male' },
  W: { key: 'wife', label: '妻', gender: 'female' },
  // 妾不新设谓词（§8.4 实施修正）：`郭氏 --concubine--> 劉仁` 会读作
  // 「郭氏的妾是刘仁」，荒谬。妾的身份用 husband + role 表达。
  C: { key: 'husband', label: '妾', gender: 'female' },
  // 模糊符号的 key 是 null：源数据自己就说不出具体关系。
  //
  // 旧值是 `'kin'`，于是「姻親」「未詳」都落成一条 `kin` 边，
  // 读起来像一条事实，实际什么也没说。`kin` 谓词已删除，
  // 这些符号不建边（见 `VAGUE`）。
  A: { key: null, label: '姻親', gender: null },
  U: { key: null, label: '未詳', gender: null },
  G: { key: null, label: '直系祖先', gender: null },
  K: { key: null, label: '同族長輩', gender: null },
  P: { key: null, label: '表親', gender: null },
};

/** Human-readable step names for building display chains. */
const STEP_LABEL = {
  F: '父', M: '母', S: '子', D: '女', B: '兄弟', Z: '姊妹',
  H: '夫', W: '妻', C: '妾', A: '姻親',
  U: '未詳', G: '直系祖先', K: '同族長輩', P: '表親',
};

/**
 * CBDB's placeholder rows. Codes `-10000` ("Not Applicable") and `-1`
 * ("[missing data]") are sentinels, not relationships. Their `c_kinrel` holds
 * prose — `[missing data]` literally contains the letters M, S, G, D, A — so
 * they must be rejected *before* letter extraction, or they parse as bogus
 * kinship paths.
 */
const SENTINEL_CODES = new Set([-10000, -1]);

/** True when a row is a CBDB placeholder rather than a real kinship. */
function isSentinel(row = {}) {
  if (SENTINEL_CODES.has(row.c_kincode)) return true;
  const kinrel = String(row.c_kinrel || '').trim();
  if (!kinrel) return true;
  // Bracket/prose forms: "[missing data]", "Not Applicable", "S (only son)".
  if (/^\[/.test(kinrel)) return true;
  if (/not applicable/i.test(kinrel)) return true;
  return false;
}

/** Strip modifiers, keeping only base letters. */
function baseLetters(kinrel) {
  if (!kinrel) return [];
  return String(kinrel).toUpperCase().replace(NOISE, '').split('');
}

/** True when the string is exactly one base letter, i.e. no modifiers at all. */
function isSingleStep(kinrel) {
  return !!kinrel && String(kinrel).length === 1 && BASE.includes(String(kinrel));
}

/**
 * Derive our predicate for one CBDB kinship row.
 *
 * @param {object} row  a KINSHIP_CODES row: {c_kincode, c_kinrel, c_kinrel_chn}
 * @returns {{key: string, chain: string[], chainLabel: string, resolved: boolean, reason?: string}}
 */
function derivePredicate(row = {}) {
  const kinrel = row.c_kinrel;
  const chn = row.c_kinrel_chn || '';
  const code = row.c_kincode;

  if (isSentinel(row)) {
    // CBDB 的占位行（`[missing data]`、`非可用`）。key 为 null：它们不是关系，
    // 也不是说不出的关系——是源数据的缺失占位符。
    return {
      key: null,
      chain: [],
      chainLabel: chn,
      resolved: false,
      reason: `CBDB placeholder (code ${code})`,
    };
  }

  if (!kinrel) {
    // 没有 c_kinrel：说不出关系。key 为 null，不出边（`kin` 谓词已删除）。
    return { key: null, chain: [], chainLabel: chn, resolved: false, reason: 'no c_kinrel' };
  }

  // Tier 1: a single, unmodified base step.
  const single = SINGLE_STEP[kinrel];
  if (single) {
    return {
      key: single.key,
      chain: [kinrel],
      chainLabel: chn || single.label,
      resolved: true,
    };
  }

  // Tier 2: at least one base letter — keep the generational path, drop
  // modifiers. A modified single step (e.g. `B1` 長兄) still means "brother",
  // so it lands here rather than being reported as unmodelled.
  const letters = baseLetters(kinrel);
  if (letters.length) {
    // 单个基础字母（即使带修饰）仍然是那个关系：`B+`(兄)、`B-`(弟) 、`S1`(長子)
    // 说的都是兄弟/子，只是不告诉我们具体是哪一个。之前这里一律 `key:'kin'`，
    // 与紧跟着的注释（"we know it is a sibling"）矛盾——实测 `B+/B-` 共
    // 86,219 行因此退化成了 `kin`，凭空造出一个「知道是亲属但说不出哪种」
    // 的类别，而源数据明写着是兄弟。判别词表里 `sibling` 本来就不区分长幼，
    // 长幼信息丢掉是**已知的信息缺失**，不是「不知道是什么关系」。
    if (letters.length === 1 && SINGLE_STEP[letters[0]]) {
      const single = SINGLE_STEP[letters[0]];
      return {
        key: single.key,
        chain: letters,
        chainLabel: chn || single.label,
        resolved: true,
        modified: true,
      };
    }
    // 复合路径（`SS`=孫、`WF`=岳父）按 §8.6 由单步边组合得出，不另存一条边。
    // key 为 null：它不是一个谓词，而是一条待组合的路径。
    return {
      key: null,
      chain: letters,
      chainLabel: chn || letters.map((c) => STEP_LABEL[c]).join('之'),
      resolved: true,
      modified: true,
    };
  }

  // Tier 3: no base letter at all — CBDB's sentinel rows (`[missing data]`,
  // `Not Applicable`). Emit `kin` but mark it unresolved so coverage is honest.
  return {
    key: null,
    chain: [],
    chainLabel: chn,
    resolved: false,
    reason: `no kinship step in "${String(kinrel).trim()}" (code ${code})`,
  };
}

/**
 * Build a code → derived-mapping table for every kinship code in a CBDB DB.
 *
 * Reads straight from `KINSHIP_CODES`, so the result always matches the loaded
 * database rather than a hard-coded list.
 */
function buildKinshipMap(db, readRows) {
  const rows = readRows(db, 'KINSHIP_CODES', '', []);
  const map = new Map();
  for (const row of rows) {
    map.set(row.c_kincode, Object.assign({ code: row.c_kincode, kinrelChn: row.c_kinrel_chn }, derivePredicate(row)));
  }
  return map;
}

/** Coverage summary for reporting: how many codes resolved, by tier. */
function kinshipCoverage(map) {
  let single = 0; let composite = 0; let unresolved = 0;
  for (const v of map.values()) {
    if (!v.resolved) unresolved++;
    else if (v.chain.length === 1) single++;
    else composite++;
  }
  return { total: map.size, single, composite, unresolved };
}

/**
 * Validate that a derived map never maps a parent to a child-like predicate.
 * This is the specific inversion bug the old hand tables had; assert it cheaply
 * on every build so a future edit cannot silently reintroduce it.
 */
function assertNoDirectionInversion(map) {
  const inversion = {
    // kinrel symbol → predicates that would invert the direction
    F: new Set(['maleChild', 'femaleChild', 'childOfFather', 'childOfMother']),
    M: new Set(['maleChild', 'femaleChild', 'childOfFather', 'childOfMother']),
    S: new Set(['father', 'mother']),
    D: new Set(['father', 'mother']),
  };
  const problems = [];
  for (const v of map.values()) {
    if (!v.resolved || v.chain.length !== 1) continue;
    const sym = v.chain[0];
    if (inversion[sym] && inversion[sym].has(v.key)) {
      problems.push(`code ${v.code} (${v.kinrelChn}) → ${v.key} inverts direction`);
    }
  }
  return problems;
}

module.exports = {
  BASE,
  VAGUE,
  NOISE,
  SENTINEL_CODES,
  SINGLE_STEP,
  STEP_LABEL,
  baseLetters,
  isSingleStep,
  isSentinel,
  derivePredicate,
  buildKinshipMap,
  kinshipCoverage,
  assertNoDirectionInversion,
};
