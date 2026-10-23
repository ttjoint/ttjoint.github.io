/**
 * CBDB (China Biographical Database) 数据导入脚本
 * 将 CBDB SQLite 数据库转换为 HumanMap 格式并合并到现有数据中
 * 
 * 用法:
 *   1. npm install         (安装 sql.js 依赖)
 *   2. node scripts/import_cbdb.js
 * 
 * 数据来源: https://huggingface.co/datasets/cbdb/cbdb-sqlite
 */

const fs = require('fs');
const path = require('path');

// Entity ids must be canonical (`person:<hash>`). This importer used to emit the
// bare name as the id (`王雅`), which `upsertAll` does not normalise, so re-running
// it wrote `data/persons/entities/%E7%8E%8B%E9%9B%85.json` alongside the existing
// `person:0000f94d…​.json` — the same person as two nodes, silently. Because the
// existing shards already hold canonical ids, a re-import could never merge and
// would only have duplicated the corpus.
const { cbdbPersonId, cbdbOrgId, cbdbEventId } = require('../src/store/entity_id');
const { readAll } = require('../src/store/entity_writer');

// ====================== 配置 ======================
const DATA_DIR = path.join(__dirname, '..', 'data');
const CBDB_DIR = path.join(__dirname, '..', 'cbdb_20260801');
const DB_PATH = path.join(CBDB_DIR, 'cbdb_20260801.sqlite3');

// Dry run: report what would change without touching the shards. Rebuilding the
// CBDB half of the corpus is destructive enough to deserve a preview.
const DRY_RUN = process.argv.includes('--dry-run');


// The year window used to be here as a hard filter (`YEAR_MIN`/`YEAR_MAX`,
// −1000..600) that also dropped every person CBDB has no year for. That combination
// is why 關羽, 劉備 and 張遼 were missing while a 1064 CE 周瑜 was present. Both are
// gone: no window by default, and `--years=MIN:MAX` is opt-in.

// ====================== CBDB 亲属关系代码映射 ======================
// 这里曾有一张 57 条的 KIN_CODE_MAP，是按“区间猜”的（1-22 全算父母、
// 75-160 全算子女），与 CBDB 的 KINSHIP_CODES 不符：代码 75 是「父」、
// 111 是「母」，而那张表把两者都写成「子女」——按它导入会把每个父亲
// 写成儿子，静默颠倒整棵家谱。
//
// 现在映射一律在导入时从 KINSHIP_CODES 的 c_kinrel 结构符号推导，
// 见 src/importers/cbdb_kinship.js。下面不再有手写代码表。
// ====================== CBDB 社会关系代码映射 ======================
//
// Keys must be predicate keys from src/predicates/registry.js, not Chinese
// labels. This table used to emit '同僚' / '朋友' / '其他', which meant the graph
// held relation keys the registry had never heard of: RelationRegistry could not
// label them, the reverse-direction lookup could not invert them, and '其他'
// ("other") collected 109 edges that asserted nothing.
//
// CBDB's remaining categories — 门客 / 政敌 / 学术 / 文学 / 同乡 / 荐举 / 其他 —
// have no registered primitive. Rather than widen the registry to cover four
// edges each, they are dropped: an unlabelled edge is better than a mislabelled
// one, and `check_references` will show the gap if it ever matters.
const ASSOC_CODE_MAP = {
  1: 'teacherOf', 2: 'teacherOf', 3: 'teacherOf',
  10: 'colleague', 11: 'colleague', 12: 'colleague',
  20: 'friend', 21: 'friend',
  50: 'teacherOf', 51: 'teacherOf', // 学术往来 recorded as an intellectual tie
  80: 'recommendedBy', 81: 'recommendedBy',
};

// ====================== 工具函数 ======================

/**
 * 获取表的列信息
 */
function getTableColumns(db, tableName) {
  try {
    const stmt = db.prepare(`PRAGMA table_info("${tableName}")`);
    const columns = [];
    while (stmt.step()) {
      columns.push({
        cid: stmt.getAsObject().cid,
        name: stmt.getAsObject().name,
        type: stmt.getAsObject().type
      });
    }
    stmt.free();
    return columns;
  } catch (e) {
    return [];
  }
}

/**
 * 安全获取表中的所有行
 */
function getTableRows(db, tableName, limit = null) {
  try {
    const sql = limit ? `SELECT * FROM "${tableName}" LIMIT ${limit}` : `SELECT * FROM "${tableName}"`;
    const stmt = db.prepare(sql);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (e) {
    console.error(`  读取表 ${tableName} 失败: ${e.message}`);
    return [];
  }
}

/**
 * 构建 CBDB 人物名到 HumanMap id 的映射
 */
function buildNameMap(persons) {
  const map = new Map();
  for (const p of persons) {
    map.set(p.name, p.id);
    if (p.aliases) {
      for (const alias of p.aliases) {
        if (!map.has(alias)) {
          map.set(alias, p.id);
        }
      }
    }
  }
  return map;
}

/**
 * 格式化年份，公元前用「前」而不是负号。
 *
 * `${year}年` rendered 公元前 221 年 as "-221年", which reads as a typo in
 * Chinese and sorts wrong next to 公元前 strings elsewhere in the corpus.
 */
function formatYear(year) {
  if (year == null || year === '') return '不详';
  const n = Number(year);
  if (Number.isNaN(n)) return '不详';
  return n < 0 ? `前${Math.abs(n)}年` : `${n}年`;
}

/**
 * 把年份 + CBDB 的 range code 组成带精度的日期文本。
 *
 * CBDB 在 BIOG_MAIN 里用 c_by_range / c_dy_range 标注年份的不确定性，
 * 对应 YEAR_RANGE_CODES：
 *   -1 before（之前） 0 during（恰好） 1 after（之后） 2 around（约）
 *
 * 旧实现完全不读这两列，而是把年份分档写成一条 era 边（隋唐及以后吸收了 589 年后所有人）。
 * 按设计 §2.6，模糊时期应写成带区间的日期，这里把 CBDB 自己标注的不确定性还回去。
 *
 * 输出格式必须能被 src/time 的 parseFuzzy 读懂（它认「约 1104 年 ± 30」），
 * 否则时间线与日期查询都会静默失配。
 */
const RANGE_RADIUS = { 2: 30 };

function formatYearWithRange(year, rangeCode) {
  const base = formatYear(year);
  if (base === '不详') return base;
  const code = rangeCode == null ? null : Number(rangeCode);
  // around（约）—— CBDB 的主要不确定性标记，给一个可检索的半径。
  if (code === 2) {
    const r = RANGE_RADIUS[2];
    return `约 ${base} ± ${r}`;
  }
  // before / after：只知道在此年之前或之后，保留为文字，不伪造另一端。
  if (code === -1) return `${base}之前`;
  if (code === 1) return `${base}之后`;
  // 300 / 301 是 CBDB 自己的两段分期（元貐五年前/后），属于源数据的表述，
  // 但没有对应的年份含义，不强行解释为某年。
  if (code === 300 || code === 301) return base;
  return base;
}

/**
 * CBDB's "we don't know" sentinel.
 *
 * BIOG_MAIN stores unknown years as 0, not NULL — 290 rows have `c_index_year = 0`
 * (傅燮 among them). Treating 0 as a real year rendered 傅燮 as living in "0年",
 * which is not a year anyone lived in, and put him at the start of the timeline as
 * if he were its earliest figure. Negative years are real (39 rows, 公元前) and
 * must survive.
 */
function realYear(year) {
  if (year == null || year === '') return null;
  const n = Number(year);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/**
 * Build the structured lifespan fields the rest of the system reads.
 *
 * This is the fix for the most consequential defect in the importer. It used to
 * write only a prose string:
 *
 *     props['生卒'] = '前14年 ~ 不详'
 *
 * but `graph_source.lifespanFromProps()` reads `出生年月` / `逝世时间` and nothing
 * else, so **all 7120 persons had no `lifespan` at all**. The three-tier timeline
 * filter, the dated index bucket and every date query were operating on an empty
 * set — they did not fail, they silently matched nothing.
 *
 * It also ignored `c_birthyear` entirely and used `c_index_year` (an activity
 * year, not a birth year) as if it were one. CBDB has 59,851 rows with a real
 * birth year and 71,283 with a real death year that never reached the corpus.
 *
 * Birth and death are emitted as separate props because that is what the
 * downstream reader understands, and because a person known only by their death
 * year must get a death-only range rather than a fabricated birth.
 */
function lifespanProps(person) {
  const indexYear = realYear(person.C_INDEX_YEAR || person.c_index_year);
  const birthYear = realYear(person.C_BIRTHYEAR || person.c_birthyear);
  const deathYear = realYear(person.C_DEATHYEAR || person.c_deathyear);
  const props = {};
  // `c_birthyear` is a birth year; `c_index_year` is only the year CBDB files the
  // person under, which is usually but not always the same thing (王利用: index 14,
  // death 77 — an activity window, not a birth). So a real birth year becomes
  // 出生年月, while an activity year stays 生卒 prose and is never promoted.
  const birthRange = person.C_BY_RANGE ?? person.c_by_range;
  const deathRange = person.C_DY_RANGE ?? person.c_dy_range;
  // 精度信息与年份同源（BIOG_MAIN 同一行），因此不会凭空增加不确定性。
  if (birthYear != null) props['出生年月'] = formatYearWithRange(birthYear, birthRange);
  if (deathYear != null) props['逝世时间'] = formatYearWithRange(deathYear, deathRange);
  if (!Object.keys(props).length && indexYear != null) props['生卒'] = formatYear(indexYear);
  return props;
}

/**
 * 构建简介
 *
 * `c_notes` is NOT a biography. It holds CBDB's scholarly apparatus — citation
 * codes, source abbreviations and cross-references, in English, e.g.
 *   "An(1) Dun [1] Fang's [2] father. XCB, 362.14b, SS; 471.21a, 22a."
 * Putting that under a field labelled 简介 showed users catalogue numbers where
 * they expected a description, on 232k rows. The notes are still worth keeping,
 * so they go to a dedicated prop the UI does not present as a summary.
 */
function buildDescription(person) {
  const parts = [];
  if (person.name) parts.push(person.name);
  if (person.c_name_chn_alt) parts.push(`字${person.c_name_chn_alt}`);
  return parts.join('，') || person.name;
}

// ====================== 主函数 ======================

async function main() {
  console.log('=== CBDB 数据导入工具 ===\n');

  // 检查数据库文件
  if (!fs.existsSync(DB_PATH)) {
    console.error(`错误: 找不到数据库文件 ${DB_PATH}`);
    process.exit(1);
  }

  // 加载 sql.js
  console.log('加载 sql.js...');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  
  // 读取数据库
  console.log(`读取数据库: ${DB_PATH}`);
  const fileBuffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(fileBuffer);

  // 探索数据库结构
  console.log('\n--- 数据库结构 ---');
  const tables = getTableRows(db, 'sqlite_master', null)
    .filter(r => r.type === 'table' && !r.name.startsWith('sqlite_'));
  
  console.log(`共 ${tables.length} 个表:`);
  for (const t of tables) {
    const cols = getTableColumns(db, t.name);
    const rowCount = db.exec(`SELECT COUNT(*) as cnt FROM "${t.name}"`)[0]?.values[0][0] || 0;
    console.log(`  ${t.name} (${rowCount} 行) - 列: ${cols.map(c => c.name).join(', ')}`);
  }

  // ==================== 1. 处理人物数据 (BIOG_MAIN) ====================
  console.log('\n--- 处理人物数据 ---');
  
  let biogMain = [];
  try {
    const stmt = db.prepare('SELECT * FROM BIOG_MAIN');
    while (stmt.step()) {
      biogMain.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 BIOG_MAIN 失败: ${e.message}`);
    // 尝试其他可能的表名
    const tableNames = tables.map(t => t.name.toLowerCase());
    const bioTable = tableNames.find(n => n.includes('biog') && n.includes('main'));
    if (bioTable) {
      const stmt = db.prepare(`SELECT * FROM "${bioTable}"`);
      while (stmt.step()) {
        biogMain.push(stmt.getAsObject());
      }
      stmt.free();
    }
  }
  console.log(`  BIOG_MAIN: ${biogMain.length} 条记录`);

  // 按年份筛选人物
  //
  // This used to drop anyone CBDB has no year for (`indexYear == null &&
  // deathYear == null → continue`). That reads like sensible hygiene and is
  // catastrophic: CBDB records 352,779 of its 660,311 people with no year at all,
  // and the ones it affects are mostly ancient. 關羽 has two rows (467817, 497161),
  // 劉備 one, 張遼 one — all year-less, so none of them ever reached the corpus,
  // while a 1064 CE 周瑜 and a 1419 CE 趙雲 did. Searching for a Three Kingdoms
  // figure returned nothing or a Ming-dynasty namesake.
  //
  // A missing date is a gap in the source, not evidence the person is irrelevant.
  // So the year window is now opt-in (`--years=MIN:MAX`) and undated rows are kept
  // by default. The downside is honest: 352k undated people cannot be placed on a
  // timeline, and the timeline filter will simply not match them.
  const yearsArg = process.argv.find((a) => a.startsWith('--years='));
  let yearMin = -Infinity;
  let yearMax = Infinity;
  if (yearsArg) {
    const [lo, hi] = yearsArg.split('=')[1].split(':');
    if (lo) yearMin = Number(lo);
    if (hi) yearMax = Number(hi);
  }

  const filteredPersons = [];
  for (const p of biogMain) {
    const indexYear = realYear(p.C_INDEX_YEAR || p.c_index_year);
    // The column is `c_deathyear`, not `c_death_year`. Reading the hyphenated name
    // returned undefined for every row, so the death-year half of this window was
    // dead code and 71,283 known death years were never considered.
    const deathYear = realYear(p.C_DEATHYEAR || p.c_deathyear);
    const birthYear = realYear(p.C_BIRTHYEAR || p.c_birthyear);

    if (yearsArg) {
      const dated = [indexYear, birthYear, deathYear].filter((y) => y != null);
      // Undated rows survive the window: see above.
      if (dated.length && !dated.some((y) => y >= yearMin && y <= yearMax)) continue;
    }
    filteredPersons.push(p);
  }
  if (yearsArg) {
    console.log(`  年份筛选（${yearMin}~${yearMax}，无年份者保留）: ${filteredPersons.length} 人`);
  } else {
    console.log(`  全量导入: ${filteredPersons.length} 人（含无年份者）`);
  }

  // 限制数量，避免数据过多
  //
  // `MAX_PERSONS` used to be a hard 5000 applied with `slice(0, 5000)` in raw
  // database order. Two problems, both silent:
  //   1. The query returns 6918 people inside the year window, so 1918 were
  //      dropped with only a console line to show for it.
  //   2. `slice` is order-dependent, so which 5000 survived depended on row
  //      order — a re-run could pick a different subset.
  // That is why re-importing could not repair the corpus: it only ever reached
  // 1209 of the 5205 hollowed shards, and never the same ones twice.
  // The cap is now opt-in (`--limit=N`) and unlimited by default.
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const MAX_PERSONS = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  const personsToImport = Number.isFinite(MAX_PERSONS)
    ? filteredPersons.slice(0, MAX_PERSONS)
    : filteredPersons;
  if (filteredPersons.length > personsToImport.length) {
    console.log(`  限制导入数量: ${personsToImport.length} / ${filteredPersons.length} 人`);
  }

  // 转换为 HumanMap 人物格式
  const cbdbPersons = [];
  const cbdbIdMap = new Map(); // c_personid -> HumanMap id (name)

  // A name that is entirely "unknown" is not an identity.
  //
  // CBDB records 253 rows literally named 某某 ("someone") and ~2600 more like
  // 陳某(陳洎子) — "a Chen, son of Chen Ji". These are honest records of an
  // unnamed person, but as graph nodes they are worthless: two different 某某
  // become two unrelated people, search returns "某某（7）", and every kinship
  // edge hangs off a node whose subject cannot be identified. They are dropped
  // rather than merged, because merging would assert that two unknown people are
  // the same unknown person.
  const isPlaceholderName = (name) => {
    // Strip a parenthetical qualifier, then ask whether anything but 某 is left.
    const core = name.replace(/[（(][^）)]*[）)]/g, '').trim();
    if (!core) return true;
    if (/^[某]+$/.test(core)) return true;
    // CBDB also carries bare "unknown" words as if they were names: 未詳 (one row,
    // c_personid 0) and 無名氏 (117962). They are not identities — as graph nodes they
    // are empty shells with no props and no edges, and they make a search for
    // "unknown" look like it found a person.
    return /^(未詳|不詳|無名氏|佚名|未知)$/.test(core);
  };
  let placeholderDropped = 0;
  const importable = personsToImport.filter((p) => {
    const name = (p.C_NAME_CHN || p.c_name_chn || '').trim();
    if (name && isPlaceholderName(name)) { placeholderDropped++; return false; }
    return true;
  });
  if (placeholderDropped) {
    console.log(`  跳过姓名不详的记录（某某/陈某类）: ${placeholderDropped} 条`);
  }
  
  // Ids come from CBDB's own primary key, never from the name.
  //
  // This replaces ~55 lines of collision-avoidance that existed only because the
  // old id was sha256(name). That scheme could not distinguish two people who
  // share a name, so the importer appended counters (`劉環雋（1）`, `韓氏（3）`) —
  // and when it later tried to fill an existing hollow shard, the counted name did
  // not match the bare name on disk, so it forked a duplicate instead. 163
  // cbdbIds ended up owning two entities each.
  //
  // `c_personid` is stable, unique, and the source's own key. Two rows named 關羽
  // (467817, 497161) get two ids and stay two people, which is correct: they are.
  for (const p of importable) {
    const rawName = (p.C_NAME_CHN || p.c_name_chn || '').trim();
    if (!rawName) continue;

    // 名字必须是原子的。CBDB 有 434 行把关系塞进名字：`雷氏(孛朮魯遠妻)`、
    // `暴氏(暴益女)`。那是「某人的妻/女」，是一条边，不是身份。
    // 直接当名字入库的后果：同一人被检索为「雷氏(孛朮魯遠妻)」，且括注
    // 会随知识库修订而变，名字也跟着变。
    const parenMatch = rawName.match(/^(.+?)\s*[（(]([^（()）]*)[）)]\s*$/);
    const name = parenMatch ? parenMatch[1].trim() : rawName;

    if (!name) continue;

    const pid = p.C_PERSONID || p.c_personid;
    const alterName = (p.C_NAME_CHN_ALT || p.c_name_chn_alt || '').trim();
    const notes = (p.C_NOTES || p.c_notes || '').trim();

    // The name is a plain field: repeatable, mutable, and shared by namesakes.
    const entityId = cbdbPersonId(pid);

    const person = {
      id: entityId,
      name,
      type: 'person',
      props: {
        ...lifespanProps(p),
        '简介': buildDescription(p),
      },
      // Provenance: which CBDB row this came from.
      //
      // Without it the entity was traceable only by name, and names repeat: the
      // CBDB corpus has four different 王雅 rows. Anyone re-deriving these records
      // has to be able to point at the exact source row, not just the name.
      external: { cbdbId: pid },
      aliases: [],
      relations: {},
      wikiUrl: '',
    };
    
    // 字
    if (alterName) {
      person.props['字'] = alterName;
      person.aliases.push(`${name}${alterName}`);
    }

    // 原名字里的括注（如「孛朮魯遠妻」）**不再存 props**。
    //
    // 关系是边，不是属性。存成 props 等于把三元组压平成一个字符串，
    // 「趙禎的妻子是谁」这种反向查询就永远查不到（§4.2.2）。
    // 括注里的关系由 KIN_DATA 建边；这里只保留名字本身（已剥离括注）。

    // CBDB 学术注记：史料出处与考证，不是传记简介。
    //
    // Kept, but under its own key so no view renders it as 简介. `buildDescription`
    // used to concatenate it into 简介, which put strings like
    // "XCB, 362.14b, SS; 471.21a" in a field the detail page shows as a summary.
    if (notes) {
      person.props['史料注记'] = notes;
    }
    
    // 朝代标记已删除。
    //
    // 旧代码把生卒年份分档写成 `era` 边（先秦/秦/两汉/三国/晋/南北朝/隋唐及以后），
    // 而最后一档吸收了 589 年以后的所有人——全部 era 边的 97.5% 都是「隋唐及以后」，
    // 等于「不知道」。这就是文档明令禁止的「年代不详」换了个朝代外表。
    //
    // 按 docs/architecture/节点类型与谓词.md §2.6：只知道「是战国人」就写成带区间的生卒日期，
    // 不造抽象节点。时代分类是查询时从日期推导的产物，不入库。
    // 生卒日期本身已在 lifespanProps() 里写入 props，这里不再叠加。

    cbdbPersons.push(person);
    // 亲属/社会关系需要把 CBDB 的 c_personid 映射到本库实体 id。
    // 这个 map 之前**从未被填充**：`cbdbIdMap.set` 在全文零处，
    // 于是 KIN_DATA 的 55.9 万行一条也匹配不上，
    // 循环跑完报告「建立亲属关系 0 条」而不报错。
    cbdbIdMap.set(pid, entityId);
  }
  console.log(`  转换人物: ${cbdbPersons.length} 人`);

  // ==================== 2. 处理亲属关系 (KIN_DATA) ====================
  console.log('\n--- 处理亲属关系 ---');

  const kinship = require('../src/importers/cbdb_kinship');
  const readRowsForKin = (db, table) => {
    const st = db.prepare('SELECT * FROM "' + table + '"');
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  };
  const kinMap = kinship.buildKinshipMap(db, readRowsForKin);
  console.log('  亲属代码覆盖: ' + JSON.stringify(kinship.kinshipCoverage(kinMap)));

  // 优先走 raw 层 transformer（`src/transformers/cbdb-kin.js`）。
  //
  // 它从设计起就存在，但从未被接线——`import_cbdb.js` 一直直接读 SQLite。
  // 两条路都调 `derivePredicate()`，映射一致，但 raw 层多两样东西：
  //   rawId      第 0 层定位，可直接当 provenance.rawRef 并在 raw/ 里核验
  //   contentHash 内容指纹
  // 而且 raw 层是**不可变的原始记录**，SQLite 会随 CBDB 换版本而变。
  //
  // raw 层缺失时（旧 checkout、raw/ 未生成）回退到 SQLite，不让导入失败。
  let kinData = [];
  let kinFromRaw = false;
  try {
    const { runTransformer } = require('../src/importers/raw_transformer_runner.js');
    const kinTransformer = require('../src/transformers/cbdb-kin.js');
    const { buildTextTitles, provenanceFromKinRow } = require('../src/importers/cbdb_provenance.js');
    const rawStore = require('../src/store/raw_store.js');

    const titles = buildTextTitles(readRowsForKin, db);
    const kinMeta = kinship.buildKinshipMap(db, readRowsForKin);

    const { edges, stats } = runTransformer(kinTransformer, {
      // 只保留两端都在本次导入集合里的边：raw 层有 55.9 万行，
      // 而 `cbdbIdMap` 只有本次转换出的人物。
      filter: (rec) => cbdbIdMap.has(rec.payload.c_personid) && cbdbIdMap.has(rec.payload.c_kin_id),
      enrich: (edge, rec) => {
        const meta = kinMeta.get(rec.payload.c_kin_code) || {};
        return {
          ...edge,
          provenance: provenanceFromKinRow(rec.payload, {
            titles,
            kinLabel: meta.chainLabel || '',
          }),
        };
      },
    });

    kinData = edges;
    kinFromRaw = true;
    console.log(`  raw 层 transformer: ${stats.records} 条记录 → ${edges.length} 条边`);
    console.log(`    跳过: 自指 ${stats.skippedSelf} / 模糊码 ${stats.skippedVague} / 复合码 ${stats.skippedDerived}`);
  } catch (e) {
    console.log(`  raw 层不可用（${e.message}），回退到 SQLite`);
    try {
      const stmt = db.prepare('SELECT * FROM KIN_DATA');
      while (stmt.step()) {
        kinData.push(stmt.getAsObject());
      }
      stmt.free();
    } catch (e2) {
      console.error(`  读取 KIN_DATA 失败: ${e2.message}`);
    }
    console.log(`  KIN_DATA: ${kinData.length} 条记录`);
  }


  let kinCount = 0;
  let kinUpgraded = 0;

  // 两种数据形状要统一处理：
  //   raw 层   { subject, predicate, object, provenance[] }  已规范
  //   SQLite   { c_personid, c_kin_id, c_kin_code, ... }     需推导
  // 前者是默认路径，后者只在本机没有 raw/ 时出现。
  const kinRows = kinFromRaw
    ? kinData.map((e) => ({
        sourceId: e.subject,
        targetId: e.object,
        relationType: e.predicate,
        prov: e.provenance,
      }))
    : kinData.map((k) => {
        const pid = k.C_PERSONID || k.c_personid;
        const kinId = k.C_KIN_ID || k.c_kin_id;
        const kinCode = k.C_KIN_CODE || k.c_kin_code;
        const meta = kinMap.get(kinCode);
        return {
          sourceId: cbdbIdMap.get(pid),
          targetId: cbdbIdMap.get(kinId),
          relationType: (meta && meta.key) || 'kin',
          prov: provenanceFromKinRow(k, {
            titles: kinTitles,
            kinLabel: (meta && meta.chainLabel) || '',
          }),
        };
      });

  // subject -> entity 的索引：逐条 `cbdbPersons.find()` 是 O(n)，
  // 55.9 万条边跑下来是 2.7e11 次比较，实测要几分钟。建一次 Map 即可。
  const personById = new Map(cbdbPersons.map((p) => [p.id, p]));

  for (const row of kinRows) {
    const { sourceId, targetId, relationType, prov } = row;
    if (!sourceId || !targetId) continue;

    const sourcePerson = personById.get(sourceId);
    if (!sourcePerson) continue;

    if (!sourcePerson.relations[relationType]) {
      sourcePerson.relations[relationType] = [];
    }

    // 关系条目带出处：`{id, provenance}` 而不是裸 id。
    // 出处挂在**这条断言的实例**上，不是挂在谓词定义上——
    // 「张三是李四的父亲」与「王五是赵六的父亲」是同一种谓词，两处出处。
    //
    // 已有的裸字符串条目要**升级**成带出处的对象，不能因为「边已经存在」就跳过：
    // 跳过会让全量重跑报告「建立亲属关系 0 条」，而实际上一条出处也没写进去。
    const existing = sourcePerson.relations[relationType];
    const idx = existing.findIndex((v) => (typeof v === 'string' ? v : v && v.id) === targetId);
    if (idx === -1) {
      existing.push({ id: targetId, provenance: prov });
      kinCount++;
    } else if (typeof existing[idx] === 'string') {
      existing[idx] = { id: targetId, provenance: prov };
      kinUpgraded++;
    }
  }
  console.log(`  建立亲属关系: ${kinCount} 条，旧条目升级为带出处: ${kinUpgraded} 条`);

  // ==================== 3. 处理社会关系 (ASSOC_DATA) ====================
  console.log('\n--- 处理社会关系 ---');
  
  let assocData = [];
  try {
    const stmt = db.prepare('SELECT * FROM ASSOC_DATA');
    while (stmt.step()) {
      assocData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 ASSOC_DATA 失败: ${e.message}`);
  }
  console.log(`  ASSOC_DATA: ${assocData.length} 条记录`);

  let assocCount = 0;
  let assocSkipped = 0;
  for (const a of assocData) {
    const pid = a.C_PERSONID || a.c_personid;
    const assocId = a.C_ASSOC_ID || a.c_assoc_id;
    const assocCode = a.C_ASSOC_CODE || a.c_assoc_code;
    
    const sourceId = cbdbIdMap.get(pid);
    const targetId = cbdbIdMap.get(assocId);
    if (!sourceId || !targetId) continue;
    
    const relationType = ASSOC_CODE_MAP[assocCode];
    // An unmapped CBDB category is skipped, not folded into a catch-all. The old
    // `|| '其他'` produced 109 edges all labelled "other", which is
    // indistinguishable from no edge at all while still inflating the graph.
    if (!relationType) { assocSkipped++; continue; }
    
    const sourcePerson = cbdbPersons.find(p => p.id === sourceId);
    if (!sourcePerson) continue;
    
    if (!sourcePerson.relations[relationType]) {
      sourcePerson.relations[relationType] = [];
    }
    
    if (!sourcePerson.relations[relationType].includes(targetId)) {
      sourcePerson.relations[relationType].push(targetId);
      assocCount++;
    }
  }
  console.log(`  建立社会关系: ${assocCount} 条`);
  if (assocSkipped) {
    console.log(`  跳过无对应谓词的社会关系: ${assocSkipped} 条（门客/政敌/文学/同乡等）`);
  }

  // ==================== 4. 处理官职/身份 (STATUS_DATA) ====================
  console.log('\n--- 处理官职/身份 ---');
  
  let statusData = [];
  try {
    const stmt = db.prepare('SELECT * FROM STATUS_DATA');
    while (stmt.step()) {
      statusData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 STATUS_DATA 失败: ${e.message}`);
  }
  console.log(`  STATUS_DATA: ${statusData.length} 条记录`);

  for (const s of statusData) {
    const pid = s.C_PERSONID || s.c_personid;
    const statusDesc = (s.C_STATUS_DESC || s.c_status_desc || '').trim();
    
    const humanId = cbdbIdMap.get(pid);
    if (!humanId || !statusDesc) continue;
    
    const person = cbdbPersons.find(p => p.id === humanId);
    if (!person) continue;
    
    if (!person.props['身份']) {
      person.props['身份'] = statusDesc;
    } else if (!person.props['身份'].includes(statusDesc)) {
      person.props['身份'] += '、' + statusDesc;
    }
  }

  // ==================== 5. 处理组织 (SOCIAL_INSTITUTION) ====================
  console.log('\n--- 处理组织 ---');
  
  let instData = [];
  try {
    const stmt = db.prepare('SELECT * FROM SOCIAL_INSTITUTION');
    while (stmt.step()) {
      instData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 SOCIAL_INSTITUTION 失败: ${e.message}`);
  }
  console.log(`  SOCIAL_INSTITUTION: ${instData.length} 条记录`);

  const cbdbOrgs = [];
  const instIdMap = new Map(); // c_inst_code -> HumanMap org id
  
  for (const inst of instData) {
    const instCode = inst.C_INST_CODE || inst.c_inst_code;
    const instName = (inst.C_INST_NAME_CHN || inst.c_inst_name_chn || inst.C_INST_NAME || inst.c_inst_name || '').trim();
    const instDesc = (inst.C_INST_DESC || inst.c_inst_desc || '').trim();
    
    if (!instName || instName.length > 30) continue;
    
    instIdMap.set(instCode, instName);
    
    const org = {
      id: cbdbOrgId(instCode),
      name: instName,
      type: 'organization',
      props: {
        '类型': '机构',
        '简介': instDesc || instName,
      },
      // CBDB row this came from (BIOG_INST_CODES.c_inst_code).
      external: { cbdbInstCode: instCode },
      aliases: [],
      relations: {},
    };
    cbdbOrgs.push(org);
  }
  console.log(`  转换组织: ${cbdbOrgs.length} 个`);

  // ==================== 6. 处理人物-组织关系 (BIOG_INST_DATA) ====================
  console.log('\n--- 处理人物-组织关系 ---');
  
  let biogInstData = [];
  try {
    const stmt = db.prepare('SELECT * FROM BIOG_INST_DATA');
    while (stmt.step()) {
      biogInstData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 BIOG_INST_DATA 失败: ${e.message}`);
  }
  console.log(`  BIOG_INST_DATA: ${biogInstData.length} 条记录`);

  let orgRelCount = 0;
  for (const bi of biogInstData) {
    const pid = bi.C_PERSONID || bi.c_personid;
    const instCode = bi.C_INST_CODE || bi.c_inst_code;
    
    const humanId = cbdbIdMap.get(pid);
    const orgName = instIdMap.get(instCode);
    if (!humanId || !orgName) continue;
    
    const person = cbdbPersons.find(p => p.id === humanId);
    if (!person) continue;
    
    if (!person.relations['所属组织']) {
      person.relations['所属组织'] = [];
    }
    
    const alreadyAdded = person.relations['所属组织'].some(
      r => (typeof r === 'string' ? r : r.target) === orgName
    );
    if (!alreadyAdded) {
      person.relations['所属组织'].push({ target: orgName, role: '' });
      orgRelCount++;
    }
  }
  console.log(`  建立组织关系: ${orgRelCount} 条`);

  // ==================== 7. 处理事件 (EVENTS_ADDR) ====================
  console.log('\n--- 处理事件 ---');
  
  let eventsData = [];
  try {
    const stmt = db.prepare('SELECT * FROM EVENTS_ADDR');
    while (stmt.step()) {
      eventsData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 EVENTS_ADDR 失败: ${e.message}`);
  }
  console.log(`  EVENTS_ADDR: ${eventsData.length} 条记录`);

  const cbdbEvents = [];
  for (const evt of eventsData) {
    const evtId = evt.C_EVENT_ID || evt.c_event_id;
    const evtDesc = (evt.C_EVENT_DESC || evt.c_event_desc || '').trim();
    const evtYear = evt.C_EVENT_YEAR || evt.c_event_year;
    
    if (!evtDesc || evtDesc.length > 100) continue;
    
    const event = {
      id: cbdbEventId(evtId),
      name: evtDesc,
      type: 'event',
      props: {
        '时间': formatYear(evtYear),
        '简介': evtDesc,
      },
      // CBDB row this came from (EVENTS_ADDR.c_event_id).
      external: { cbdbEventId: evtId },
      aliases: [],
      relations: {},
      wikiUrl: '',
    };
    cbdbEvents.push(event);
  }
  console.log(`  转换事件: ${cbdbEvents.length} 个`);

  // 关闭数据库
  db.close();

  // ==================== 8. 合并到现有数据 ====================
  console.log('\n--- 合并到现有数据 ---');

  // Read the authoritative shards, not the generated index.
  // `readAll` comes from the top-level require so the same snapshot is used for
  // the name lookup above and the merge below.
  const { upsertAll } = require('../src/store/entity_writer');
  const existingPersons = readAll('person');
  const existingOrgs = readAll('organization');
  const existingEvents = readAll('event');

  console.log(`  现有人物: ${existingPersons.length}`);
  console.log(`  现有组织: ${existingOrgs.length}`);
  console.log(`  现有事件: ${existingEvents.length}`);

  // Merge by name, keeping existing curated data and only adding new people.
  //
  // `upsertAll` matches on id first, then name, and `defaultMerge` lets the
  // existing record win on non-empty fields — so a shard whose `props` are an
  // empty object (the shape a summary round trip left behind) gets its real
  // props back on re-import. That is what makes this script the repair path for
  // the 5269 hollowed shards, not just an importer.
  if (DRY_RUN) {
    // Preview only: the merge is computed but nothing is written. Because the
    // write path is content-aware, the real run's `written` count is the honest
    // measure of how much this would change.
    const preview = (type, records) => {
      const { upsertAll: _u } = require('../src/store/entity_writer');
      let wouldChange = 0;
      const existing = new Map(readAll(type).map((e) => [e.id, e]));
      for (const rec of records) {
        const prev = existing.get(rec.id);
        if (!prev) { wouldChange++; continue; }
        const { defaultMerge } = require('../src/store/entity_writer');
        if (JSON.stringify(defaultMerge(prev, rec)) !== JSON.stringify(prev)) wouldChange++;
      }
      console.log(`  [dry-run] ${type}: ${records.length} 条输入，${wouldChange} 条会变化`);
    };
    preview('person', cbdbPersons);
    preview('organization', cbdbOrgs);
    preview('event', cbdbEvents);
    console.log('\n--dry-run：未写入。去掉 --dry-run 才会写盘。');
    return;
  }

  // `replaceProps`：导入器是这些人物 props 的唯一来源（生卒、史料注记、简介），
  // 重跑时应当以新提取结果为准。不加这个开关的话，修正后的模糊日期
  // （「约 1004年 ± 30」）永远写不进已有的分片。
  // `ownedPredicates`：本次导入负责哪些谓词。属于它的以新结果为准，
  // 新结果没产出就删掉——否则导入器修正掉的错误边永远清不掉。
  //
  // 用 kinMap 的实际输出而不是手写清单：手写清单会与映射表漂移，
  // 而漂移的后果是「某个谓词的旧边被当成别人的、永远留着」。
  const ownedKinPredicates = new Set();
  for (const meta of kinMap.values()) {
    if (meta.key) ownedKinPredicates.add(meta.key);
  }
  // 细化前的旧谓词也归本次导入管：它们是被 brother/sister/husband/wife 取代的。
  ownedKinPredicates.add('sibling');
  ownedKinPredicates.add('spouse');
  // `kin` 已不是谓词（说不出具体关系的杂物箱已删），但仍需声明它归本次导入管——
  // 否则磁盘上旧的 826 条 `kin` 边永远清不掉，而它们正是要消灭的东西。
  ownedKinPredicates.add('kin');

  const personStats = upsertAll('person', cbdbPersons, null, {
    replaceProps: true,
    replaceName: true,
    replaceRelations: true,
    dropProps: ['名字括注'],
    ownedPredicates: [...ownedKinPredicates],
    superseded: ['sibling', 'spouse'],
    supersededBy: { sibling: ['brother', 'sister'], spouse: ['husband', 'wife'] },
  });
  const orgStats = upsertAll('organization', cbdbOrgs);
  const eventStats = upsertAll('event', cbdbEvents);

  console.log(`  新增人物: ${personStats.added}，更新: ${personStats.updated}，合并后: ${personStats.total}`);
  console.log(`  新增组织: ${orgStats.added}，更新: ${orgStats.updated}，合并后: ${orgStats.total}`);
  console.log(`  新增事件: ${eventStats.added}，更新: ${eventStats.updated}，合并后: ${eventStats.total}`);
  console.log('实体分片已写入。请运行 npm run build:index 重建索引，再运行 npm run check。');

  // ==================== 9. 统计 ====================
  console.log('\n=== 导入统计 ===');
  console.log(`总人物: ${personStats.total} (原有 ${existingPersons.length} + CBDB新增 ${personStats.added})`);
  console.log(`总组织: ${orgStats.total} (原有 ${existingOrgs.length} + CBDB新增 ${orgStats.added})`);
  console.log(`总事件: ${eventStats.total} (原有 ${existingEvents.length} + CBDB新增 ${eventStats.added})`);

  // 按朝代统计
  //
  // `newPersons` was a reference to a variable that no longer exists, so this
  // block threw a ReferenceError AFTER the shards had already been written — the
  // import looked like a failure while having fully succeeded. Count from the
  // records upsertAll reports as newly added, which is the only list that is
  // guaranteed to exist here.
  // 朝代分布统计已随 `era` 一起删除：那些分布是年份分档的产物，不是 CBDB 的事实。
  // 改为报告生卒日期的实际覆盖率——这才是现在真实存在、可查询的信息。
  let withBirth = 0;
  let withDeath = 0;
  for (const p of personStats.addedRecords) {
    const props = p.props || {};
    if (props['出生年月']) withBirth++;
    if (props['逝世时间']) withDeath++;
  }
  console.log('\nCBDB新增人物生卒覆盖:');
  console.log(`  有出生年: ${withBirth} 人`);
  console.log(`  有逝世年: ${withDeath} 人`);

  console.log(`\n亲属关系: ${kinCount} 条`);
  console.log(`社会关系: ${assocCount} 条`);
  console.log(`组织关系: ${orgRelCount} 条`);

  console.log('\n=== 导入完成 ===');
  console.log('提示: 清除浏览器 localStorage 中的 hm_persons/hm_organizations/hm_events 后刷新页面即可看到新数据。');
}

main().catch(err => {
  console.error('导入失败:', err);
  process.exit(1);
});