#!/usr/bin/env node
'use strict';
/**
 * 删除两类不该成为图节点的东西：
 *
 *   1. **非法谓词边**（`其他` / `文学`）。`import_cbdb.js` 曾把 CBDB 中无法
 *      映射的 ASSOC 类别折叠成中文标签写进 `relations`，而 `relations` 的键必须
 *      是 `src/predicates/registry.js` 里的英文谓词键。后果是这些边在浏览器端
 *      无法反查方向、无法渲染标签，`其他` 更是断言了"有某种关系"却说不出是什么。
 *      导入器已改成"映射不到就不建边"，本脚本清掉历史残留。
 *
 *   2. **姓名不详的占位人物**（`某某（7）` / `某某(某昉父)`）。CBDB 如实记录了
 *      无名者，但把它们做成人格节点是错的：两个 `某某` 会变成两个互不相干的人，
 *      搜索返回 `某某（7）`，每条亲属边都挂在一个无法识别的主体上。
 *
 * ## 为什么占位人物需要 `--prune-placeholders`
 *
 * 删节点会连带删掉指向它的亲属边。这些边的另一端同样是占位名（`某昉` 的父亲是
 * `某某（2）`），整条边两端都不可识别，删除不损失可信信息——但它是**不可逆的**，
 * 所以默认只报告，必须显式加参数才执行。
 *
 * 用法：
 *   node tools/oneoff/prune_invalid_edges.js --dry-run
 *   node tools/oneoff/prune_invalid_edges.js                     # 只清非法谓词
 *   node tools/oneoff/prune_invalid_edges.js --prune-placeholders # 另删占位人物
 *   node tools/oneoff/prune_invalid_edges.js --prune-orphans      # 另删孤立空实体
 */
const fs = require('fs');
const { readAll, shardPath, FOLDERS } = require('../../src/store/entity_writer');
const { BUILTIN } = require('../../src/predicates/registry');

const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE_PLACEHOLDERS = process.argv.includes('--prune-placeholders');
const PRUNE_ORPHANS = process.argv.includes('--prune-orphans');

const VALID_PREDICATES = new Set(BUILTIN.map((p) => p.key));

/**
 * 名字整体是"不詳"的记录。去掉括号里的注记后只剩「某」字的即为占位。
 *
 * Deliberately narrow: `陳某(陳洎子)` is a real kinship record about an unnamed
 * Chen, and it is still a node with an identifier problem, but dropping every
 * 「某」 name would also sweep up 某昉 / 某貞 — which are partial names, not
 * placeholders, and are referenced by real edges.
 */
function isPlaceholder(name) {
  const core = String(name || '').replace(/[（(][^）)]*[）)]/g, '').trim();
  return core !== '' && /^[某]+$/.test(core);
}

function main() {
  const placeholders = new Set(
    readAll('person').filter((e) => isPlaceholder(e.name)).map((e) => e.id),
  );

  /**
   * 孤立空实体：无 props / 无 relations / 无 claims / 无 sources / 无 aliases，
   * 且没有被任何实体引用。
   *
   * These are the leftovers of hand-entered name lists that were never filled in:
   * 84 Three-Kingdoms and Warring-States figures (张辽, 廉颇, 蔺相如) plus 8
   * historical events, none of which carry a single fact and none of which
   * anything points at. They are not "sparse", they are empty — searching for
   * 张辽 returns a page with no content and no way to tell it is a stub.
   *
   * The reference check is what makes this safe: an entity that something points
   * at is kept even if it is empty, because deleting it would dangle the edge.
   */
  const referenced = new Set();
  const addRef = (v) => {
    const id = typeof v === 'string' ? v : v && v.id;
    if (id && id.includes(':')) referenced.add(id);
  };
  const all = [];
  for (const type of Object.keys(FOLDERS)) for (const e of readAll(type)) all.push(e);
  for (const e of all) {
    for (const list of Object.values(e.relations || {})) {
      (Array.isArray(list) ? list : [list]).forEach(addRef);
    }
    (e.sources || []).forEach(addRef);
    (e.tags || []).forEach(addRef);
  }

  const isEmptyEntity = (e) =>
    !(e.props && Object.keys(e.props).length) &&
    !(e.relations && Object.keys(e.relations).length) &&
    !(e.claims && Object.keys(e.claims).length) &&
    !(e.sources && e.sources.length) &&
    !(e.aliases && e.aliases.length);

  const orphans = PRUNE_ORPHANS
    ? all.filter((e) => isEmptyEntity(e) && !referenced.has(e.id))
    : [];
  const orphanIds = new Set(orphans.map((e) => e.id));

  let edgesRemoved = 0;
  let nodesRemoved = 0;
  let written = 0;

  for (const type of Object.keys(FOLDERS)) {
    for (const entity of readAll(type)) {
      if (orphanIds.has(entity.id)) continue; // 整体删除，无需再改
      let dirty = false;

      // 1. 非法谓词
      for (const key of Object.keys(entity.relations || {})) {
        if (VALID_PREDICATES.has(key)) continue;
        const n = (entity.relations[key] || []).length;
        edgesRemoved += n;
        delete entity.relations[key];
        dirty = true;
        if (DRY_RUN) console.log(`  [dry-run] ${entity.name}: 删除谓词 ${key} 的 ${n} 条边`);
      }

      // 2. 指向占位人物的边
      if (PRUNE_PLACEHOLDERS) {
        for (const [key, list] of Object.entries(entity.relations || {})) {
          if (!Array.isArray(list)) continue;
          const kept = list.filter((x) => !placeholders.has(typeof x === 'string' ? x : x && x.id));
          if (kept.length !== list.length) {
            edgesRemoved += list.length - kept.length;
            if (kept.length) entity.relations[key] = kept;
            else delete entity.relations[key];
            dirty = true;
          }
        }
      }

      if (dirty) {
        written++;
        if (!DRY_RUN) {
          fs.writeFileSync(shardPath(type, entity.id), JSON.stringify(entity, null, 2) + '\n', 'utf8');
        }
      }
    }
  }

  if (PRUNE_PLACEHOLDERS) {
    for (const id of placeholders) {
      nodesRemoved++;
      if (DRY_RUN) continue;
      const file = shardPath('person', id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }

  if (PRUNE_ORPHANS) {
    for (const e of orphans) {
      if (DRY_RUN) { console.log(`  [dry-run] 删除孤立空实体 ${e.type}:${e.name}`); continue; }
      const file = shardPath(e.type, e.id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }

  console.log(`\n删除非法谓词边: ${edgesRemoved}`);
  console.log(`改动实体: ${written}`);
  if (PRUNE_PLACEHOLDERS) console.log(`删除占位人物节点: ${nodesRemoved}`);
  else if (placeholders.size) console.log(`占位人物节点: ${placeholders.size}（加 --prune-placeholders 才删除）`);
  if (PRUNE_ORPHANS) console.log(`删除孤立空实体: ${orphans.length}`);
  if (DRY_RUN) console.log('--dry-run：未写入');
}

main();
