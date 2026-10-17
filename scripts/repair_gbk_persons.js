#!/usr/bin/env node
/**
 * Repair person records whose text was decoded as UTF-8 from GB2312/GBK pages.
 *
 * The original import wrote mojibake into props.简介 / summary / external.title.
 * The bytes are unrecoverable (they were replaced, not re-encoded), so the only
 * correct fix is to re-fetch the original page and decode it properly.
 *
 * Usage:
 *   node scripts/repair_gbk_persons.js            # dry run, report only
 *   node scripts/repair_gbk_persons.js --apply    # write fixes via admin API
 */
const http = require('http');
const https = require('https');

const ADMIN = process.env.HM_ADMIN_URL || 'http://127.0.0.1:8787';
const APPLY = process.argv.includes('--apply');

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

function fetchBuf(url, redirects = 0) {
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
        return resolve(fetchBuf(new URL(res.headers.location, url).href, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error('HTTP ' + res.statusCode));
        resolve({ buf: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' });
      });
    }).on('error', reject);
  });
}

function decode(buf, contentType) {
  let label = '';
  const m = /charset=["']?([\w-]+)/i.exec(buf.slice(0, 2000).toString('latin1'));
  if (m) label = m[1].toLowerCase();
  else if (/charset=([\w-]+)/i.test(contentType)) label = RegExp.$1.toLowerCase();
  if (/gb2312|gbk|gb18030/.test(label)) return { text: new TextDecoder('gbk').decode(buf), label };
  return { text: buf.toString('utf8'), label: label || 'utf-8' };
}

const clean = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const MOJIBAKE = /\uFFFD|鐭|閲|鍏|鐜|鐨|銆|���/;

async function main() {
  const all = await api('/api/entities?type=person&limit=20000');
  const suspects = [];
  for (const item of all) {
    if (!item.external || !item.external.cpcUrl) continue;
    const title = item.external.title || item.summary || '';
    if (MOJIBAKE.test(title) || /\uFFFD/.test(item.summary || '')) suspects.push(item);
  }
  console.log(`suspects with corrupted text: ${suspects.length}`);

  let fixed = 0, failed = 0;
  for (const item of suspects) {
    const url = item.external.cpcUrl;
    try {
      const { buf, contentType } = await fetchBuf(url);
      const { text: html, label } = decode(buf, contentType);
      const plain = clean(html);
      // Resume body starts at "<name>，<性别>"
      // The stored name may itself be corrupted, so take the title-derived name.
      const titlePlain = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
      const nameGuessFromTitle = (titlePlain.match(/^([\u4e00-\u9fff·]{2,12})/) || [])[1] || '';
      // The resume sentence "<name>，<gender>，" is the reliable anchor; titles and
      // stored names are often corrupted, so ignore them when locating the body.
      const anchor = /([\u4e00-\u9fff·]{2,12})\s*[，,]\s*(?:男|女)\s*[，,]/.exec(plain);
      let nameGuess = anchor ? anchor[1] : nameGuessFromTitle;
      const idx = anchor ? anchor.index : -1;

      // Some stored links point at 人事任免 orders (主席令) rather than resumes.
      // For those, the authoritative fact is the appointment sentence itself.
      let body = '';
      let apptEvidence = '';
      if (idx >= 0) {
        body = plain.slice(idx);
        const stop = body.search(/人\s*民\s*网\s*股\s*份|Copyright|未经书面授权/);
        if (stop > 100) body = body.slice(0, stop);
        body = body.trim();
      } else {
        const order = [...plain.matchAll(/任命([一-鿿·]{2,12})为([^。；]{2,40})[。；]/g)];
        if (!order.length) { console.warn(`  skip ${item.name}: no appointment sentence`); failed++; continue; }
        // Match the stored name's last two characters (titles like "央行行长 " prefix it).
        const tail = (item.name || '').replace(/[^一-鿿·]/g, '').slice(-3);
        let hit = order.find(m => m[1] && tail && m[1].includes(tail.slice(-2)));
        if (!hit) hit = order.find(m => m[1] === nameGuessFromTitle);
        if (!hit) hit = order[0];
        if (!nameGuess) nameGuess = hit[1];
        let mine = '';
        apptEvidence = hit[0];
        if (!anchor) nameGuess = hit[1];
        const dateMatch = plain.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        body = (dateMatch ? `${dateMatch[1]}年${dateMatch[2]}月${dateMatch[3]}日，` : '') +
          `依据${titlePlain ? titlePlain.replace(/--.*$/, '').trim() : '官方任免公告'}：${mine}`;
      }
      if (!body) { console.warn(`  skip ${item.name}: empty body`); failed++; continue; }

      const full = await api('/api/entities/' + encodeURIComponent(item.id));
      const before = full.props && full.props['简介'] ? full.props['简介'] : '';
      if (!MOJIBAKE.test(before) && !/\uFFFD/.test(before)) { console.log(`  ok ${item.name} (already clean)`); continue; }

      full.props = full.props || {};
      full.props['简介'] = body;
      full.summary = body.slice(0, 200);
      if (apptEvidence) {
        full.props['任职依据'] = '官方任免公告';
        full.tags = Array.from(new Set([...(full.tags || []), '任职公告']));
      }
      if (full.external) {
        full.external.title = titlePlain || full.external.title;
      }
      // Strip a corrupted role prefix such as "央行行长 " from the stored name.
      if (MOJIBAKE.test(full.name) || /^[\u4e00-\u9fff]{2,10}\s+/.test(full.name)) {
        const cleaned = (full.name.match(/[\u4e00-\u9fff·]{2,6}$/) || [])[0];
        if (nameGuess) full.name = nameGuess;
        else if (cleaned) full.name = cleaned;
      }
      const ev = (full.claims && full.claims.currentPositions) || [];
      for (const c of ev) if (MOJIBAKE.test(c.evidence || '')) c.evidence = '';

      console.log(`  fix ${nameGuess} | decoding=${label} | new length=${body.length}`);
      if (APPLY) { await api('/api/entities/' + encodeURIComponent(full.id), 'PUT', full); fixed++; }
    } catch (e) {
      console.warn(`  fail ${item.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nfixed: ${fixed} | failed: ${failed}${APPLY ? '' : ' (dry run; use --apply)'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
