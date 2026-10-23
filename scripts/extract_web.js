#!/usr/bin/env node
// 从 raw/web 抽取断言，输出待提交的 claims 文件。
//
// 本脚本**不写盘、不提交**。它只把抽取结果整理成 commit_cli 能吃的格式，
// 供人工过一遍再提交——抽取是候选，不是事实。
//
// 用法：
//   node scripts/extract_web.js --group PEOPLE [--out claims.json]
//   node scripts/extract_web.js --raw-id 'raw:web/people/xxx' --out one.json

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rawStore = require(path.join(ROOT, 'src', 'store', 'raw_store.js'));
const { projectRecord } = require(path.join(ROOT, 'src', 'store', 'quote_slice.js'));
const { extractResume } = require(path.join(ROOT, 'src', 'extractors', 'web_resume.js'));

function parseArgs(argv) {
  const out = { group: 'PEOPLE' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') out.group = argv[++i];
    else if (a === '--raw-id') out.rawId = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);

  const ids = args.rawId
    ? [args.rawId]
    : Array.from(rawStore.readGroup('web', args.group)).map((r) => r.rawId);

  if (!ids.length) {
    console.error('没有可抽取的 raw 记录（组 ' + args.group + '）');
    process.exitCode = 1;
    return;
  }

  const items = [];
  const allWarnings = [];

  for (const rawId of ids) {
    const rec = rawStore.getByRawId(rawId);
    if (!rec) {
      allWarnings.push({ rawId, code: 'raw-missing', message: '读不到 raw 记录' });
      continue;
    }
    const text = projectRecord(rec).text;
    const r = extractResume(text, { rawRef: rawId });

    if (!r.person) {
      allWarnings.push({ rawId, code: 'extract-failed', message: '无法识别姓名，整篇跳过' });
      continue;
    }

    // 实体
    items.push({
      kind: 'entity',
      id: r.person.id,
      type: 'person',
      name: r.person.name,
      props: {},
      provenance: {
        rawRef: rawId,
        span: r.person.span,
        reason: '人民网人物资料：' + (rec.payload.title || r.person.name),
      },
    });

    for (const e of r.entities) {
      items.push({
        kind: 'entity',
        id: e.id,
        type: e.type,
        name: e.name,
        props: e.props || {},
        provenance: { rawRef: rawId, span: e.span, reason: e.reason || '原文' },
      });
    }

    // 断言
    for (const c of r.claims) {
      items.push({
        kind: 'claim',
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        qualifiers: c.qualifiers,
        provenance: { rawRef: rawId, span: c.span, reason: c.reason },
      });
    }

    for (const w of r.warnings) allWarnings.push({ rawId, ...w });
    console.log(
      (r.person.name + '        ').slice(0, 6) +
      ' 实体 ' + (1 + r.entities.length) + ' | 断言 ' + r.claims.length +
      ' | WARN ' + r.warnings.length,
    );
  }

  // 去重：同一组织在多篇里出现会重复生成 entity 条目
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    if (it.kind === 'entity') {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
    }
    deduped.push(it);
  }

  console.log('\n合计: ' + deduped.length + ' 条（去重后）');
  if (allWarnings.length) {
    console.log('WARN ' + allWarnings.length + ' 条：');
    for (const w of allWarnings) console.log('  ' + w.code + ': ' + w.message);
  }

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(deduped, null, 1) + '\n');
    console.log('\n已写出 ' + args.out);
    console.log('预览：node scripts/commit_cli.js --file ' + args.out + ' --dry-run');
  } else {
    console.log('\n未指定 --out，仅预览。');
  }
}

main();
