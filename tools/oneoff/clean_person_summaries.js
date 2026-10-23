#!/usr/bin/env node
/**
 * Clean navigation/boilerplate out of props.简介 for every person in the database.
 *
 * People's Daily pages were imported as whole-page text, so many 简介 fields begin
 * with site navigation ("XX简历--中国共产党新闻网-... 通行证 ...") and end with
 * copyright/footer text. Merging duplicates could also pick the longer, dirtier copy.
 *
 * IMPORTANT: this must run against the admin database via the HTTP API. Editing the
 * exported shards directly is futile because `export_static.js` regenerates them
 * from SQLite, which would silently undo the cleanup.
 *
 * Usage:
 *   node scripts/clean_person_summaries.js           # dry run
 *   node scripts/clean_person_summaries.js --apply
 */
const http = require('http');

const ADMIN = process.env.HM_ADMIN_URL || 'http://127.0.0.1:8787';
const APPLY = process.argv.includes('--apply');

const NAME_ANCHOR = /([\u4e00-\u9fff·]{2,12})\s*[，,]\s*(?:男|女)\s*[，,]/;
const STOP = /\(?\s*来源\s*[:：]|人\s*民\s*网\s*版?\s*权|Copyright|未经书面授权|责任编辑|\(\s*责\s*编|\(责编|学习路上|分享到|推荐阅读|扫一扫/;
const POLLUTED = /简历--|通行证|不忘初心|Copyright|人民网版权所有/;

function api(pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const url = new URL(ADMIN + pathname);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(Error(b || String(res.statusCode)));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function clean(text, name) {
  if (!text) return text;
  const m = NAME_ANCHOR.exec(text);
  if (!m) return /任命/.test(text) ? text.trim() : text;
  let start = m.index;
  if (name && m[1] !== name) {
    const hits = [text.indexOf(name + '，'), text.indexOf(name + ',')].filter(i => i >= 0);
    if (hits.length) start = Math.min(...hits);
  }
  let body = text.slice(start);
  const stop = body.search(STOP);
  if (stop > 40) body = body.slice(0, stop);
  return body.trim();
}

async function main() {
  const all = await api('/api/entities?type=person&limit=20000');
  const dirty = all.filter(it => POLLUTED.test((it.props && it.props['简介']) || ''));
  console.log(`polluted records: ${dirty.length}`);

  let fixed = 0;
  for (const it of dirty) {
    const e = await api('/api/entities/' + encodeURIComponent(it.id));
    const before = (e.props && e.props['简介']) || '';
    const after = clean(before, e.name);
    if (after === before) continue;
    e.props['简介'] = after;
    if (e.summary && e.summary.length > after.length) e.summary = after.slice(0, 200);
    console.log(`  - ${e.name}: ${before.length} -> ${after.length}`);
    if (APPLY) { await api('/api/entities/' + encodeURIComponent(e.id), 'PUT', e); fixed++; }
  }
  console.log(`\ncleaned: ${fixed}${APPLY ? '' : ' (dry run; use --apply)'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
