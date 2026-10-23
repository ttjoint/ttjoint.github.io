#!/usr/bin/env node
'use strict';
/**
 * 合并「同一 CBDB 记录对应两个实体」的重复节点。
 *
 * ## 问题
 *
 * `import_cbdb.js` 曾按「同名总数」决定编号。当 CBDB 里有两行 `劉環雋` 时，
 * 第一行复用了磁盘上已有的 `劉環雋` 分片，第二行生成 `劉環雋（1）`——但磁盘上
 * 那对 `劉環雋（1）` 本来就不该存在。结果是 163 个 `cbdbId` 各自指向两个实体：
 *
 *   cbdbId 20209 → 劉環雋 (person:03bc…) + 劉環雋（1） (person:b809…)
 *
 * 这直接摧毁了外部 id 的作用——它本来是用来**消除**同名歧义的，现在同一个 id
 * 指向两个人，既不能追溯也不能去重。
 *
 * 导入器已改成「按行占用槽位，同一分片只能被认领一次」，但历史数据里的重复
 * 对不会自己消失。本脚本处理存量。
 *
 * ## 为什么是合并而不是删除
 *
 * 重复对的两边都不是空壳：多数字段相同，但亲属边可能一边有一条、另一边有两条
 * （62 对数据量相当，58 对后者更富，43 对前者更富）。直接删一个会丢数据。
 *
 * ## 保留哪一个
 *
 * 保留**不带序号后缀**的那个（`劉環雋` 而非 `劉環雋（1）`），因为规范 id 应当
 * 由规范名字派生；名字被改回的代价高于 id 被改回。若两边都有后缀，保留数据更
 * 丰富的那个。选择规则写进输出，便于核对。
 *
 * 用法：
 *   node tools/oneoff/merge_duplicate_cbdb_entities.js --dry-run
 *   node tools/oneoff/merge_duplicate_cbdb_entities.js
 */
const fs = require('fs');
const { readAll, upsertAll, shardPath, FOLDERS } = require('../../src/store/entity_writer');

const DRY_RUN = process.argv.includes('--dry-run');
const SUFFIX = /（\d+）$/;

const weight = (e) =>
  Object.keys(e.props || {}).length +
  Object.keys(e.relations || {}).length +
  (e.sources || []).length;

/** 把 b 的事实并入 a；a 已有的非空值优先。 */
function mergeInto(a, b) {
  const out = { ...a };
  out.props = { ...(b.props || {}), ...(a.props || {}) };
  out.aliases = [...new Set([...(a.aliases || []), ...(b.aliases || []), b.name])]
    .filter((x) => x && x !== a.name);
  out.tags = [...new Set([...(a.tags || []), ...(b.tags || [])])];
  out.sources = [...new Set([...(a.sources || []), ...(b.sources || [])])];
  out.external = { ...(b.external || {}), ...(a.external || {}) };

  // relations: 并集，但不并入自指边（合并后 a→a 无意义）
  out.relations = {};
  for (const src of [b.relations || {}, a.relations || {}]) {
    for (const [k, list] of Object.entries(src)) {
      const ids = (Array.isArray(list) ? list : [list])
        .map((x) => (typeof x === 'string' ? x : x && x.id))
        .filter((id) => id && id !== a.id && id !== b.id);
      if (!ids.length) continue;
      out.relations[k] = [...new Set([...(out.relations[k] || []), ...ids])];
    }
  }
  return out;
}

function main() {
  const persons = readAll('person');

  // cbdbId → 实体列表
  const byCbdbId = new Map();
  for (const e of persons) {
    const id = e.external && e.external.cbdbId;
    if (!id) continue;
    if (!byCbdbId.has(id)) byCbdbId.set(id, []);
    byCbdbId.get(id).push(e);
  }

  const groups = [...byCbdbId.entries()].filter(([, list]) => list.length > 1);
  console.log(`发现 ${groups.length} 个 cbdbId 指向多个实体`);

  if (!groups.length) return;

  // 决定保留者
  const dropIds = new Set();
  const survivors = [];
  for (const [cbdbId, list] of groups) {
    // 无后缀优先，其次数据更丰富，最后按 id 稳定排序
    const sorted = [...list].sort((x, y) => {
      const sx = SUFFIX.test(x.name) ? 1 : 0;
      const sy = SUFFIX.test(y.name) ? 1 : 0;
      if (sx !== sy) return sx - sy;
      const dw = weight(y) - weight(x);
      if (dw !== 0) return dw;
      return x.id < y.id ? -1 : 1;
    });
    let keep = sorted[0];
    for (const dup of sorted.slice(1)) {
      keep = mergeInto(keep, dup);
      dropIds.add(dup.id);
    }
    survivors.push(keep);
  }

  console.log(`保留 ${survivors.length} 个，删除 ${dropIds.size} 个`);

  // 把指向被删实体的边改指向保留者
  const redirect = new Map();
  for (const [cbdbId, list] of groups) {
    const keep = survivors.find((s) => s.external && s.external.cbdbId === cbdbId);
    for (const e of list) if (e.id !== keep.id) redirect.set(e.id, keep.id);
  }

  let rewired = 0;
  const updated = [];
  for (const type of Object.keys(FOLDERS)) {
    for (const e of readAll(type)) {
      if (dropIds.has(e.id)) continue;
      let dirty = false;
      for (const [k, list] of Object.entries(e.relations || {})) {
        if (!Array.isArray(list)) continue;
        const next = list.map((x) => {
          const id = typeof x === 'string' ? x : x && x.id;
          if (redirect.has(id)) { dirty = true; return redirect.get(id); }
          return x;
        });
        if (dirty) e.relations[k] = [...new Set(next)];
      }
      if (dirty) { rewired++; updated.push(e); }
    }
  }
  console.log(`改指向的实体: ${rewired}`);

  if (DRY_RUN) {
    console.log('\n[dry-run] 示例（保留 → 删除）：');
    for (const [cbdbId, list] of groups.slice(0, 10)) {
      const keep = survivors.find((s) => s.external && s.external.cbdbId === cbdbId);
      const gone = list.filter((e) => e.id !== keep.id).map((e) => e.name);
      console.log(`  ${cbdbId}: ${keep.name} ← ${gone.join(', ')}`);
    }
    console.log('\n--dry-run：未写入');
    return;
  }

  for (const e of survivors) {
    const type = e.type || 'person';
    fs.writeFileSync(shardPath(type, e.id), JSON.stringify(e, null, 2) + '\n', 'utf8');
  }
  for (const e of updated) {
    if (dropIds.has(e.id)) continue;
    fs.writeFileSync(shardPath(e.type, e.id), JSON.stringify(e, null, 2) + '\n', 'utf8');
  }
  for (const id of dropIds) {
    const file = shardPath('person', id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  console.log('已写入');
}

main();
