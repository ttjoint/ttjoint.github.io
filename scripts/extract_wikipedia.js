#!/usr/bin/env node
// 从 raw/wikipedia 抽取断言，输出 claims 文件（供 commit_cli 提交）。
//
// 与 extract_web.js 同样的契约：**不写盘、不提交**，只产出候选。
//
// 用法：
//   node scripts/extract_wikipedia.js --out /tmp/wiki_claims.json
//   node scripts/extract_wikipedia.js --raw-id 'raw:wikipedia/xxx' --out one.json

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rawStore = require(path.join(ROOT, 'src', 'store', 'raw_store.js'));
const { extractWikipediaSummary } = require(path.join(ROOT, 'src', 'extractors', 'wikipedia_summary.js'));

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--raw-id') out.rawId = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const records = Array.from(rawStore.readGroup('wikipedia', 'SUMMARY'));

  const ids = args.rawId ? [args.rawId] : records.map((r) => r.rawId);
  if (!ids.length) {
    console.error('没有可抽取的 raw 记录');
    process.exitCode = 1;
    return;
  }

  const byId = new Map(records.map((r) => [r.rawId, r]));
  const items = [];
  let ok = 0;
  let fail = 0;
  const warnCount = {};

  for (const id of ids) {
    const rec = byId.get(id);
    if (!rec) {
      console.error(`找不到 ${id}`);
      continue;
    }
    const out = extractWikipediaSummary(rec.payload.text, { rawRef: id, title: rec.payload.title });
    if (!out.person) {
      fail++;
      for (const w of out.warnings) {
        warnCount[w.code] = (warnCount[w.code] || 0) + 1;
        console.log(`  ${w.code}: ${w.message}`);
      }
      continue;
    }
    ok++;
    for (const w of out.warnings) {
      warnCount[w.code] = (warnCount[w.code] || 0) + 1;
      console.log(`  ${w.code}: ${w.message}`);
    }

    // 实体
    for (const e of out.entities) {
      items.push({
        kind: 'entity',
        id: e.id,
        type: e.type,
        name: e.name,
        props: e.props || {},
        provenance: {
          rawRef: id,
          // 每个实体都要有自己的 span（可指回原文）。
          // 之前 thing 实体给 null，被 commit 校验拒——没有出处的实体不该进库。
          span: e.span || (e.type === 'person' ? out.person.span : null),
          reason: `维基百科：${rec.payload.title}`,
        },
      });
    }

    // 断言
    for (const c of out.claims) {
      items.push({
        kind: 'claim',
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        // 精度随断言带走：1037-01-08 与 1037 不是同一断言。
        // 丢掉精度会让下游把「更精确」误判成「冲突」。
        precision: c.precision || null,
        jdn: c.jdn || null,
        jdnEnd: c.jdnEnd || null,
        provenance: {
          rawRef: id,
          span: c.span,
          reason: c.reason,
        },
      });
    }
  }

  console.log(`\n条目 ${ids.length}，抽取成功 ${ok}，失败 ${fail}`);
  console.log('警告分布：' + JSON.stringify(warnCount));

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(items, null, 1), 'utf8');
    console.log(`已写出 ${args.out}（${items.length} 条）`);
  } else {
    console.log(`（未指定 --out，共 ${items.length} 条未落盘）`);
  }
}

main();
