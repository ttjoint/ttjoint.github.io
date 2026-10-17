#!/usr/bin/env node
/**
 * Import Supreme People's Procuratorate (最高人民检察院) leadership profiles.
 *
 * Source page (机构设置) embeds every leader as: <name> <resume sentence>.
 * The resume always follows the pattern "<name>，<性别>，<民族>，<birth>生，...".
 * We split on that pattern so no arbitrary text-length truncation is involved.
 *
 * Output: data/imports/official/spp-leaders-<timestamp>.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'imports', 'official');
const URLS = [
  'https://www.spp.gov.cn/spp/jgsz/index.shtml',
];

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(Error('too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error('HTTP ' + res.statusCode));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    }).on('error', reject);
  });
}

const clean = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const stableId = name => 'person:' + crypto.createHash('sha256').update('spp\0' + name).digest('hex').slice(0, 20);

// The resume body always opens with "<name>，<gender>，<ethnicity>，...".
const RESUME_RE = /([\u4e00-\u9fff·]{2,12})\s*，\s*(男|女)\s*，\s*([\u4e00-\u9fff]{1,4}族)?\s*，?\s*(\d{4})年(\d{1,2})月/g;

function extract(html, sourceUrl) {
  const text = clean(html);
  const start = text.indexOf('最高人民检察院领导');
  if (start < 0) throw Error('leadership section not found');
  const endMark = text.search(/最高人民检察院\s*简介/);
  const section = text.slice(start, endMark > start ? endMark : undefined);

  const matches = [...section.matchAll(RESUME_RE)];
  const people = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const name = m[1].replace(/\s+/g, '');
    const bodyStart = m.index;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : section.length;
    let body = section.slice(bodyStart, bodyEnd);
    // Drop trailing UI artefacts that follow the resume sentence.
    const stop = body.search(/重要活动|相关链接|Copyrights?©/);
    if (stop > 0) body = body.slice(0, stop);
    body = body.trim();
    if (body.length < 20) continue;

    const gender = m[2];
    const ethnicity = (m[3] || '').trim();
    const birthDate = m[4] + '年' + m[5] + '月';
    // Current positions: usually the clause after 现任. Some resumes omit 现任 and
    // list the posts directly after the education/party clause, so fall back to that.
    let posText = (body.match(/现任([^。]{5,200})。/) || [])[1] || '';
    if (!posText) {
      // e.g. "...，民革成员，最高人民检察院副检察长、检察委员会委员，二级大检察官。"
      const m2 = body.match(/[^，。]{0,10}(?:成员|中共党员)\s*[，,]([^。]{6,200})。/);
      if (m2) posText = m2[1];
    }
    const positions = posText
      ? posText.split(/[、，,]/).map(s => s.trim()).filter(Boolean)
      : [];
    const edu = (body.match(/([\u4e00-\u9fff]{2,20}学历[^，。；]{0,20})/) || [])[1] || '';
    const degree = (body.match(/([\u4e00-\u9fff]{2,12}学位)/) || [])[1] || '';

    people.push({
      id: stableId(name),
      name,
      gender,
      ethnicity,
      birthDate,
      education: [edu, degree].filter(Boolean).join('，'),
      positions,
      resume: body,
      sourceUrl,
    });
  }
  return people;
}

(async () => {
  const results = [];
  for (const url of URLS) {
    const html = await get(url);
    const people = extract(html, url);
    console.log(`${url} -> ${people.length} leaders`);
    results.push({ url, fetchedAt: new Date().toISOString(), people });
  }
  const all = results.flatMap(r => r.people);
  if (!all.length) throw Error('no leaders extracted; refusing to write an empty batch');

  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `spp-leaders-${stamp}.json`;
  fs.writeFileSync(path.join(OUT, file), JSON.stringify({
    source: '最高人民检察院',
    sourceUrl: URLS[0],
    fetchedAt: new Date().toISOString(),
    count: all.length,
    records: all,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'spp-latest.json'), JSON.stringify({ file, count: all.length }, null, 2) + '\n');
  console.log(`wrote ${all.length} leaders -> ${file}`);
  for (const p of all) console.log(` - ${p.name} | ${p.gender} | ${p.ethnicity || '-'} | ${p.birthDate} | ${p.positions.length} positions`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
