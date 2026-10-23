'use strict';
/**
 * CBDB `BIOG_MAIN` → 人物实体。
 *
 * ## 这个文件与 `scripts/import_cbdb.js` 的关系
 *
 * `import_cbdb.js` 把三件事混在一起：**读 SQLite → 映射 → 写分片**。
 * 于是「重导 486k 人」= 读一个 557 MB 的库 + 跑 sql.js + 写 48 万文件，
 * 十几分钟起步，且没法单独测映射规则。
 *
 * 拆开后：
 *
 *     tools/raw/ingest_cbdb.js        SQLite → raw/cbdb/BIOG_MAIN/*.gz   （只搬运）
 *     src/transformers/cbdb-biog.js   raw → 实体                          （只映射）
 *
 * 搬运不解释，映射不读库。raw 层已落盘 2,472,329 行，重跑映射不再碰 SQLite。
 *
 * ## 为什么文字说明这么密
 *
 * 下面每一条规则都对应一个**实际发生过的缺陷**，注释记录的是「为什么不是
 * 更自然的写法」。删掉注释，下一个人就会把 `c_deathyear` 写成 `c_death_year`、
 * 把 0 当成纪元年、把无年份的人过滤掉——这三件事都真发生过。
 */

const { cbdbPersonId } = require('../store/entity_id');

const NAME = 'cbdb-biog';
const VERSION = '1.0.0';

/**
 * CBDB's "we don't know" sentinel.
 *
 * `BIOG_MAIN` stores unknown years as `0`, not `NULL` — 290 rows have
 * `c_index_year = 0` (傅燮 among them). Treating 0 as a real year rendered 傅燮 as
 * living in "0年", which is not a year anyone lived in, and put him at the start of
 * the timeline as if he were its earliest figure. Negative years are real (39 rows,
 * 公元前) and must survive.
 */
function realYear(year) {
  if (year == null || year === '') return null;
  const n = Number(year);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function formatYear(year) {
  if (year == null || year === '') return '不详';
  const n = Number(year);
  if (Number.isNaN(n)) return '不详';
  return n < 0 ? `前${Math.abs(n)}年` : `${n}年`;
}

/**
 * The structured lifespan props the rest of the system actually reads.
 *
 * This was the most consequential defect in the old importer. It wrote only a
 * prose string:
 *
 *     props['生卒'] = '前14年 ~ 不详'
 *
 * but `graph_source.lifespanFromProps()` reads `出生年月` / `逝世时间` and nothing
 * else, so **all 7,120 persons had `lifespan === null`**. The three-tier timeline
 * filter, the dated index bucket and every date query operated on an empty set.
 * Nothing threw; searches simply matched nothing.
 *
 * It also ignored `c_birthyear` entirely and used `c_index_year` (an *activity*
 * year, not a birth year) as if it were one. CBDB has 59,851 rows with a real birth
 * year and 71,283 with a real death year that never reached the corpus.
 *
 * `c_deathyear`, not `c_death_year`. The hyphenated name returned `undefined` for
 * every row, so the death-year half was dead code.
 *
 * Birth and death are emitted separately because a person known only by their death
 * year must get a death-only range rather than a fabricated birth.
 */
function lifespanProps(p) {
  const indexYear = realYear(p.c_index_year);
  const birthYear = realYear(p.c_birthyear);
  const deathYear = realYear(p.c_deathyear);
  const props = {};
  // `c_birthyear` is a birth year; `c_index_year` is only the year CBDB files the
  // person under, which is usually but not always the same thing (王利用: index 14,
  // death 77 — an activity window, not a birth). So a real birth year becomes
  // 出生年月, while an activity year stays 生卒 and is never promoted.
  //
  // 生卒 is therefore an *intentional* degraded form, not leftover dirt. The
  // provenance backfill maps it back to `c_index_year`/`c_index_year_type_code`.
  if (birthYear != null) props['出生年月'] = formatYear(birthYear);
  if (deathYear != null) props['逝世时间'] = formatYear(deathYear);
  if (!Object.keys(props).length && indexYear != null) props['生卒'] = formatYear(indexYear);
  return props;
}

/**
 * A name that is entirely "unknown" is not an identity.
 *
 * CBDB records 253 rows literally named 某某 ("someone") and ~2,600 more like
 * 陳某(陳洎子) — "a Chen, son of Chen Ji". These are honest records of an unnamed
 * person, but as graph nodes they are worthless: two different 某某 become two
 * unrelated people, search returns "某某（7）", and every kinship edge hangs off a
 * node whose subject cannot be identified.
 *
 * They are **dropped rather than merged**: merging would assert that two unknown
 * people are the same unknown person.
 */
function isPlaceholderName(name) {
  // Strip a parenthetical qualifier, then ask whether anything but 某 is left.
  const core = String(name).replace(/[（(][^）)]*[）)]/g, '').trim();
  if (!core) return true;
  if (/^[某]+$/.test(core)) return true;
  // CBDB also carries bare "unknown" words as if they were names: 未詳 (c_personid 0)
  // and 無名氏 (117962). As graph nodes they are empty shells that make a search for
  // "unknown" look like it found a person.
  return /^(未詳|不詳|無名氏|佚名|未知)$/.test(core);
}

/**
 * 一行 `BIOG_MAIN` → 一个实体。
 *
 * Returns `null` for rows that are not identities (no usable name, or a placeholder
 * name). Returning null instead of throwing is deliberate: 660k rows, and a handful
 * of odd ones should not abort the run — but the caller counts them.
 */
function one(payload) {
  const rawName = String(payload.c_name_chn || '').trim();
  if (!rawName) return null;
  if (isPlaceholderName(rawName)) return null;

  // 名字必须是原子的。CBDB 有 434 行把关系塞进名字里：`雷氏(孛术魯遠妻)`、
  // `暴氏(暴益女)`。那是「某人的妻/女」，是一条边，不是身份。
  const parenMatch = rawName.match(/^(.+?)\s*[（(]([^（()）]*)[）)]\s*$/);
  const name = parenMatch ? parenMatch[1].trim() : rawName;
  const nameQualifier = parenMatch ? parenMatch[2].trim() : '';
  if (!name || isPlaceholderName(name)) return null;

  const pid = payload.c_personid;
  const alterName = String(payload.c_name_chn_alt || '').trim();
  const notes = String(payload.c_notes || '').trim();

  // The name is a plain field: repeatable, mutable, and shared by namesakes.
  // The id comes from CBDB's own primary key, never from the name.
  //
  // The old id was sha256(name), which could not distinguish two people who share
  // a name, so the importer appended counters (`劉環雋（1）`, `韓氏（3）`) — and when
  // it later tried to fill an existing hollow shard, the counted name did not match
  // the bare name on disk, so it forked a duplicate instead. 163 cbdbIds ended up
  // owning two entities each.
  //
  // `c_personid` is stable, unique, and the source's own key. Two rows named 關羽
  // (467817, 497161) get two ids and stay two people, which is correct: they are.
  const entity = {
    id: cbdbPersonId(pid),
    name,
    type: 'person',
    props: lifespanProps(payload),
    // Which CBDB row this came from. Without it the entity is traceable only by
    // name, and names repeat: the corpus has four different 王雅 rows.
    external: { cbdbId: pid },
    aliases: [],
    relations: {},
    wikiUrl: '',
  };

  // `简介` 不写。
  //
  // 旧导入器的 `buildDescription()` 返回「名字，字某」，但实测 30,000 份现有
  // 分片里 **0 个** 有 `简介`——它不是被删的，是从没落过盘（现有数据不是当前
  // 版本导入器产的）。而它的内容完全冗余：名字已是 `name`，字已是 `props['字']`。
  // 写一个拼出来的重复字段只会让 P2-4 的对照永远对不平。

  // 字
  if (alterName) {
    entity.props['字'] = alterName;
    entity.aliases.push(`${name}${alterName}`);
  }

  // 原名字里的括注（如「孛朮魯遠妻」）是关系描述，不是名字。
  if (nameQualifier) {
    entity.props['名字括注'] = nameQualifier;
  }

  // CBDB 学术注记：史料出处与考证，**不是传记简介**。
  //
  // `c_notes` holds CBDB's scholarly apparatus — citation codes, source
  // abbreviations, cross-references, in English:
  //   "An(1) Dun [1] Fang's [2] father. XCB, 362.14b, SS; 471.21a, 22a."
  // Rendering that under 简介 showed catalogue numbers where users expected a
  // description, on 232k rows. It is kept under its own key so no view presents it
  // as a summary.
  if (notes) entity.props['史料注记'] = notes;


  return entity;
}

module.exports = {
  name: NAME,
  version: VERSION,
  appliesTo: { kind: 'record', source: 'cbdb', sourceTable: 'BIOG_MAIN', locked: true },
  /** 一行 → { entities, edges }。本转换器只产实体，边的来源是 KIN_DATA。 */
  transform(rawRecord) {
    const e = one(rawRecord.payload || rawRecord);
    return { entities: e ? [e] : [], edges: [] };
  },
  // 导出内部函数供测试与复用——`lifespanProps` 的规则是 P2-4 对照的重点。
  _internal: { realYear, formatYear, lifespanProps, isPlaceholderName },
};
