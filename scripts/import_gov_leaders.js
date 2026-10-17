#!/usr/bin/env node
/**
 * Import State Council (国务院) leadership profiles from gov.cn.
 *
 * The 组织机构 page lists the leadership roster; each name links to a
 *   /guoqing/YYYY-MM/DD/content_XXXXXXX.htm
 * resume page whose body follows the pattern:
 *   "<name>，<性别>，<民族>，<birth>生，<native>人，<work start>参加工作，...
 *    现任 <positions>。"
 *
 * Output: data/imports/official/gov-leaders-<timestamp>.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'imports', 'official');
const INDEX_URL = 'https://www.gov.cn/gwyzzjg/index.htm';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(Error('too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: HEADERS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error('HTTP ' + res.statusCode + ' for ' + url));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', reject);
  });
}

const clean = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&emsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const stableId = name => 'person:' + crypto.createHash('sha256').update('gov\0' + name).digest('hex').slice(0, 20);

// Leadership roster: anchors whose target is a 人物资料 resume page and whose
// text is a bare Chinese name (2-6 chars, no punctuation).
function findResumeLinks(html) {
  const anchors = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g)];
  const out = new Map();
  for (const [, href, inner] of anchors) {
    const text = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;|&emsp;|\s+/g, '').trim();
    if (!/^[\u4e00-\u9fff·]{2,8}$/.test(text)) continue;
    if (!/\/guoqing\/\d{4}-\d{2}\/\d{2}\/content_\d+\.htm/.test(href)) continue;
    const abs = new URL(href, INDEX_URL).href;
    if (!out.has(abs)) out.set(abs, text.replace(/[（(].*$/, ''));
  }
  return [...out.entries()].map(([url, name]) => ({ url, name }));
}

function parseResume(html, name, url) {
  const text = clean(html);
  // Body begins at "<name>，<gender>"
  const anchor = text.search(new RegExp(name + '\\s*[，,]\\s*(?:男|女)'));
  if (anchor < 0) return null;
  let body = text.slice(anchor);
  const stop = body.search(/【我要纠错】|扫一扫在手机|责任编辑|相关稿件/);
  if (stop > 40) body = body.slice(0, stop);
  body = body.trim();

  const gender = (body.match(/[，,]\s*(男|女)\s*[，,]/) || [])[1] || '';
  const ethnicity = (body.match(/[，,]\s*([\u4e00-\u9fff]{1,4}族)\s*[，,]/) || [])[1] || '';
  const birth = body.match(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?生/);
  const native = body.match(/[，,]\s*([\u4e00-\u9fff]{2,10}(?:省|市|县|区)?[\u4e00-\u9fff]{0,6})人\s*[，,]/);
  const workStart = body.match(/(\d{4}年\d{1,2}月)参加工作/);
  const joined = body.match(/(\d{4}年\d{1,2}月)加入中国共产党/);
  const edu = (body.match(/([\u4e00-\u9fff]{2,20}(?:大学|学院|党校)[\u4e00-\u9fff]{0,20}(?:专业)?(?:毕业)?[，,]?\s*[\u4e00-\u9fff]{0,12}学历)/) || [])[1] || '';
  const current = (body.match(/现任([^。]{4,300})。/) || [])[1] || '';
  const positions = current
    ? current.split(/[，,、]/).map(s => s.trim()).filter(Boolean)
    : [];

  return {
    id: stableId(name),
    name,
    gender,
    ethnicity,
    birthDate: birth ? `${birth[1]}年${birth[2]}月` : '',
    nativePlace: native ? native[1] : '',
    education: edu,
    workStart: workStart ? workStart[1] : '',
    partyJoin: joined ? joined[1] : '',
    positions,
    resume: body,
    sourceUrl: url,
  };
}

(async () => {
  const indexHtml = await get(INDEX_URL);
  const links = findResumeLinks(indexHtml);
  if (!links.length) throw Error('no leadership resume links found on ' + INDEX_URL);
  console.log(`roster: ${links.length} leaders`);

  const people = [];
  for (const { url, name } of links) {
    const html = await get(url);
    const p = parseResume(html, name, url);
    if (!p) { console.warn(`  skip ${name}: resume body not found`); continue; }
    if (!p.gender || !p.birthDate) { console.warn(`  skip ${name}: missing gender/birth`); continue; }
    people.push(p);
    console.log(` - ${p.name} | ${p.gender} | ${p.ethnicity || '-'} | ${p.birthDate} | ${p.nativePlace || '-'} | ${p.positions.length} positions`);
  }
  if (!people.length) throw Error('extracted 0 leaders; refusing to write an empty batch');

  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `gov-leaders-${stamp}.json`;
  fs.writeFileSync(path.join(OUT, file), JSON.stringify({
    source: '中国政府网·国务院',
    sourceUrl: INDEX_URL,
    fetchedAt: new Date().toISOString(),
    count: people.length,
    records: people,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'gov-leaders-latest.json'), JSON.stringify({ file, count: people.length }, null, 2) + '\n');
  console.log(`wrote ${people.length} leaders -> ${file}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
