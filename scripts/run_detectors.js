#!/usr/bin/env node
// 独立重算冲突标注。**不改 edges 一条数据。**
//
// ## 为什么独立成脚本
//
// 检测器是判断，判断会变。若判断写在 build_db 里：
//   - 开关一条规则要重建整个库（200 秒），实际等于没法开关
//   - 每条边只有一个 flag 列，多条规则命中时会互相覆盖
//
// 这个脚本只重算 `edge_flags` 表，几秒完成。edges 完全不动。
//
// ## 用法
//
//   node scripts/run_detectors.js                    # 全部默认开启的
//   node scripts/run_detectors.js --off multiple-values
//   node scripts/run_detectors.js --only parent-age-inverted
//   node scripts/run_detectors.js --list             # 看有哪些检测器
//   node scripts/run_detectors.js --dry-run          # 只算不写
//   node scripts/run_detectors.js --report           # 看当前标注统计

'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(ROOT, 'local_data', 'humanmap.sqlite3');

function parseArgs(argv) {
  const out = { off: [], only: null, dryRun: false, list: false, report: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--off') out.off.push(argv[++i]);
    else if (a === '--only') out.only = (out.only || []).concat(argv[++i].split(','));
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list') out.list = true;
    else if (a === '--report') out.report = true;
  }
  return out;
}

function loadContext(db) {
  const { PredicateRegistry } = require(path.join(ROOT, 'src', 'predicates', 'registry.js'));
  const registry = new PredicateRegistry();

  const literalPredicates = new Set();
  for (const def of registry.list()) {
    if (def.range === 'literal') literalPredicates.add(def.key);
  }

  const lifespan = new Map();
  for (const r of db.prepare('SELECT id, valid_from, valid_to FROM entities').all()) {
    lifespan.set(r.id, { validFrom: r.valid_from, validTo: r.valid_to });
  }

  const edges = db.prepare(
    'SELECT id, subject, predicate, object, valid_from, valid_to, qualifiers FROM edges',
  ).all().map((r) => ({
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    qualifiers: r.qualifiers,
  }));

  return { edges, lifespan, literalPredicates };
}

function main() {
  const args = parseArgs(process.argv);
  const { ALL, runDetectors } = require(path.join(ROOT, 'src', 'store', 'detectors', 'registry.js'));

  if (args.list) {
    console.log('可用的冲突检测器：\n');
    for (const d of ALL) {
      console.log(`  ${d.id}`);
      console.log(`    ${d.title}  [${d.severity}, 默认${d.defaultOn ? '开启' : '关闭'}]`);
      console.log(`    理由：${d.rationale.replace(/\s+/g, ' ')}`);
      console.log();
    }
    return;
  }

  const db = new DatabaseSync(DB);

  if (args.report) {
    const rows = db.prepare(
      `SELECT detector_id, severity, COUNT(*) c FROM edge_flags GROUP BY detector_id, severity ORDER BY c DESC`,
    ).all();
    if (!rows.length) {
      console.log('当前没有任何标注。跑一次：node scripts/run_detectors.js');
      return;
    }
    console.log('当前生效的标注：\n');
    const total = db.prepare('SELECT COUNT(DISTINCT edge_id) c FROM edge_flags').get().c;
    for (const r of rows) {
      const title = (require(path.join(ROOT, 'src', 'store', 'detectors', 'registry.js')).BY_ID.get(r.detector_id) || {}).title || '(已下线)';
      console.log(`  ${String(r.c).padStart(7)}  ${r.detector_id}  [${r.severity}]  ${title}`);
    }
    console.log(`\n涉及边数（去重）：${total}`);
    const multi = db.prepare(
      'SELECT COUNT(*) c FROM (SELECT edge_id FROM edge_flags GROUP BY edge_id HAVING COUNT(*) > 1)',
    ).get().c;
    console.log(`其中被多条检测器同时命中的边：${multi}`);
    return;
  }

  // 决定启用哪些
  let enabled;
  if (args.only) enabled = args.only;
  else enabled = ALL.filter((d) => d.defaultOn && !args.off.includes(d.id)).map((d) => d.id);

  console.log('启用：' + (enabled.join(', ') || '(无)'));
  if (args.off.length) console.log('关闭：' + args.off.join(', '));

  const ctx = loadContext(db);
  const { flags, byDetector } = runDetectors(ctx, enabled);

  console.log('\n检测结果：');
  for (const [id, info] of Object.entries(byDetector)) {
    const mark = info.ran ? String(info.count).padStart(7) : '   --  ';
    console.log(`  ${mark}  ${id}${info.ran ? '' : '  (未运行)'}`);
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] 共 ${flags.length} 条标注，未写盘。`);
    return;
  }

  // 全量替换：先清空，再写入。
  //
  // 用全量替换而不是增量：检测器规则变了之后，旧标注必须能被撤销。
  // 增量更新会留下「规则已经不这么判了，但旧标注还在」的脏数据。
  const insert = db.prepare(
    'INSERT OR REPLACE INTO edge_flags (edge_id, detector_id, severity, reason, detected_at) VALUES (?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();

  db.exec('BEGIN');
  // 只删本次运行的检测器的旧标注——关闭某条检测器时应清掉它的标注，
  // 但不该动其他检测器的结果。
  // 清掉的必须包括「本次显式关闭的」检测器。
  //
  // 早先只清 enabled 里的，于是 `--off foo` 之后 foo 的旧标注原样留在
  // 表里——报告显示它仍在生效，而实际上规则已经关了。
  // 「关掉一条规则」必须同时清掉它的历史标注，否则开关是假的。
  const del = db.prepare('DELETE FROM edge_flags WHERE detector_id = ?');
  for (const id of enabled) del.run(id);
  for (const id of args.off) del.run(id);
  for (const f of flags) {
    insert.run(f.edgeId, f.detectorId, f.severity, f.reason, now);
  }
  db.exec('COMMIT');

  const distinctEdges = new Set(flags.map((f) => f.edgeId)).size;
  console.log(`\n已写入 ${flags.length} 条标注，涉及 ${distinctEdges} 条边。`);
  console.log('edges 表未改动。查看：node scripts/run_detectors.js --report');
}

main();
