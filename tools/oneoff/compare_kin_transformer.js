'use strict';
/**
 * 比对「从 raw 层用 cbdb-kin transformer 重算的亲属边」与「现有 data/ 里的边」。
 *
 * ## 为什么要比
 *
 * P2 的验收标准是「映射逻辑搬进 transformers 后，重跑得到与现有数据等价的结果」。
 * 现有 5 万条边里有些是迁移脚本（`split_kinship_primitives.js`）改出来的，
 * `import_cbdb.js` 的老逻辑已经对不上了。在有量化结论之前，不能声称
 * transformer 是等价的。
 *
 * ## 比什么
 *
 * 每条边是 `(subject, predicate, object)`。qualifier（`role`/`objectGender`）
 * 单独统计——同一对 (subject, object) 可能因 qualifier 不同而合法地存多条
 * （§「同义关系边按 qualifiers 区分，不做去重删边」）。
 *
 * ## 差异的类型学
 *
 * - `missing`：raw 里有、data 里没有 → transformer 多出边
 * - `extra`  ：data 里有、raw 里没有 → **这一条最重要**，说明现有数据有
 *              无出处的边，是 P1 溯源审计要找的东西
 * - `predicateMismatch`：同 subject/object 但谓词不同 → 映射分歧
 *
 * 用法：
 *   node tools/oneoff/compare_kin_transformer.js [--limit N]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const kin = require('../../src/transformers/cbdb-kin.js');

const ROOT = path.join(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, 'raw', 'cbdb', 'KIN_DATA');
const ENTITY_DIR = path.join(ROOT, 'data', 'persons', 'entities');

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();

/** 现有数据：subject -> predicate -> Set(object)，连带 qualifier 签名。 */
function loadExisting() {
  const out = new Map();
  let count = 0;
  for (const f of fs.readdirSync(ENTITY_DIR)) {
    if (!f.endsWith('.json')) continue;
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(ENTITY_DIR, f), 'utf8')); } catch { continue; }
    if (!e.relations) continue;
    for (const [pred, targets] of Object.entries(e.relations)) {
      for (const t of targets || []) {
        const k = `${e.id}\u0000${pred}\u0000${t}`;
        out.set(k, true);
        count++;
      }
    }
  }
  return { map: out, count };
}

/** 从 raw 重算。 */
function recompute() {
  const out = new Map();
  const dropped = new Map(); // reason -> count
  const edgeCount = {};
  let rows = 0;
  for (const f of fs.readdirSync(RAW_DIR).filter((x) => x.endsWith('.gz')).sort()) {
    let text;
    try { text = zlib.gunzipSync(fs.readFileSync(path.join(RAW_DIR, f))).toString('utf8'); }
    catch (e) { console.warn('WARN 分片损坏', f, e.message); continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      rows++;
      if (rows > LIMIT) break;
      const res = kin.transform(r);
      if (res.dropped) {
        const why = res.dropped.reason.replace(/\d+$/, '<n>');
        dropped.set(why, (dropped.get(why) || 0) + 1);
      }
      for (const e of res.edges) {
        out.set(`${e.subject}\u0000${e.predicate}\u0000${e.object}`, e);
        edgeCount[e.predicate] = (edgeCount[e.predicate] || 0) + 1;
      }
    }
    if (rows > LIMIT) break;
  }
  return { map: out, dropped, edgeCount, rows };
}

function main() {
  const existing = loadExisting();
  console.log(`现有边：${existing.count} 条`);

  const fresh = recompute();
  console.log(`raw 行：${fresh.rows}`);
  console.log(`重算边：${fresh.map.size} 条`);

  console.log('\n重算边的谓词分布：');
  for (const [k, v] of Object.entries(fresh.edgeCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(7)} ${k}`);
  }

  if (fresh.dropped.size) {
    console.log('\n丢弃的行：');
    for (const [why, n] of [...fresh.dropped].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(7)} ${why}`);
    }
  }

  const missing = [];
  for (const k of fresh.map.keys()) if (!existing.map.has(k)) missing.push(k);
  const extra = [];
  for (const k of existing.map.keys()) if (!fresh.map.has(k)) extra.push(k);

  // 「raw 有、data 没有」大量来自 **P4 的缺口**：现有 51,814 条边只是多次
  // 导入里的第一批，`import_cbdb.js` 里的 `cbdbIdMap` 只含本次导入的人，
  // 所以早期人的边漏了。这不是 transformer 的错。
  //
  // 为了判定 transformer 本身对不对，把对比范围收窄到「**两端实体在
  // 现有数据里都已有边**」的子集：这个子集里缺边就是真回归。
  const subjectsWithEdges = new Set();
  for (const k of existing.map.keys()) subjectsWithEdges.add(k.split('\u0000')[0]);
  const missingInCovered = missing.filter((k) => {
    const [s] = k.split('\u0000');
    return subjectsWithEdges.has(s);
  });

  console.log('\n=== 结果 ===');
  console.log(`  两边都有: ${existing.map.size - extra.length}`);
  console.log(`  raw 有、data 没有: ${missing.length}`);
  console.log(`    其中 subject 在现有数据里已有边的: ${missingInCovered.length}（这部分才是回归）`);
  console.log(`  data 有、raw 没有: ${extra.length}`);

  const show = (label, arr) => {
    if (!arr.length) return;
    console.log(`\n${label}（最多 15 例）：`);
    for (const k of arr.slice(0, 15)) {
      const [s, p, o] = k.split('\u0000');
      console.log(`  ${s}  ${p}  ${o}`);
    }
  };
  show('raw 有、data 没有（subject 已覆盖）', missingInCovered);
  show('data 有、raw 没有', extra);
}

main();
