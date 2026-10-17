#!/usr/bin/env node
/**
 * Structure the People's Daily (人民网) person records.
 *
 * The original import stored only a cleaned 简介 blob and, worse, derived the
 * name from the surrounding link text, producing names such as
 *   "国家民委主任 陈瑞峰", "书记：李希", "主席：高云龙"
 *
 * This script:
 *   1. recovers the real name from the resume sentence "<name>，<gender>，"
 *   2. extracts 性别 / 出生年月 / 籍贯 / 民族 / 学历 via deterministic rules
 *   3. parses 现任… into currentPositions claims
 *   4. rewrites the entity through the admin API
 *
 * Usage:
 *   node scripts/structure_cpc_persons.js           # dry run
 *   node scripts/structure_cpc_persons.js --apply   # write
 */
const http = require('http');

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

// "陈瑞峰" / "雪克来提·扎克尔" / "李希"
const NAME_RE = /([\u4e00-\u9fff·]{2,12})\s*[，,]\s*(?:男|女)\s*[，,]/;

function extract(text) {
  const out = {};
  const anchor = NAME_RE.exec(text);
  if (anchor) out.name = anchor[1];
  out.gender = (text.match(/[，,]\s*(男|女)\s*[，,]/) || [])[1] || '';
  out.ethnicity = (text.match(/[，,]\s*([\u4e00-\u9fff]{1,4}族)\s*[，,]/) || [])[1] || '';
  const b = text.match(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?生/);
  out.birthDate = b ? `${b[1]}年${b[2]}月` : '';
  const n = text.match(/[，,]\s*([\u4e00-\u9fff]{2,10}(?:省|市|县|区)?[\u4e00-\u9fff]{0,6})人\s*[，,。]/);
  out.nativePlace = n ? n[1] : '';
  const e = text.match(/([\u4e00-\u9fff]{2,20}(?:大学|学院|党校|学校)[\u4e00-\u9fff]{0,24}(?:专业)?(?:毕业)?[，,、]?\s*(?:在职)?[\u4e00-\u9fff]{0,10}(?:学历|学位))/) || [];
  out.education = e[1] || '';
  // 现任 sentence: 现任 A，B，C。
  const cur = text.match(/现任([^。]{4,300})。/);
  out.current = cur ? cur[1].split(/[，,、]/).map(s => s.trim()).filter(Boolean) : [];
  out.deceased = /(\d{4})年(\d{1,2})月[^。]{0,12}(逝世|去世|病逝)/.test(text);
  return out;
}

const stripJobPrefix = name => name.replace(/^[^\u4e00-\u9fff·]*(?:国家)?[\u4e00-\u9fff]{0,12}(?:主任|部长|主席|书记|理事长|行长|审计长|局长|委员长|总理)\s*[：:]?\s*/, '');

// Some 简介 blobs begin with the site navigation instead of the resume. Locate the
// actual resume sentence and trim trailing boilerplate so props/summary stay clean.
function bodyOf(raw, name) {
  const text = raw || '';
  const re = /([\u4e00-\u9fff·]{2,12})\s*[，,]\s*(?:男|女)\s*[，,]/;
  const m = re.exec(text);
  if (!m) return '';
  // The resume belongs to this person; if a different name anchors first, prefer ours.
  let start = m.index;
  if (name && m[1] !== name) {
    const idx = text.indexOf(name + '，');
    const idx2 = text.indexOf(name + ',');
    const hits = [idx, idx2].filter(i => i >= 0);
    if (hits.length) start = Math.min(...hits);
  }
  let body = text.slice(start);
  const stop = body.search(/\(?\s*来源\s*[:：]|人\s*民\s*网\s*版?\s*权|Copyright|未经书面授权|责任编辑|\(\s*责\s*编|\(责编|学习路上|分享到|推荐阅读|扫一扫/);
  if (stop > 60) body = body.slice(0, stop);
  return body.trim();
}

async function main() {
  const all = await api('/api/entities?type=person&limit=20000');
  const targets = [];
  for (const it of all) if (it.external && it.external.cpcUrl) targets.push(it);
  console.log(`cpc-sourced persons: ${targets.length}`);

  let fixed = 0, renamed = 0, failed = 0, skipped = 0;
  for (const it of targets) {
    const e = await api('/api/entities/' + encodeURIComponent(it.id));
    const rawText = (e.props && e.props['简介']) || e.summary || '';
    if (!rawText || rawText.length < 20) { skipped++; continue; }
    // Normalise the stored blob so navigation text never survives into props.
    const cleanBody = bodyOf(rawText, e.name);
    const text = cleanBody || rawText;

    const x = extract(text);
    // Appointment-order records carry no resume sentence; they only support a name
    // cleanup plus the appointment fact itself.
    const isOrder = !x.name;
    if (isOrder && !/任命|免去/.test(text)) { console.warn(`  skip ${e.name}: no resume sentence`); skipped++; continue; }

    const oldName = e.name;
    const payload = JSON.parse(JSON.stringify(e));
    payload.props = payload.props || {};
    if (cleanBody) payload.props['简介'] = cleanBody;

    if (isOrder) {
      // Prefer the appointment sentence naming this person; it is the only fact
      // these pages actually assert. Never invent biographical fields from them.
      const appt = new RegExp(`任命${e.name}为([^。；]{2,40})`).exec(text);
      const clean = stripJobPrefix(oldName).trim();
      if (clean && clean !== oldName && /^[\u4e00-\u9fff·]{2,10}$/.test(clean)) {
        payload.name = clean;
        renamed++;
        console.log(`  rename ${oldName} -> ${clean}`);
      }
      if (!appt) { skipped++; continue; }
      const role = appt[1].trim();
      payload.props['简介'] = `${payload.name || oldName}，依据中华人民共和国主席令，任命为${role}。`;
      payload.props['任职依据'] = '官方任免公告';
      payload.summary = payload.props['简介'];
      payload.claims = payload.claims || {};
      payload.claims.currentPositions = [{ role, evidence: appt[0], sourceUrl: e.external.cpcUrl }];
      payload.tags = Array.from(new Set([...(payload.tags || []), '任职公告']));
    } else {
      if (x.gender) payload.props['性别'] = x.gender;
      if (x.birthDate) payload.props['出生年月'] = x.birthDate;
      if (x.nativePlace) payload.props['籍贯'] = x.nativePlace;
      if (x.ethnicity) payload.props['民族'] = x.ethnicity;
      if (x.education) payload.props['学历'] = x.education;
      if (x.deceased) payload.props['已故'] = '是';

      // Name repair: the resume sentence is authoritative.
      const cleanName = x.name;
      if (cleanName && cleanName !== oldName) {
        payload.name = cleanName;
        const aliases = new Set(payload.aliases || []);
        if (/^[\u4e00-\u9fff·]{2,10}$/.test(oldName)) aliases.add(oldName);
        payload.aliases = [...aliases];
        renamed++;
        console.log(`  rename ${oldName} -> ${cleanName}`);
      }

      if (x.current.length) {
        payload.claims = payload.claims || {};
        payload.claims.currentPositions = x.current.map(p => ({
          role: p,
          evidence: p,
          sourceUrl: e.external.cpcUrl,
        }));
      }
      payload.summary = text.slice(0, 200);
    }

    if (APPLY) { await api('/api/entities/' + encodeURIComponent(e.id), 'PUT', payload); }
    fixed++;
  }
  console.log(`\nstructured: ${fixed} | renamed: ${renamed} | skipped: ${skipped} | failed: ${failed}${APPLY ? '' : ' (dry run; use --apply)'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
