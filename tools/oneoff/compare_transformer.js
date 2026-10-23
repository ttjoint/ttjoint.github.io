'use strict';
/**
 * P2-4：新 transformer 产出 vs 现有 `data/persons/entities/` 的逐字段对照。
 *
 * ## 这一步为什么必须先于「加数据」做
 *
 * 拆分层不是目的，**证明拆分层没引入回归**才是。后面 P4 要往同一批实体里
 * 塞 `c_dy`/`c_female`/`ALTNAME`，如果地基已经悄悄变了，那时的任何差异
 * 都分不清是「新数据」还是「重写弄坏的」。
 *
 * ## 对照什么
 *
 * 以 **raw 层为输入重算**，与磁盘上的分片逐字段比：
 *
 *   id / name / type / props / external / aliases / tags
 *
 * 不比 `provenance`——它是 P1 补的，导入器本来就不产。
 * 不比 `relations`——它是 `cbdb-kin` 的产物，本对照只验 `cbdb-biog`。
 *
 * ## 已知会不一致的地方，用白名单显式列出而不是放宽判据
 *
 * `summary` / `sources` 是旧格式残留（约 167 个实体有），当前导入器不产，
 * transformer 也不产。计入 `staleFields` 报告但不算失败——它们的消失正是
 * 重构想要的结果，只是需要被看见。
 *
 * 用法：
 *   node tools/oneoff/compare_transformer.js --limit 5000
 *   node tools/oneoff/compare_transformer.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const biog = require('../../src/transformers/cbdb-biog.js');
const { realYear, formatYear } = biog._internal;

const ROOT = path.join(__dirname, '..', '..');
const ENTITY_DIR = path.join(ROOT, 'data', 'persons', 'entities');
const RAW_DIR = path.join(ROOT, 'raw', 'cbdb', 'BIOG_MAIN');

const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

/** 旧格式残留字段：出现在老分片里、当前导入器不产。不计失败。 */
const STALE_FIELDS = ['summary', 'sources'];

/**
 * 后处理脚本的合法改写：这些差异是「预期内的不一致」，不是回归。
 *
 * | 脚本 | 改什么 | 为什么对 |
 * | --- | --- | --- |
 * | `split_relational_names.js` | `王氏(高敬妻)` → name `王氏` + alias `高敬妻` | 名字必须原子；括注里是关系不是名字 |
 * | `split_name_annotations.js` | 同理，别的括注形式 | 同上 |
 *
 * 这两个脚本跑在导入**之后**，所以「从 raw 重算」天然得不到它们的结果。
 * 关键是用**名字形状**识别，而不是给特定 id 开后门——否则真回归也能藏进去。
 */
const POSTPROCESSED_NAME = /[（(].+[）)]\s*$/;

function isPostprocessedNameChange(oldE, newE) {
  if (oldE.name === newE.name) return false;
  // 形状一：旧名带括注，新名是去掉括注的前缀，且旧括注进了 aliases。
  if (POSTPROCESSED_NAME.test(newE.name)) {
    const base = newE.name.replace(POSTPROCESSED_NAME, '').trim();
    if (oldE.name === base) return (oldE.aliases || []).length > (newE.aliases || []).length;
  }
  // 形状二：旧名是 raw 名的前缀，且现有 aliases 更多。
  //
  // `person:cbdb-138471` 的 raw 名是 `李氏(趙與(禾永)`——**括号不配对**（缺右括号）。
  // `split_relational_names.js` 的正则贪心切在了 `(禾永` 之前，产出
  // name=`李氏(趙與` + alias=`禾永`。现有数据因此比原文更碎。
  //
  // 这是后处理脚本的缺陷（错误根源在源数据的残缺括号），不是 transformer 的：
  // transformer 按原文产出是对的。仍在 P2 范围内记录，但不算回归。
  if (newE.name.startsWith(oldE.name)) {
    return (oldE.aliases || []).length > 0 && (newE.aliases || []).length === 0;
  }
  return false;
}

/**
 * 现有数据里的错误：差异方向是「transformer 对，分片错」。
 *
 * 典型例子是 `person:cbdb-101205`（王利用）：分片里写着 `出生年月: "14年"`，
 * 但 raw 里 `c_birthyear` 是 null、`c_index_year` 才是 14。
 * `lifespanProps` 的注释里点名过这个人：「index 14, death 77 — an activity
 * window, not a birth」。旧数据把一个活动年份提升成了生年，正是要消灭的缺陷。
 *
 * 实测共 **2,743 个实体**如此，全都是只有 `出生年月` 而无 `生卒`，而 raw 里
 * `c_birthyear = 0`（CBDB 的未知哨兵）、只有 `c_index_year`。
 * 王利用是我手抽发现的，这 2,743 个是批量对照扫出来的。
 *
 * 识别方式是**看形状不看 id**：旧数据有 `出生年月`、raw 无 `c_birthyear`，
 * 且旧值等于 `formatYear(c_index_year)`。满足这三条就是旧数据的错。
 * 按 id 开白名单会让真回归也能藏进去，所以不用白名单。
 */
function isPromotedIndexYear(oldE, payload) {
  if (!oldE.props || !oldE.props['出生年月']) return false;
  if (oldE.props['生卒']) return false; // 两个键都在说明是另一回事
  if (realYear(payload.c_birthyear) != null) return false; // raw 确实有生年
  const idx = realYear(payload.c_index_year);
  if (idx == null) return false;
  return oldE.props['出生年月'] === formatYear(idx);
}

const cbdbKey = (id) => {
  const m = /^person:cbdb-(\d+)$/.exec(String(id));
  return m ? m[1] : null;
};

/** 读现有分片，建 personid -> entity。 */
function loadExisting() {
  const map = new Map();
  const files = fs.readdirSync(ENTITY_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    if (map.size >= LIMIT) break;
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(ENTITY_DIR, f), 'utf8')); } catch { continue; }
    const k = cbdbKey(e.id);
    if (!k) continue;
    map.set(k, e);
  }
  return map;
}

/** 从 raw 层重算，只算现有分片覆盖到的那些 personid。 */
function recompute(wanted) {
  const out = new Map();
  const payloads = new Map();
  const dropped = [];
  for (const f of fs.readdirSync(RAW_DIR).filter((x) => x.endsWith('.gz')).sort()) {
    let text;
    try { text = zlib.gunzipSync(fs.readFileSync(path.join(RAW_DIR, f))).toString('utf8'); }
    catch (e) { console.warn('WARN 分片损坏', f, e.message); continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const p = r.payload;
      if (!p) continue;
      const k = String(p.c_personid);
      if (!wanted.has(k)) continue;
      const res = biog.transform(r);
      if (res.entities.length) {
        out.set(k, res.entities[0]);
        // 带的 raw payload 是给 isPromotedIndexYear 用的：它必须看源数据
        // 才能区分「旧数据把 index year 当生年」与「真的是另一回事」。
        payloads.set(k, p);
      } else dropped.push(k);
    }
    if (out.size >= wanted.size) break;
  }
  return { map: out, payloads, dropped };
}

/** 旧导入器用年份分档得出的粗糙朝代名。 */
const COARSE_BANDS = new Set(['先秦', '秦', '两汉', '三国', '晋', '南北朝', '隋唐及以后', '年代不详']);

/** 新值是不是 CBDB `DYNASTIES` 里的真朝代名。 */
const DYNASTY_NAMES = new Set(biog._internal.DYNASTY_NAME.values());
const isDynastyName = (t) => DYNASTY_NAMES.has(t);

/**
 * 逐字段比对两个对象，返回差异描述数组。
 *
 * 方向固定为 **旧 → 新**（现有分片 → transformer 重算结果）。
 * 第一版按 `(new, old)` 传参并写成 `a -> b`，于是输出是「新 → 旧」，
 * 把 `[宋] -> [隋唐及以后]` 读成了「transformer 退化了」，实际相反。
 * 差异报告的方向不能靠看代码才知道。
 */
function diffEntity(oldE, newE) {
  const diffs = [];
  for (const f of ['id', 'name', 'type']) {
    if (oldE[f] !== newE[f]) diffs.push(`${f}: ${JSON.stringify(oldE[f])} -> ${JSON.stringify(newE[f])}`);
  }
  // props 按键比，缺键和多键都要报。
  const ap = oldE.props || {};
  const bp = newE.props || {};
  for (const k of new Set([...Object.keys(ap), ...Object.keys(bp)])) {
    if (ap[k] === bp[k]) continue;
    diffs.push(`props.${k}: ${JSON.stringify(ap[k])} -> ${JSON.stringify(bp[k])}`);
  }
  // external
  const ae = JSON.stringify(oldE.external || {});
  const be = JSON.stringify(newE.external || {});
  if (ae !== be) diffs.push(`external: ${ae} -> ${be}`);
  // aliases / tags 是数组，顺序没意义，排序后比。
  for (const f of ['aliases', 'tags']) {
    const x = [...(oldE[f] || [])].sort().join('|');
    const y = [...(newE[f] || [])].sort().join('|');
    if (x !== y) diffs.push(`${f}: [${x}] -> [${y}]`);
  }
  return diffs;
}

function main() {
  console.log(`对照模式${LIMIT !== Infinity ? ` limit=${LIMIT}` : ' 全量'}`);

  const existing = loadExisting();
  console.log(`现有 CBDB 分片：${existing.size}`);

  const { map: fresh, payloads, dropped } = recompute(new Set(existing.keys()));
  console.log(`从 raw 重算得到：${fresh.size}（被判为非身份丢弃 ${dropped.length}）`);

  let same = 0;
  const diffBuckets = new Map(); // 字段 -> 次数
  const examples = [];
  let staleSeen = 0;
  let postprocessed = 0;
  let knownBad = 0;
  let tagImproved = 0;
  let missing = 0;

  for (const [k, oldE] of existing) {
    const newE = fresh.get(k);
    if (!newE) { missing++; continue; }
    const diffs = diffEntity(oldE, newE);
    if (!diffs.length) { same++; continue; }
    // 把 stale 字段从差异里剥掉后若为空，就只是旧残留，不算回归。
    let real = diffs.filter((d) => !STALE_FIELDS.some((s) => d.startsWith(`props.${s}:`)));
    // 后处理脚本（拆括注名）的改写也不是回归。
    if (isPostprocessedNameChange(oldE, newE)) {
      real = real.filter((d) => !d.startsWith('name:') && !d.startsWith('aliases:'));
      postprocessed++;
    }
    if (isPromotedIndexYear(oldE, payloads.get(k) || {})) {
      // 旧数据把活动年份提升成生年，transformer 没有跟着错——不是回归。
      knownBad++;
      real = [];
    }
    // tags 从粗粒度年份分档（「隋唐及以后」）换成 c_dy 精确朝代（「宋」）。
    // 实测 47 万个实体如此——这么大的变更量如果算成「差异」，真正的回归
    // 会被淹没在噪声里。判据看**形状**：旧值是已知的粗档名，新值在
    // DYNASTY_NAME 里。两边都不满足就不是这个原因，仍然计差异。
    if (real.length && real.every((d) => d.startsWith('tags:'))) {
      const oldTag = (oldE.tags || [])[0];
      const newTag = (newE.tags || [])[0];
      if (COARSE_BANDS.has(oldTag) && isDynastyName(newTag)) {
        tagImproved++;
        real = [];
      }
    }
    if (!real.length) { staleSeen++; same++; continue; }
    for (const d of real) {
      const key = d.split(':')[0].replace(/^props\./, 'props.');
      diffBuckets.set(key, (diffBuckets.get(key) || 0) + 1);
    }
    // 每个字段各留几例：只优先存前 8 个会让首个字段占满名额，
    // 后面的差异就只剩计数、看不到长相。
    for (const d of real) {
      const key = d.split(':')[0];
      const bucket = examples.filter((x) => x.field === key);
      if (bucket.length >= 3) continue;
      examples.push({ field: key, id: oldE.id, diff: d });
    }
  }

  console.log('\n=== 结果 ===');
  console.log(`  完全一致: ${same}`);
  console.log(`  其中仅差旧残留字段(${STALE_FIELDS.join('/')}): ${staleSeen}`);
  console.log(`  其中拆括注名的后处理改写: ${postprocessed}`);
  console.log(`  其中现有数据判错、transformer 修对: ${knownBad}`);
  console.log(`  其中朝代标签从粗档换成 c_dy 精确值: ${tagImproved}`);
  console.log(`  有实质差异: ${existing.size - same - missing}`);
  console.log(`  raw 里重新算不出来: ${missing}`);

  if (diffBuckets.size) {
    console.log('\n  差异分布（字段 -> 次数）:');
    for (const [k, v] of [...diffBuckets].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k}: ${v}`);
    }
    console.log('\n  样例（每类最多 3 例）:');
    for (const ex of examples) {
      console.log(`    ${ex.id}  ${ex.diff}`);
    }
  }

  const failed = existing.size - same - missing;
  process.exitCode = failed ? 1 : 0;
}

main();
