#!/usr/bin/env node
// 录入 CLI：从命令行提交实体与断言，走完整链路。
//
// ## 为什么先做 CLI 而不是界面
//
// 界面要处理「读原文 → 划取 → 预览 → 提交」的交互，而链路本身
// （校验 → 落 raw → 落分片 → 生成 commit → 重建）还没验证过。
// 先做 CLI 能用最小成本确认链路正确，界面只是同一批调用的包装。
//
// ## 与 POST /api/commit 的区别
//
// HTTP 端点**只校验不落盘**——写入是分钟级多进程的，不能挂在请求里。
// CLI 才是真正的写入入口。
//
// ## quote 不由使用者填写
//
// 使用者给 `span: {start, end}`，工具从 raw 记录里截。这样引文一定是
// 原文子串，编造在结构上不可能。若同时给了 `quote`，只用于比对
// （不一致就拒绝），不会被采用。
//
// 用法：
//   # 先看原文，找要划的区间
//   node scripts/commit_cli.js --show-text 'raw:cbdb/KIN_DATA/1|2|180'
//
//   # 提交一条断言
//   node scripts/commit_cli.js --claim '{
//     "subject":"person:cbdb-1","predicate":"maleChild","object":"person:cbdb-2",
//     "provenance":{"rawRef":"raw:cbdb/KIN_DATA/1|2|180","span":{"start":150,"end":155}}
//   }' --author tester --message "验证链路"
//
//   # 只看截取结果，不写盘
//   node scripts/commit_cli.js --claim '...' --dry-run
//
//   # 从文件读多条（可混合 entity 与 claim）
//   node scripts/commit_cli.js --file claims.json --author tester --message "批量"

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rawStore = require(path.join(ROOT, 'src', 'store', 'raw_store.js'));
const { validateBatch, buildCommit } = require(path.join(ROOT, 'src', 'store', 'commit_validation.js'));
const { projectRecord } = require(path.join(ROOT, 'src', 'store', 'quote_slice.js'));

const FOLDERS = {
  person: 'persons',
  organization: 'organizations',
  event: 'events',
  thing: 'things',
  evidence: 'evidence',
};

function parseArgs(argv) {
  const out = { dryRun: false, rebuild: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claim') out.claim = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--author') out.author = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--rebuild') out.rebuild = true;
    else if (a === '--show-text') out.showText = argv[++i];
  }
  return out;
}

/** 读取下一条 commit 序号。现有记录用 c-000001 起的零填充格式。 */
function nextCommitId() {
  const file = path.join(ROOT, 'data', 'commits', 'commits.jsonl');
  let max = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/"commitId"\s*:\s*"c-(\d+)"/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  // 数据库里已有 c-000001..c-000003，即使 jsonl 不存在也要接上
  return 'c-' + String(Math.max(max, 3) + 1).padStart(6, '0');
}

function isEntityItem(x) {
  return !!(x && x.type && x.name && !x.predicate);
}

/**
 * 落 raw（第 0 层，只追加）。
 *
 * 每条提交项写一条 `raw:commit/<commitId>/<n>`，payload 保存断言本身
 * 与它的 span。这样「谁在什么时候基于哪条原文加了这条断言」在第 0 层
 * 可查——而且它自己也是 raw 记录，同样不可变。
 */
function writeCommitRaw(commit, items) {
  const entities = [];
  const claims = [];

  items.forEach((c, i) => {
    const base = {
      refRaw: c.provenance.rawRef,
      span: c.provenance.span,
      quote: c.provenance.quote,
      formatVersion: c.provenance.formatVersion,
      fingerprint: c.provenance.fingerprint,
      reason: c.provenance.reason || null,
      commitId: commit.commitId,
      author: commit.author,
      message: commit.message,
    };
    const rec = {
      // rawId 必须是 `raw:<source>/<group>/<key>`，group 只能是一段路径。
      // 曾写成 `raw:commit/c-000004/2`——parseRawId 会把 c-000004 当成 group，
      // 于是记录写进了 `raw/commit/CLAIM/`，却按 `raw/commit/c-000004/` 去读，
      // 永远读不到。序号放进 key：`c-000004#2`。
      rawId: 'raw:commit/' + (isEntityItem(c) ? 'ENTITY' : 'CLAIM') + '/' + commit.commitId + '#' + i,
      kind: 'record',
      source: 'commit',
      sourceTable: isEntityItem(c) ? 'ENTITY' : 'CLAIM',
      sourceKey: commit.commitId + '#' + i,
      capturedAt: commit.at,
      payload: isEntityItem(c)
        ? Object.assign({}, base, { entityId: c.id, entityType: c.type, name: c.name, props: c.props })
        : Object.assign({}, base, { subject: c.subject, predicate: c.predicate, object: c.object }),
    };
    if (isEntityItem(c)) entities.push(rec);
    else claims.push(rec);
  });

  if (entities.length) rawStore.append('commit', 'ENTITY', entities, { at: commit.at });
  if (claims.length) rawStore.append('commit', 'CLAIM', claims, { at: commit.at });
  return { count: entities.length + claims.length, entities: entities.length, claims: claims.length };
}

/**
 * 把实体落到分片。
 *
 * 分片是派生层（第 1 层），但录入的实体若不等 build 就看不到，
 * CLI 就无法「提交后立刻验证」。这里直接写入，格式与 build_db 读取的一致。
 */
function writeEntityShard(e) {
  const folder = FOLDERS[e.type];
  if (!folder) return null;
  const dir = path.join(ROOT, 'data', folder, 'entities');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, encodeURIComponent(e.id) + '.json');

  let existing = {};
  if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8'));

  const merged = Object.assign({}, existing, {
    id: e.id,
    type: e.type,
    name: e.name,
    props: Object.assign({}, existing.props || {}, e.props || {}),
    aliases: existing.aliases || [],
    relations: existing.relations || {},
    external: existing.external || {},
    provenance: (existing.provenance || []).concat([{
      rawRef: e.provenance.rawRef,
      span: e.provenance.span,
      quote: e.provenance.quote,
      formatVersion: e.provenance.formatVersion,
      reason: e.provenance.reason,
    }]),
  });
  fs.writeFileSync(file, JSON.stringify(merged) + '\n');
  return path.relative(ROOT, file);
}

/** 把边断言落到分片（写进 subject 的 relations）。 */
function writeClaimShard(c) {
  const dir = path.join(ROOT, 'data', 'persons', 'entities');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, encodeURIComponent(c.subject) + '.json');
  if (!fs.existsSync(file)) return null;

  const e = JSON.parse(fs.readFileSync(file, 'utf8'));
  e.relations = e.relations || {};
  const bucket = e.relations[c.predicate] = e.relations[c.predicate] || [];
  const entry = {
    id: c.object,
    provenance: [{
      rawRef: c.provenance.rawRef,
      span: c.provenance.span,
      quote: c.provenance.quote,
      formatVersion: c.provenance.formatVersion,
      reason: c.provenance.reason,
    }],
  };
  const idx = bucket.findIndex((v) => (typeof v === 'string' ? v : v && v.id) === c.object);
  if (idx === -1) bucket.push(entry);
  else bucket[idx] = entry;
  fs.writeFileSync(file, JSON.stringify(e) + '\n');
  return path.relative(ROOT, file);
}

function main() {
  const args = parseArgs(process.argv);

  if (args.showText) {
    const rec = rawStore.getByRawId(args.showText);
    if (!rec) {
      console.error('找不到 raw 记录: ' + args.showText);
      process.exitCode = 1;
      return;
    }
    const proj = projectRecord(rec);
    console.log('=== ' + args.showText + ' (格式 v' + proj.version + ', ' + proj.text.length + ' 字符) ===');
    console.log(proj.text);
    return;
  }

  let items;
  try {
    if (args.file) items = JSON.parse(fs.readFileSync(args.file, 'utf8'));
    else if (args.claim) items = [JSON.parse(args.claim)];
    else items = [];
  } catch (e) {
    console.error('解析提交内容失败:', e.message);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(items)) items = items.items || items.claims || [];
  if (!items.length) {
    console.error('没有要提交的内容。用 --claim 或 --file 提供。');
    process.exitCode = 1;
    return;
  }

  const result = validateBatch(items, {
    rawExists: (ref) => rawStore.exists(ref),
    rawGet: (ref) => rawStore.getByRawId(ref),
  });

  // 逐条报告。通过的显示截出的引文——录入员要能确认截的是哪一句。
  for (const r of result.results) {
    if (r.ok) {
      const n = r.normalized;
      const p = n.provenance;
      const head = isEntityItem(n)
        ? n.id + ' 「' + n.name + '」'
        : n.subject + ' —' + n.predicate + '→ ' + n.object;
      console.log('[' + r.index + '] OK  ' + head);
      console.log('      span [' + p.span.start + ', ' + p.span.end + ') → 「' + p.quote + '」');
    } else {
      console.log('[' + r.index + '] 拒绝');
      for (const i of r.issues) console.log('      ' + i.field + '/' + i.code + ': ' + i.message);
    }
  }

  if (!result.ok) {
    console.log('\n' + result.failed + '/' + result.total + ' 条未通过，未写入任何内容。');
    process.exitCode = 1;
    return;
  }

  const commit = buildCommit(result.results.map((r) => r.normalized), {
    commitId: nextCommitId(),
    author: args.author || 'cli',
    message: args.message || '',
  });

  if (args.dryRun) {
    console.log('\n[dry-run] 校验通过，未写盘。将要写入的 commit:');
    console.log(JSON.stringify(commit, null, 2));
    return;
  }

  const normalized = result.results.map((r) => r.normalized);

  // 1) 落 raw（第 0 层，只追加）
  const written = writeCommitRaw(commit, normalized);

  // 2) 落分片（第 1 层，派生但需立即可见）
  const shards = [];
  for (const n of normalized) {
    const p = isEntityItem(n) ? writeEntityShard(n) : writeClaimShard(n);
    if (p) shards.push(p);
  }

  // 3) 追加 commit 记录
  const dir = path.join(ROOT, 'data', 'commits');
  fs.mkdirSync(dir, { recursive: true });
  const commitFile = path.join(dir, 'commits.jsonl');
  fs.appendFileSync(commitFile, JSON.stringify(commit) + '\n', 'utf8');

  console.log('\n已写入 commit ' + commit.commitId +
    '（' + written.entities + ' 实体 + ' + written.claims + ' 断言）');
  console.log('  raw 记录: ' + written.count + ' 条 → raw/commit/{ENTITY,CLAIM}');
  if (shards.length) console.log('  分片更新: ' + Array.from(new Set(shards)).join(', '));
  console.log('  commit  : ' + path.relative(ROOT, commitFile));

  if (args.rebuild) {
    console.log('\n下一步：npm run build:db && npm run build:index && npm run build:site');
  } else {
    console.log('\n要看到前端效果需重建：');
    console.log('  npm run build:db && npm run build:index && npm run build:site');
  }
}

main();
