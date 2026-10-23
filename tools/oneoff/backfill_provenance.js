'use strict';
/**
 * P1-2：给现有实体补 `provenance`。
 *
 * ## 目标
 *
 * 486,786 个实体目前 **0 个**有 `provenance`（实测抽样 3,000 全空）。
 * 这一步让每个实体的每个 `props` 项都能指回第 0 层的原始记录。
 *
 * ## provenance 五项从哪来
 *
 * 结构见 `节点类型与谓词.md` §6.2：
 *
 * | 字段 | 本脚本的取值 |
 * | --- | --- |
 * | `rawRef` | `raw:cbdb/BIOG_MAIN/<c_personid>`（由 `external.cbdbId` 定位） |
 * | `locator` | `{ sourceId }`——CBDB 的 `c_index_year_source_id`，可空 |
 * | `quote` | **原始行字段的原文拼接**，如 `c_birthyear=1328 c_deathyear=1398` |
 * | `reason` | 哪个字段推出了哪个 props 项 |
 * | `commitId` | 本次回填生成的提交 |
 *
 * ## `quote` 为什么是「字段拼接」而不是「原文摘录」
 *
 * 对数据库类文献，**原文就是那一行的字段值**（`medium: 'database'`）。
 * 不编造任何源数据里没有的句子——`quote` 只重组已存在的字节。
 *
 * 曾考虑写成「朱元璋，生于1328年」，但那已经是翻译/解释，
 * 违反「第 0 层原样保存」的既定原则，且无法回验。
 *
 * ## 粒度
 *
 * **一个实体一条 provenance**，不是每个 props 项一条。
 * 理由：同一个人的生年、卒年、注记都来自 `BIOG_MAIN` 的同一行，
 * 为每个字段重复一份 `rawRef` 会让 486k 实体体积翻好几倍，
 * 而溯源价值不变（`reason` 里已经写明哪个字段推出了哪一项）。
 *
 * 若日后某 props 项来自别的表，再追加第二条 provenance。
 *
 * ## 幂等
 *
 * 已有 `provenance` 非空的实体跳过，不覆盖。加 `--force` 才重写。
 *
 * 用法：
 *   node tools/oneoff/backfill_provenance.js --limit 1000 --dry-run
 *   node tools/oneoff/backfill_provenance.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { appendCommit } = require('../../src/store/commits.js');

const ROOT = path.join(__dirname, '..', '..');
const ENTITY_DIR = path.join(ROOT, 'data', 'persons', 'entities');
const RAW_BIOG = path.join(ROOT, 'raw', 'cbdb', 'BIOG_MAIN');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i >= 0 ? Number(argv[i + 1]) : Infinity;
})();

/** props 项 -> 依据它的 CBDB 列。用于写 `reason`，不是新造数据。 */
const PROP_SOURCE = {
  '出生年月': ['c_birthyear', 'c_by_nh_code', 'c_by_nh_year'],
  '逝世时间': ['c_deathyear', 'c_dy_nh_code', 'c_dy_nh_year'],
  '史料注记': ['c_notes'],
  '字号': ['c_choronym_code'],
  '族群': ['c_ethnicity_code'],
  // `生卒` 是 c_index_year 的**故意退化形式**，不是遗留脏数据。
  // import_cbdb.js:188 只在无其他日期时才写它，因为 c_index_year 可能是
  // 活动年份而非生年（`c_index_year_type_code` 区分）。把它当生年会
  // 把 1751 年正在做官的人显示成 1751 年出生。
  '生卒': ['c_index_year', 'c_index_year_type_code'],
};

/** `person:cbdb-123` -> `123`。 */
const cbdbKey = (id) => {
  const m = /^person:cbdb-(\d+)$/.exec(String(id));
  return m ? m[1] : null;
};

/**
 * 从原始 payload 构造 quote：只拼接已存在的非空字段，不生成新句子。
 */
function buildQuote(payload, fields) {
  const parts = [];
  for (const f of fields) {
    const v = payload[f];
    if (v === null || v === undefined || v === '') continue;
    parts.push(`${f}=${v}`);
  }
  return parts.join(' ');
}

/** 收集本批实体需要的 personid，避免把 66 万行全读进内存。 */
function collectTargets() {
  const files = fs.readdirSync(ENTITY_DIR).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    if (out.length >= LIMIT) break;
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(ENTITY_DIR, f), 'utf8')); } catch { continue; }
    if (!FORCE && Array.isArray(e.provenance) && e.provenance.length) continue;
    const key = cbdbKey(e.id);
    if (!key) continue; // 非 CBDB 实体本轮不处理，见报告
    out.push({ file: f, entity: e, key });
  }
  return out;
}

/** 载入需要的那几行原始记录。 */
function loadRaw(wanted) {
  const map = new Map();
  if (!fs.existsSync(RAW_BIOG)) return map;
  for (const f of fs.readdirSync(RAW_BIOG).filter((x) => x.endsWith('.gz')).sort()) {
    let text;
    try {
      text = zlib.gunzipSync(fs.readFileSync(path.join(RAW_BIOG, f))).toString('utf8');
    } catch (e) {
      console.warn('WARN 分片损坏', f, e.message);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r.payload) continue;
      const id = String(r.payload.c_personid);
      if (!wanted.has(id)) continue;
      map.set(id, { rawId: r.rawId, payload: r.payload });
    }
  }
  return map;
}

function main() {
  console.log(`模式：${DRY ? 'DRY-RUN' : '实际写入'}${LIMIT !== Infinity ? `  limit=${LIMIT}` : ''}`);

  const targets = collectTargets();
  console.log(`待补实体的 CBDB 部分：${targets.length}`);
  if (!targets.length) return;

  const wanted = new Set(targets.map((t) => t.key));
  const raw = loadRaw(wanted);
  console.log(`在 raw/ 中找到原始记录：${raw.size} / ${wanted.size}`);

  const commit = DRY
    ? { commitId: 'c-DRYRUN' }
    : appendCommit({
      author: 'backfill-provenance@1.0.0',
      message: `P1-2 为 ${targets.length} 个 CBDB 人物补 provenance`,
      stats: { entities: targets.length, rawFound: raw.size },
    });
  console.log(`提交：${commit.commitId}`);

  let written = 0;
  let missingRaw = 0;
  let emptyProps = 0;
  const propKeys = {};
  let firstExample = null;

  for (const { file, entity, key } of targets) {
    const r = raw.get(key);
    if (!r) { missingRaw++; continue; }

    const props = entity.props || {};
    const keys = Object.keys(props);
    for (const k of keys) propKeys[k] = (propKeys[k] || 0) + 1;

    // 收集推出这些 props 项用到的列。
    const usedFields = new Set();
    for (const k of keys) {
      const cols = PROP_SOURCE[k] || [];
      for (const c of cols) usedFields.add(c);
    }

    // `reason` 写得很短是有意的。
    //
    // 第一版把整串列名都写进去（「出生年月 ← c_birthyear/c_by_nh_code/…」），
    // 测出每实体 +530 字节、全量 +246 MB（增幅 189%）。而那串内容对
    // 所有实体完全一样——它描述的是**转换器规则**，不是这条记录的特殊性。
    // 规则应该写在转换器代码里（PROP_SOURCE），而不是在 48 万份数据里重复。
    // 这里只记「用了哪些列」，供人工抽查时快速对账。
    //
    // 无 props 的实体（实测 140,848 个空壳人物）仍需 provenance。
    // §6.1：「节点出处不能由边推导：一个只有名字、没有任何边的实体仍然真实存在过」。
    // 它的出处就是名字本身——`c_name_chn` 那一行。
    let reason;
    if (!keys.length) {
      usedFields.add('c_name_chn');
      reason = 'name';
      emptyProps++;
    } else {
      reason = keys.join(',');
    }
    // 标明数据性质：这是从二手数据库摘录的，不是文献原文。
    //
    // `quote` 里是 `c_birthyear=1873 c_by_nh_code=666` 这样的列名拼接——
    // 它对人不可读，因为 CBDB 本来就不存句子，它把文献整理成了字段。
    // 不加这句说明，用户点开「引用来源 → 引文」看到一串列名，
    // 会以为出处坏了或者引文抓取失败。
    //
    // 每条约 +20 字节，48.7 万条约 +9 MB（库总 580 MB）。这个代价换
    // 「知道自己在看什么」，值得。
    reason += '；二手数据库摘录，非文献原文';

    const quote = buildQuote(r.payload, [...usedFields].sort());
    const locator = {};
    if (r.payload.c_index_year_source_id != null) {
      locator.sourceId = r.payload.c_index_year_source_id;
    }

    entity.provenance = [{
      rawRef: r.rawId,
      locator,
      // quote 必填非空。若推出的列全为空（例如只有性别），退回整行标识，
      // 而不是写空串假装有出处。
      quote: quote || `c_personid=${r.payload.c_personid}`,
      reason,
      commitId: commit.commitId,
    }];

    if (!firstExample) firstExample = { id: entity.id, prov: entity.provenance[0] };

    if (!DRY) {
      fs.writeFileSync(path.join(ENTITY_DIR, file), JSON.stringify(entity, null, 2) + '\n', 'utf8');
    }
    written++;
  }

  console.log('\n=== 结果 ===');
  console.log(`  已补 provenance: ${written}`);
  console.log(`  raw 中找不到:    ${missingRaw}`);
  console.log(`  其中无 props（仅有名字）: ${emptyProps}`);
  console.log('\n  props 键分布:', JSON.stringify(propKeys));
  if (firstExample) {
    console.log('\n  示例:', firstExample.id);
    console.log('  ', JSON.stringify(firstExample.prov, null, 1).replace(/\n/g, '\n   '));
  }
  if (DRY) console.log('\n（dry-run，未写任何文件，未写提交）');
}

main();
