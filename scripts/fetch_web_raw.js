#!/usr/bin/env node
// 网页信源抓取 → 落 raw（第 0 层）。
//
// ## 为什么先落 raw，而不是直接抽实体
//
// 抽取算法会变，网页会消失。若第一次抽取时只留下「结构化结果」，
// 后来发现漏抽了一个字段，就只能重新抓——而那时页面可能已经改版或下线。
//
// 所以顺序必须是：
//
//   1. 抓 HTML
//   2. 清洗成纯文本
//   3. 落 raw（payload.text = 清洗后正文，payload.html = 原始 HTML）
//   4. **之后**才基于 raw 抽取
//
// 第 3 步是关键：raw 是不可变的第 0 层，之后所有抽取都能重跑，
// 且每条断言都能指回「当时看到的那段文字」。
//
// ## 为什么保留 HTML
//
// 清洗规则也会变（比如某天发现导航栏没去干净）。保留原始 HTML
// 意味着清洗可以重做，不必重新抓。代价是体积大 10–30 倍。
//
// ## 异构问题
//
// 不同站点的正文容器不同（人民网用 `.text_con`，政协网可能是别的）。
// 本脚本用「候选选择器列表 + 兜底全文」的方式：先试已知容器，
// 都不中就用清洗后的全文并标记 `extraction: 'fallback'`。
// 兜底的结果质量差，但**不丢数据**——之后能重跑。
//
// 用法：
//   node scripts/fetch_web_raw.js --url <url> [--name 标题] [--site people]
//   node scripts/fetch_web_raw.js --from-manifest data/imports/cpc/xxx/manifest.json --pick 蒋作君,何报翔
//   node scripts/fetch_web_raw.js --from-manifest ... --limit 3 --dry-run

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { fetchText, cleanHtml } = require(path.join(ROOT, 'src', 'net', 'http.js'));
const rawStore = require(path.join(ROOT, 'src', 'store', 'raw_store.js'));

/** 抓取间隔，避免给对方站点造成压力。 */
const DELAY_MS = 1200;

/**
 * 正文容器候选选择器。
 *
 * 按「最可能命中」排序。命中第一个就用它。
 * 人民网的 `text_con` 实测有效（去掉导航、页脚、推荐阅读）。
 */
const CONTENT_SELECTORS = [
  /<div[^>]*class="[^"]*\btext_con\b[^"]*"[^>]*>/i,
  /<div[^>]*class="[^"]*\barticle-content\b[^"]*"[^>]*>/i,
  /<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>/i,
  /<div[^>]*id="[^"]*\bcontent\b[^"]*"[^>]*>/i,
  /<article[^>]*>/i,
];

/**
 * 从 HTML 提取正文。
 *
 * 命中已知容器时，从容器起点往后取一块（取到下一个大结构或长度上限）。
 * 简单粗暴但有效——真正的容器嵌套解析需要 DOM 库，而本项目零依赖。
 *
 * @returns {{text:string, extraction:'selector'|'fallback', selector?:string}}
 */
function extractBody(html) {
  for (const sel of CONTENT_SELECTORS) {
    const m = html.match(sel);
    if (!m) continue;
    const start = m.index;
    // 取 30KB 或到页面结束。正文一般 2–8KB，30KB 足够覆盖。
    const chunk = html.slice(start, start + 30000);
    let text = cleanHtml(chunk, { collapse: false });

    // 人民网类页面在正文末尾有「(责编：xxx)」标记，之后是侧栏/推荐阅读。
    // 从该标记处截断，比靠容器嵌套解析可靠——不需要 DOM 库。
    const editorMark = text.search(/\(?责编[：:]/);
    if (editorMark > 0) text = text.slice(0, editorMark);

    // 太短的说明匹配到的是空容器或误匹配，继续试下一个
    if (text.length >= 80) {
      return { text: text.trim(), extraction: 'selector', selector: String(sel) };
    }
  }
  // 兜底：清洗全文。质量差（含导航页脚），但不丢数据。
  return { text: cleanHtml(html, { collapse: false }), extraction: 'fallback' };
}

/**
 * 从页面取标题。
 */
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return cleanHtml(m[1]).replace(/\s*[-_|].*$/, '').trim();
}

/**
 * 生成稳定的 rawId。
 *
 * 用 URL 的哈希而不是序号：同一 URL 重复抓取应落到同一 rawId，
 * 这样 `rawStore.append` 能按 rawId 去重（它已经这么做了）。
 */
function rawIdFor(url, site) {
  const h = crypto.createHash('sha1').update(url, 'utf8').digest('hex').slice(0, 12);
  return `raw:web/${site}/${h}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOne(url, site, extra = {}) {
  const res = await fetchText(url, { timeout: 30000 });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = extractBody(res.body);
  const title = extractTitle(res.body);

  const capturedAt = new Date().toISOString();
  return {
    rawId: rawIdFor(url, site),
    kind: 'document',
    source: 'web',
    sourceTable: site.toUpperCase(),
    sourceKey: url,
    capturedAt,
    payload: {
      // `text` 是**可截取引文**的正文——quote 从这里按 span 截。
      // 必须是清洗后的纯文本，不能是 HTML。
      text: body.text,
      url,
      finalUrl: res.finalUrl,
      title: extra.name || title,
      site,
      // 抽取方式：selector = 命中已知容器，fallback = 全文兜底（质量差，需复核）
      extraction: body.extraction,
      ...(body.selector ? { selector: body.selector } : {}),
      // 原始 HTML 保留：清洗规则变了可以重做，不必重新抓。
      // 体积大，但这是「不可更易的本地信源」的代价。
      html: res.body,
      fetchedAt: capturedAt,
    },
  };
}

function parseArgs(argv) {
  const out = { limit: 0, dryRun: false, site: 'people' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--site') out.site = argv[++i];
    else if (a === '--from-manifest') out.manifest = argv[++i];
    else if (a === '--pick') out.pick = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  /** @type {Array<{url:string,name?:string}>} */
  let targets = [];

  if (args.url) {
    targets = [{ url: args.url, name: args.name }];
  } else if (args.manifest) {
    const m = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    const links = m.links || [];
    targets = args.pick
      ? links.filter((l) => args.pick.some((p) => l.name.includes(p)))
      : links;
  }

  if (args.limit) targets = targets.slice(0, args.limit);
  if (!targets.length) {
    console.error('没有目标 URL。用 --url 或 --from-manifest。');
    process.exitCode = 1;
    return;
  }

  console.log(`准备抓取 ${targets.length} 个页面（间隔 ${DELAY_MS}ms）`);

  const records = [];
  for (const t of targets) {
    try {
      const rec = await fetchOne(t.url, args.site, { name: t.name });
      const len = rec.payload.text.length;
      console.log(`  OK  ${rec.rawId}  ${len} 字  [${rec.payload.extraction}]  ${t.name || rec.payload.title}`);
      records.push(rec);
      await sleep(DELAY_MS);
    } catch (e) {
      console.log(`  跳过 ${t.url}: ${e.message}`);
    }
  }

  if (!records.length) {
    console.log('\n没有成功抓取的页面。');
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] 未写盘。将写入 ${records.length} 条 raw 记录。`);
    const r = records[0];
    console.log(`样本 ${r.rawId}：`);
    console.log(`  text ${r.payload.text.length} 字, html ${r.payload.html.length} 字`);
    console.log('  正文前 200 字：');
    console.log('  ' + r.payload.text.slice(0, 200).replace(/\n/g, '\n  '));
    return;
  }

  const res = rawStore.append('web', args.site.toUpperCase(), records, { at: new Date().toISOString() });
  console.log(`\n已写入 ${res.count} 条 raw 记录 → raw/web/${args.site.toUpperCase()}/`);
  console.log(`（跳过 ${res.skipped} 条已存在的）`);
  console.log('\n下一步：基于 raw 抽取断言');
  console.log('  node scripts/commit_cli.js --show-text <rawId>');
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
