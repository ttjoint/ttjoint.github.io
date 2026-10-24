#!/usr/bin/env node
// 为 raw/web 记录补齐 evidence 节点。
//
// ## 为什么需要这个
//
// 抓取脚本只落 raw（第 0 层），不建 evidence 节点。而 build_db 要求
// 每条 provenance 的 rawRef 都能映射到一个 evidence——映射来源是
// evidence 节点的 `note` 字段（`rawRef: <rawId>`）。
//
// 缺 evidence 时 build 会硬失败：
//
//   Error: person:xxx: provenance[0] rawRef raw:web/people/xxx
//          matches no evidence
//
// 这是**正确的失败**：一条断言必须能指向「哪份文档说的」。没有 evidence
// 节点就意味着「这个说法没有出处」，那不该进库。
//
// 早先 6 个 evidence 是手工建的。批量抓取后必须自动生成。
//
// ## 为什么一条 raw 一个 evidence，而不是按站点合并
//
// 前缀映射适合「同一数据库的百万条记录」（CBDB 就是这样）。
// 但网页是每篇独立的文档——用 `raw:web` 前缀会把所有文章归到同一个
// 证据节点，等于说「蒋作君的简历出自人民网（整个网站）」，
// 追不到具体文章。引用溯源的价值就在于能追到那一篇。
//
// 用法：
//   node scripts/build_web_evidence.js --group PEOPLE
//   node scripts/build_web_evidence.js --group PEOPLE --dry-run

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rawStore = require(path.join(ROOT, 'src', 'store', 'raw_store.js'));

const OUT_DIR = path.join(ROOT, 'data', 'evidence', 'entities');

function parseArgs(argv) {
  const out = { source: 'web', group: 'PEOPLE', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--group') out.group = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

/** 从 raw 记录生成 evidence 节点。 */
function makeEvidence(rec, source) {
  const rawId = rec.rawId;
  // evidence id 用 rawId 的后缀：两者一一对应，一眼能看出关系。
  // `raw:web/people/b3dbd7a5e23a` → `evidence:web-b3dbd7a5e23a`
  const hash = String(rawId).split('/').pop();
  const id = `evidence:${source}-${hash}`;
  const payload = rec.payload || {};
  const url = payload.url || rec.url || null;
  const title = payload.title || (payload.text || '').split('\n')[0] || '';

  return {
    id,
    type: 'evidence',
    // 名字带标题和 URL：证据列表页上一眼能看出这是哪篇文章。
    name: title ? `${title} · ${url || ''}`.replace(/ · $/, '') : (url || rawId),
    medium: source === 'wikipedia' ? 'encyclopedia' : 'web',
    carrier: null,
    url,
    accessedAt: payload.fetchedAt || rec.fetchedAt || null,
    // excerpt 存正文开头：引用气泡里要能让人看到「原文这段」，
    // 不只是一句「出自某网页」。截 300 字，够看出上下文。
    excerpt: (payload.text || '').slice(0, 300),
    reliability: null,
    // build_db 靠这一行建立 rawRef → evidence 的映射。
    // 格式必须是 `rawRef: <rawId>`，别改。
    note: `rawRef: ${rawId}`,
    unresolved: false,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const records = Array.from(rawStore.readGroup(args.source, args.group));
  if (!records.length) {
    console.error(`没有 raw 记录（${args.source}/${args.group}）`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let created = 0;
  let skipped = 0;
  for (const rec of records) {
    const ev = makeEvidence(rec, args.source);
    const file = path.join(OUT_DIR, encodeURIComponent(ev.id) + '.json');
    if (fs.existsSync(file)) {
      skipped++;
      continue;
    }
    if (!args.dryRun) {
      fs.writeFileSync(file, JSON.stringify(ev, null, 1) + '\n', 'utf8');
    }
    created++;
  }

  console.log(`${args.source}/${args.group}: raw 记录 ${records.length} 条`);
  console.log(`新建 evidence ${created} 条，跳过已存在 ${skipped} 条`);
  if (args.dryRun) console.log('[dry-run] 未写盘');
  else console.log(`→ ${path.relative(ROOT, OUT_DIR)}`);
}

main();
