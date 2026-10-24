#!/usr/bin/env node
// 跨来源实体归并：把「同一个人」在不同来源的实体连起来。
//
// ## 为什么必须有这一步
//
// 没有归并时，苏轼是两个实体：
//
//   person:cbdb-3767            生 1036
//   person:wikipedia-e89887e8bbbe  生 1037年1月8日
//
// 于是：
//   - 多说法检测器看不到冲突（它们不在同一个 subject 下）
//   - 页面显示两个「苏轼」，用户不知道该点哪个
//   - 两个人的关系图谱被割裂
//
// 实测：31 个维基人物里 29 个在 CBDB 有同名实体，全部是「同一人被拆成两个」。
//
// ## 为什么不做物理合并
//
// 「合并」意味着删掉一个实体、把边搬到另一个上。这不可逆，而且会丢信息：
//
//   - 两个来源的生年不同，合并后只能保留一个（或者两个都塞进 props）
//   - 万一归并错了（同名不同人），已经搬走的边很难还原
//   - 无法追溯「这条断言原本属于哪个来源的实体」
//
// 所以改成**建链接**：`entity_merges` 表记 (canonical, merged, 依据)。
// 原始实体和它的边一条不动，查询时把同一组的实体视为一个。
//
// 这样归并错了只需删一行，所有数据自动恢复原状。
//
// ## 归并条件（保守）
//
//   1. 同类型（都是 person）
//   2. 同名（完全一致）
//   3. 生卒年不矛盾（区间有交集，或一方缺失）
//   4. 不跨组（已归并的不能再次归并到别的组）
//
// 任一条件不满足就不归并——宁可留两个「苏轼」让人工判断，
// 也不要把两个人错并成一个。
//
// 用法：
//   node scripts/merge_entities.js --dry-run
//   node scripts/merge_entities.js --source wikipedia
//   node scripts/merge_entities.js --list

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(ROOT, 'local_data', 'humanmap.sqlite3');

function parseArgs(argv) {
  const out = { dryRun: false, source: 'wikipedia', list: false, unmerge: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--source') out.source = argv[++i];
    else if (a === '--list') out.list = true;
    else if (a === '--unmerge') out.unmerge = argv[++i];
  }
  return out;
}

/**
 * 生卒年是否矛盾。
 *
 * 缺一方的时间不算矛盾——很多史料只记生年或只记卒年。
 * 只有两边都有值且**完全无交集**时才算矛盾。
 *
 * 注意：这里不判「相等」。苏轼 CBDB 1036、维基 1037 是**不同说法**，
 * 恰恰是我们想保留的冲突，不该因为它不同就拒绝归并。
 */
function lifespanCompatible(a, b) {
  const aFrom = a.valid_from;
  const aTo = a.valid_to;
  const bFrom = b.valid_from;
  const bTo = b.valid_to;

  // 任一方完全没有时间 → 兼容
  if (aFrom == null && aTo == null) return true;
  if (bFrom == null && bTo == null) return true;

  // 用「生年之差」做粗判：相差 20 年以上基本不是同一人。
  // 阈值取 20 年而不是 1 年，因为不同来源的生年本来就可能差几年
  // （纪年换算、虚岁实岁），而 20 年的差距不可能是同一个人。
  if (aFrom != null && bFrom != null) {
    const gapYears = Math.abs(aFrom - bFrom) / 365.25;
    if (gapYears > 20) return false;
  }
  if (aTo != null && bTo != null) {
    const gapYears = Math.abs(aTo - bTo) / 365.25;
    if (gapYears > 20) return false;
  }
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  const db = new DatabaseSync(DB);

  if (args.list) {
    const rows = db.prepare('SELECT * FROM entity_merges ORDER BY canonical_id').all();
    if (!rows.length) {
      console.log('当前没有任何归并。');
      return;
    }
    console.log(`共 ${rows.length} 条归并：\n`);
    for (const r of rows) {
      const c = db.prepare('SELECT name FROM entities WHERE id = ?').get(r.canonical_id);
      const m = db.prepare('SELECT name FROM entities WHERE id = ?').get(r.merged_id);
      console.log(`  ${r.canonical_id} (${c ? c.name : '?'})`);
      console.log(`    ← ${r.merged_id} (${m ? m.name : '?'})`);
      console.log(`    依据：${r.reason}`);
      console.log();
    }
    return;
  }

  if (args.unmerge) {
    const info = db.prepare('DELETE FROM entity_merges WHERE merged_id = ? OR canonical_id = ?')
      .run(args.unmerge, args.unmerge);
    console.log(`已撤销 ${info.changes} 条归并（${args.unmerge}）`);
    return;
  }

  // 候选：source 来源的实体，与「不是该来源」的同名实体配对
  // 实体 id 形如 `person:cbdb-3767` / `person:wikipedia-e898...`——
  // 类型前缀在**最前面**，来源在冒号之后。
  //
  // 早先写 `c.id NOT LIKE 'wikipedia:%'`，匹配的是「以 wikipedia: 开头」，
  // 而实际 id 以 `person:` 开头，于是条件永真但 JOIN 结果全被过滤，
  // 候选配对 0 条——看起来「没有可归并的」，实际是查询写错了。
  const candidates = db.prepare(`
    SELECT w.id AS wiki_id, w.name, w.valid_from AS wf, w.valid_to AS wt,
           c.id AS other_id, c.valid_from AS cf, c.valid_to AS ct
      FROM entities w
      JOIN entities c
        ON c.name = w.name
       AND c.type = w.type
       AND c.id NOT LIKE ?
     WHERE w.id LIKE ?
       AND w.type = 'person'
       AND w.id NOT IN (SELECT merged_id FROM entity_merges)
     ORDER BY w.name
  `).all(`person:${args.source}-%`, `person:${args.source}-%`);

  console.log(`候选配对：${candidates.length}\n`);

  const insert = db.prepare(
    'INSERT OR REPLACE INTO entity_merges (canonical_id, merged_id, reason, merged_at) VALUES (?, ?, ?, ?)',
  );
  const now = new Date().toISOString();

  let merged = 0;
  let rejected = 0;
  db.exec('BEGIN');
  for (const c of candidates) {
    // canonical 用「非该来源」的那个（CBDB 数据更完整，作主实体）
    const canonical = c.other_id;
    const mergedId = c.wiki_id;

    const ok = lifespanCompatible(
      { valid_from: c.cf, valid_to: c.ct },
      { valid_from: c.wf, valid_to: c.wt },
    );

    if (!ok) {
      rejected++;
      console.log(`  拒绝 ${c.name}：生卒年相差过大`);
      continue;
    }

    const reason = `同名「${c.name}」，生卒年不矛盾`;
    if (!args.dryRun) insert.run(canonical, mergedId, reason, now);
    merged++;
    console.log(`  归并 ${c.name}：${mergedId} → ${canonical}`);
  }
  db.exec('COMMIT');

  console.log(`\n归并 ${merged} 条，拒绝 ${rejected} 条`);
  if (args.dryRun) {
    console.log('[dry-run] 未写盘');
    return;
  }

  // 同时落一份 JSON。
  //
  // 数据库每次 build 都重建，entity_merges 表会被清空。归并是**人工
  // 判断的结果**，不该随重建丢失。JSON 是权威来源，build_db 时读入。
  const all = db.prepare('SELECT canonical_id, merged_id, reason, merged_at FROM entity_merges ORDER BY merged_id').all();
  const outFile = path.join(ROOT, 'data', 'merges.json');
  fs.writeFileSync(outFile, JSON.stringify({
    note: '跟来源实体归并。canonical_id 是主实体，merged_id 归到它名下。原始实体和边不删，查询时视为同一人。撤销：删掉对应条目后重建。',
    merges: all,
  }, null, 1) + '\n', 'utf8');
  console.log(`已写出 ${path.relative(ROOT, outFile)}（${all.length} 条）`);
}

main();
