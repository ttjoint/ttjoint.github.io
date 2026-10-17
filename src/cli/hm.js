#!/usr/bin/env node
'use strict';
/**
 * Unified CLI for the HumanMap core library.
 *
 * Subcommands
 *   hm cbdb:stats                       inspect the CBDB database
 *   hm cbdb:extract --limit=N --out=F    extract a slice as an import batch
 *   hm graph:stats                       load data/ and print graph statistics
 *   hm graph:query <text>                free-text search over the graph
 *   hm graph:predicates                  list predicates with counts
 *   hm timeline [--bucket=100]           print a lifespan histogram
 *
 * Kept deliberately thin: all behaviour lives in src/, so tests can exercise it
 * without spawning processes.
 */
const fs = require('fs');
const path = require('path');
const { loadGraph } = require('../store/graph_source');
const { QueryEngine, ALL_CONFIDENCE } = require('../core/query');
const { formatRange } = require('../time/julian');

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v == null ? true : v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function openCbdb(file) {
  const initSqlJs = require('sql.js');
  return initSqlJs().then(SQL => new SQL.Database(fs.readFileSync(file)));
}

function cbdbPath(arg) {
  return arg || path.join(__dirname, '..', '..', 'cbdb_20260801', 'cbdb_20260801.sqlite3');
}

async function cmdCbdbStats(args) {
  const cbdb = require('../importers/cbdb');
  const db = await openCbdb(cbdbPath(args.file));
  const stats = {};
  for (const t of ['BIOG_MAIN', 'KIN_DATA', 'POSTED_TO_OFFICE_DATA', 'ASSOC_DATA', 'BIOG_ADDR_DATA', 'ALTNAME_DATA']) {
    if (!cbdb.hasTable(db, t)) { stats[t] = 0; continue; }
    stats[t] = db.exec(`SELECT COUNT(*) FROM "${t}"`)[0].values[0][0];
  }
  console.log('CBDB tables:', JSON.stringify(stats, null, 2));
  const dyn = cbdb.listDynasties(db).slice(0, 15);
  console.log('\nTop dynasties:');
  for (const d of dyn) console.log(`  ${d.dynasty}\t${d.name}\t${d.count}`);
}

async function cmdCbdbExtract(args) {
  const cbdb = require('../importers/cbdb');
  const db = await openCbdb(cbdbPath(args.file));
  const limit = args.limit ? parseInt(args.limit, 10) : 500;
  const where = args.where || '';
  const result = cbdb.extractPersons(db, { limit, where, withRelations: args.relations !== 'false' });

  console.log('extracted:', JSON.stringify(result.stats, null, 2));

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'CBDB',
      stats: result.stats,
      persons: result.persons,
      edges: result.edges,
    }, null, 2) + '\n');
    console.log('written:', outPath);
  }
}

function cmdGraphStats(args) {
  const g = loadGraph();
  const s = g.summary();
  console.log('nodes:', s.nodes, JSON.stringify(s.byType));
  console.log('edges:', s.edges, '| duplicate edges skipped:', s.skippedDuplicateEdges);
  console.log('predicates registered:', s.predicates);
  const top = Object.entries(s.byPredicate).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('\ntop predicates:');
  for (const [k, n] of top) console.log(`  ${k.padEnd(18)} ${n}`);
}

function cmdGraphQuery(args) {
  const text = args._.slice(1).join(' ');
  if (!text) { console.error('usage: hm graph:query <text>'); process.exit(1); }
  const g = loadGraph();
  const q = new QueryEngine(g);
  const hits = q.search({ text, limit: 25, confidence: ALL_CONFIDENCE });
  console.log(`matched ${hits.length}:`);
  for (const n of hits) {
    console.log(`  [${n.type}] ${n.name}  ${n.id}`);
    if (n.lifespan) console.log(`       ${formatRange(n.lifespan)}`);
  }
}

function cmdGraphPredicates() {
  const g = loadGraph();
  const q = new QueryEngine(g);
  for (const p of q.predicateCatalog()) {
    const flags = [p.negatable ? 'negatable' : null, p.subjectGender ? `gender:${p.subjectGender}` : null]
      .filter(Boolean).join(',');
    console.log(`${p.key.padEnd(18)} ${p.label.padEnd(8)} ${String(p.count).padStart(6)}  ${flags}`);
  }
}

function cmdTimeline(args) {
  const g = loadGraph();
  const q = new QueryEngine(g);
  const bucket = args.bucket ? parseInt(args.bucket, 10) : 100;
  const hist = q.timelineHistogram({ bucketYears: bucket, confidence: ALL_CONFIDENCE });
  console.log(`lifespan histogram (${bucket}-year buckets, ${hist.length} non-empty)`);
  for (const h of hist) {
    const bar = '#'.repeat(Math.min(60, Math.ceil(h.count / Math.max(1, hist.reduce((m, x) => Math.max(m, x.count), 1)) * 60)));
    console.log(`  ${String(h.year).padStart(6)}  ${String(h.count).padStart(6)} ${bar}`);
  }
}

const COMMANDS = {
  'cbdb:stats': cmdCbdbStats,
  'cbdb:extract': cmdCbdbExtract,
  'graph:stats': cmdGraphStats,
  'graph:query': cmdGraphQuery,
  'graph:predicates': cmdGraphPredicates,
  timeline: cmdTimeline,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error('HumanMap CLI\n\ncommands:\n' + Object.keys(COMMANDS).map(c => '  ' + c).join('\n'));
    process.exit(1);
  }
  await fn(args);
}

main().catch(err => {
  console.error('error:', err.message);
  process.exit(1);
});
