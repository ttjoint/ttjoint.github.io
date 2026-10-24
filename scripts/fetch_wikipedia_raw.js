#!/usr/bin/env node
// 维基百科人物摘要抓取 → 落 raw（第 0 层）。
//
// ## 为什么选维基百科做第二个来源
//
// 要找真实的「同一人物、多个来源说法不同」，关键是来源必须**独立编纂**。
//
//   CBDB      哈佛编纂，据史书方志文集墓志，生年多为年粒度
//   维基百科   社区编纂，生卒年常精确到日，且会标注「一说」
//
// 两者独立，冲突就真实存在，而不是我们造出来的。实测第一例：
//
//   苏轼  CBDB 1036 ～ 1101      维基 1037年1月8日—1101年8月24日
//
// 这不是谁错了。北宋纪年跨公历年，「景祐三年十二月十九日」按公历已是
// 1037 年 1 月 8 日。CBDB 记年（1036），维基记日（1037-01-08）——
// 两个都对，粒度不同导致数值不同。这正是本项目要展示的那类分歧。
//
// ## 为什么只抓 summary 不抓全文
//
// summary 接口返回「首段」——人物条目的首段几乎必然包含生卒年、字号、
// 籍贯、身份。抓全文（几百 KB/篇）会引入大量无关文本，抽取难度陡增，
// 而收益主要是「更多同类断言」，边际价值低。
//
// 先抓 summary 验证冲突链路，需要更多字段时再换 action=parse 抓全文。
//
// ## 用法
//
//   node scripts/fetch_wikipedia_raw.js --names 蘇軾,王安石 --dry-run
//   node scripts/fetch_wikipedia_raw.js --from-db --limit 50
//   node scripts/fetch_wikipedia_raw.js --from-db --limit 50 --min-year 1000 --max-year 1300

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { fetchText } = require(path.join(ROOT, 'src', 'net', 'http.js'));
const rawStore = require(path.join(ROOT, 'src', 'store', 'raw_store.js'));

/** 抓取间隔。维基对匿名请求不友好，宁可慢。 */
const DELAY_MS = 4000;

// 用 MediaWiki action=query 而不是 REST /page/summary。
//
// 原因：REST summary 接口**忽略 variant 参数**——实测
// `/page/summary/苏轼?variant=zh-tw` 返回的 extract 仍是简体「苏轼」，
// 而 CBDB 是繁体「蘇軾」，26 人里 6 人匹配失败。
//
// action=query 的 extracts 支持 variant：`variant=zh-tw` 返回繁体正文
// 「蘇軾（1037年1月8日—1101年8月24日）」，与 CBDB 的 name 直接对上。
// 不自己写繁简转换表（几千字映射且必然不全）。
const API = 'https://zh.wikipedia.org/w/api.php';

function parseArgs(argv) {
  const out = { names: null, fromDb: false, limit: 30, dryRun: false, minYear: null, maxYear: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--names') out.names = argv[++i].split(',');
    else if (a === '--from-db') out.fromDb = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--min-year') out.minYear = Number(argv[++i]);
    else if (a === '--max-year') out.maxYear = Number(argv[++i]);
  }
  return out;
}

/**
 * 从库里挑候选人物。
 *
 * 名气代理用「别名数 + 有生卒年」：别名多的通常是被多次记载的人物，
 * 维基有条目的概率高。真正可靠的名气指标（文献引用数）现在没有。
 */
function pickFromDb(args) {
  const { DatabaseSync } = require('node:sqlite');
  const { jdnToYear } = require(path.join(ROOT, 'src', 'time', 'julian.js'));
  const db = new DatabaseSync(path.join(ROOT, 'local_data', 'humanmap.sqlite3'), { readOnly: true });

  const rows = db.prepare(`
    SELECT e.id, e.name, e.valid_from, e.valid_to,
           (SELECT COUNT(*) FROM aliases a WHERE a.entity_id = e.id) AS alias_count
      FROM entities e
     WHERE e.type = 'person'
       AND e.valid_from IS NOT NULL
       AND e.valid_to IS NOT NULL
       AND e.name NOT LIKE '%?%'
     ORDER BY alias_count DESC, e.id
     LIMIT 4000
  `).all();

  const out = [];
  for (const r of rows) {
    const from = jdnToYear(r.valid_from);
    const to = jdnToYear(r.valid_to);
    if (args.minYear != null && from < args.minYear) continue;
    if (args.maxYear != null && to > args.maxYear) continue;
    out.push({ name: r.name, entityId: r.id, cbdbFrom: from, cbdbTo: to });
    if (out.length >= args.limit) break;
  }
  return out;
}

/** 稳定的 rawId：同一人物重复抓取得到同一个 id（幂等）。 */
function makeRawId(name) {
  const h = crypto.createHash('sha256').update('wikipedia:' + name).digest('hex');
  // 必须是 `raw:<source>/<GROUP>/<key>` 三段。
  //
  // 早先写成 `raw:wikipedia/<key>` 两段，parseRawId 要求 parts.length >= 3，
  // 于是 exists() 永远返回 false——raw 层明明有这条记录，所有校验都说不存在，
  // commit 全部被拒。这种「数据在但看不见」的错误最难查，因为两边都不报错。
  return 'raw:wikipedia/SUMMARY/' + h.slice(0, 12);
}

async function fetchOne(name) {
  // 用 zh-tw 变体：CBDB 是繁体，维基默认可能返回简体。
  //
  // 不自己写繁简转换表——那是几千字的映射且必然不全。
  // 维基的多语言变体机制直接给出繁体原文，这才是正确做法。
  //
  // 后果：人名能与 CBDB 的 `entities.name` 直接对上，
  // 不必依赖别名表兜底（别名表覆盖不全，实测 26 人里 6 人匹配失败）。
  const params = new URLSearchParams({
    action: 'query',
    titles: name,
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    variant: 'zh-tw',
    redirects: '1',
    format: 'json',
  });
  const url = API + '?' + params.toString();
  const res = await fetchText(url, {
    timeout: 20000,
    headers: {
      // 维基要求带可识别的 UA，否则会被限流或拒绝。
      'User-Agent': 'HumanMap/1.0 (genealogy knowledge graph research)',
      Accept: 'application/json',
    },
  });

  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}`);
  }

  let j;
  try {
    j = JSON.parse(res.body);
  } catch {
    throw new Error('响应不是 JSON');
  }
  const pages = (j.query && j.query.pages) || {};
  const page = Object.values(pages)[0];
  if (!page) throw new Error('无页面');
  if (page.missing !== undefined) throw new Error('页面不存在');
  if (!page.extract) throw new Error('无摘要正文');
  const extract = page.extract;
  // action=query 的 title 仍按简体返回，但 extract 是繁体——
  // 正文里第一个词才是我们要的人名。
  const titleInText = extract.split(/[（(]/)[0].trim();

  const rawId = makeRawId(name);
  return {
    rawId,
    source: 'wikipedia',
    group: 'SUMMARY',
    fetchedAt: new Date().toISOString(),
    payload: {
      // 与 web 抓取保持同样的形状（text/html/url/title），
      // 让下游抽取器不必区分来源类型。
      text: extract,
      html: '',
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
      // title 用正文里的人名（繁体），不是 API 返回的 page.title（简体）。
      // 名字要和正文一致，否则「苏轼（1037年...）」配 title「苏轼」
      // 而 CBDB 是「蘇軾」，又要走别名兜底。
      title: titleInText || page.title,
      description: null,
      // 查询用的名字（可能是简体）
      queriedName: name,
      // 保留原 JSON：之后可能要取更多字段
      apiPayload: j,
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);

  let targets;
  if (args.names) {
    targets = args.names.map((n) => ({ name: n.trim() }));
  } else if (args.fromDb) {
    targets = pickFromDb(args);
  } else {
    console.error('需要 --names 或 --from-db');
    process.exitCode = 1;
    return;
  }

  if (!targets.length) {
    console.error('没有候选');
    process.exitCode = 1;
    return;
  }

  console.log(`准备抓取 ${targets.length} 个维基条目（间隔 ${DELAY_MS}ms）`);
  const records = [];
  let fail = 0;
  let consecutive429 = 0;
  for (const t of targets) {
    // 幂等：已抓过的跳过（rawId 由名字决定）。断点续跑靠这个——
    // 中断后重跑同一批，已成功的不再请求，只补失败的。
    if (rawStore.exists(makeRawId(t.name))) {
      continue;
    }
    try {
      const rec = await fetchOne(t.name);
      rec.payload.cbdbHint = t.cbdbFrom != null ? { from: t.cbdbFrom, to: t.cbdbTo, entityId: t.entityId } : null;
      records.push(rec);
      console.log(`  OK  ${rec.rawId}  ${rec.payload.text.length} 字  ${t.name} → ${rec.payload.title}`);
      consecutive429 = 0;
      await sleep(DELAY_MS);
    } catch (e) {
      fail++;
      const is429 = /429/.test(e.message);
      if (is429) {
        consecutive429++;
        // 连续被限流说明 IP 已进冷却期，继续打只会更糟。
        // 退避 60s × 连续次数，最多等 5 分钟；超过 5 次连续 429 就放弃本批。
        if (consecutive429 >= 5) {
          console.log(`  连续 ${consecutive429} 次 429，放弃本批（IP 疑似被限流，稍后再跑）`);
          break;
        }
        const wait = Math.min(60000 * consecutive429, 300000);
        console.log(`  ${t.name}: 429 限流，退避 ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      } else {
        console.log(`  跳过 ${t.name}: ${e.message}`);
        await sleep(DELAY_MS);
      }
    }
  }

  if (!records.length) {
    console.log('\n没有成功抓取的条目。');
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] 将写入 ${records.length} 条，失败 ${fail} 条`);
    console.log('样本正文：');
    console.log('  ' + records[0].payload.text.slice(0, 250));
    return;
  }

  const res = rawStore.append('wikipedia', 'SUMMARY', records, { at: new Date().toISOString() });
  console.log(`\n已写入 ${res.count} 条 → raw/wikipedia/SUMMARY/`);
  console.log(`（跳过 ${res.skipped} 条已存在的，失败 ${fail} 条）`);
  console.log('\n下一步：node scripts/extract_wikipedia.js');
}

main();
