#!/usr/bin/env node
/**
 * 抓取人民网“中国共产党历届中央领导集体”专题的人物资料。
 * 仅在离线导入时运行，不在浏览器端直接抓取（避免 CORS、不可复现和源站压力）。
 * 用法：node scripts/import_cpc.js [--dry-run] [--limit=20]
 * 注意：抓取结果必须人工复核；source 保存原文 URL、抓取时间和原始摘要。
 */
const fs = require('fs');
const path = require('path');
const { readAll, upsertAll } = require('../src/store/entity_writer');
const { entityId } = require('../src/store/entity_id');
const { cleanHtml, extractLinks } = require('../src/net/http');

const ROOT = path.join(__dirname, '..');
const INDEX = 'https://cpc.people.com.cn/GB/64162/394696/index.html';
const BATCH_DIR = path.join(ROOT, 'data', 'imports', 'cpc', new Date().toISOString().replace(/[:.]/g, '-'));

/** People.cn politely rate-limited: one request per 250ms. */
const REQUEST_DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Decode a response body, honouring the GB2312/GBK label these pages declare.
 *
 * People's Daily serves GBK and mangles badly if decoded as UTF-8; the charset
 * appears in a `<meta>` tag, or failing that in the Content-Type header.
 */
function decodeBuffer(buf, contentType) {
  let label = '';
  const m = /charset=["']?([\w-]+)/i.exec(buf.slice(0, 2000).toString('latin1'));
  if (m) label = m[1].toLowerCase();
  else if (contentType && /charset=([\w-]+)/i.test(contentType)) label = RegExp.$1.toLowerCase();

  if (/gb2312|gbk|gb18030/.test(label)) return new TextDecoder('gbk').decode(buf);
  return buf.toString('utf8');
}

/**
 * Person id derived from a 人民网 article URL.
 *
 * Paths look like `/n1/2022/1023/c448511-32550074.html`. The pair
 * `(448511, 32550074)` is the column id and the article id — stable, unique, and
 * owned by the publisher, which is exactly what an opaque entity key needs.
 *
 * A URL that does not match falls back to a hash of the URL itself: still
 * name-independent, still stable.
 */
function personIdFromUrl(url) {
  const m = String(url).match(/c(\d+)-(\d+)\.html/);
  if (m) return entityId('person', `cpc-${m[1]}-${m[2]}`);
  const digest = require('crypto').createHash('sha256').update(String(url)).digest('hex');
  return entityId('person', `cpc-url-${digest.slice(0, 16)}`);
}

/**
 * Fetch a page and decode it.
 *
 * Not using src/net/http.js here because that helper assumes UTF-8 internally;
 * People.cn needs GBK detection on the raw bytes before any decoding.
 */
function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        resolve(decodeBuffer(Buffer.concat(chunks), res.headers['content-type']));
      });
    }).on('error', reject);
  });
}

/** Person links on the index page. */
function personLinks(html) {
  return extractLinks(html, INDEX)
    .filter((l) => /cpc\.people\.com\.cn/.test(l.url) && /n1\//.test(l.url))
    .map((l) => ({ name: l.text, url: l.url }));
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((x) => x.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 999;

  const indexHtml = await get(INDEX);
  const people = personLinks(indexHtml).slice(0, limit);
  const now = new Date().toISOString();

  const records = [];
  for (const person of people) {
    try {
      const html = await get(person.url);
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      const body = cleanHtml(html).slice(0, 1800);

      records.push({
        // Id comes from the article URL, not the name: the same person can
        // appear in two 人民网 columns, and a rename must not mint a new entity.
        id: personIdFromUrl(person.url),
        name: person.name,
        type: 'person',
        props: {
          简介: body,
          来源栏目: '人民网：中国共产党历届中央领导集体',
        },
        aliases: [],
        relations: {},
        sources: [{
          id: 'cpc-' + Buffer.from(person.url).toString('base64url'),
          name: '人民网人物资料',
          url: person.url,
          accessedAt: now,
          note: '离线抓取摘要，需人工核验',
        }],
        external: { cpcUrl: person.url, title: cleanHtml(title || '') },
      });

      await sleep(REQUEST_DELAY_MS);
    } catch (e) {
      console.error('跳过', person.url, e.message);
    }
  }

  const stats = upsertAll('person', records);
  const manifest = {
    source: INDEX,
    fetchedAt: now,
    parserVersion: '1.1.0',
    discovered: people.length,
    imported: records.length,
    links: people,
    records: records.map((x) => ({ id: x.id, url: x.external.cpcUrl })),
  };

  console.log(`发现 ${people.length} 个链接，得到 ${records.length} 条人物记录；新增 ${stats.added}，更新 ${stats.updated}，合并后 ${stats.total} 条`);

  if (!args.includes('--dry-run')) {
    fs.mkdirSync(BATCH_DIR, { recursive: true });
    fs.writeFileSync(path.join(BATCH_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('实体分片已写入。请运行 npm run build:index 重建索引。');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
