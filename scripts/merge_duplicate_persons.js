#!/usr/bin/env node
/**
 * Merge duplicate person entities that refer to the same real person.
 * Detection: same name AND compatible identifying props (birthDate/nativePlace).
 * Strategy: keep the entity with the richest data, absorb props/claims/sources/aliases
 * from the other, then soft-delete the duplicate in the admin DB.
 *
 * Usage:
 *   node scripts/merge_duplicate_persons.js           # dry run
 *   node scripts/merge_duplicate_persons.js --apply   # write result
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
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
        if (res.statusCode >= 400) return reject(new Error(b || res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Normalise a value for comparison.
const norm = v => String(v == null ? '' : v).replace(/[\s　]/g, '').trim();

// A person pair is "same person" when the identifying facts do not contradict
// each other and at least one meaningful fact matches.
// Pull identifying facts out of a free-text resume when structured props are absent.
function facts(e) {
  const p = e.props || {};
  const text = [p['简介'], e.summary, p['介绍']].filter(Boolean).join(' ').replace(/[\s　]+/g, '');
  // Text-derived facts win over stored props: stored props may be mis-extracted
  // (e.g. 出生于澳门 was once recorded as 籍贯), while the resume wording is authoritative.
  const mBirth = text.match(/(\d{4})年(\d{1,2})月(?:\d{0,2}日)?生/);
  const birth = mBirth ? mBirth[1] + '年' + mBirth[2] + '月' : norm(p['出生年月']);
  const mNative = text.match(/([一-鿿]{2,8})(?:市|县|区)?人[，,。]/);
  const native = mNative ? mNative[1] : norm(p['籍贯']);
  const edu = norm(p['学历']) || ((text.match(/([一-鿿]{2,10}大学[^，。；、]{0,24})/) || [])[1] || '');
  return { birth: birth || '', native: native || '', edu: edu || '' };
}

function sameFacts(a, b) {
  const na = norm(a.name), nb = norm(b.name);
  if (!na || na !== nb) return false;
  const fa = facts(a), fb = facts(b);
  const both = (x, y) => x && y;
  // Any conflicting identifying fact means these are different people.
  if (both(fa.birth, fb.birth) && fa.birth !== fb.birth) return false;
  if (both(fa.native, fb.native) && fa.native !== fb.native) return false;
  const agree = (both(fa.birth, fb.birth) ? 1 : 0) + (both(fa.native, fb.native) ? 1 : 0) + (both(fa.edu, fb.edu) ? 1 : 0);
  return agree >= 1;
}

function richness(e) {
  const props = Object.keys(e.props || {}).length;
  const claims = ['currentPositions', 'career'].reduce((n, k) => n + ((e.claims || {})[k] || []).length, 0);
  const sources = (e.sources || []).length;
  const summary = (e.props && e.props['简介'] ? e.props['简介'] : e.summary || '').length > 200 ? 2 : 1;
  return props * 3 + claims * 2 + sources + summary;
}

function mergeInto(base, other) {
  const out = JSON.parse(JSON.stringify(base));
  out.props = { ...(other.props || {}), ...(base.props || {}) };
  // Prefer richer summary text.
  const bs = (base.props || {})['简介'] || '';
  const os = (other.props || {})['简介'] || '';
  if (os.length > bs.length) out.props['简介'] = os;

  out.aliases = Array.from(new Set([...(base.aliases || []), ...(other.aliases || [])]));
  out.tags = Array.from(new Set([...(base.tags || []), ...(other.tags || [])]));

  const merged = { ...(base.claims || {}) };
  for (const key of ['currentPositions', 'career']) {
    const seen = new Set((merged[key] || []).map(x => JSON.stringify([x.organization, x.role, x.date, x.evidence])));
    for (const item of (other.claims || {})[key] || []) {
      const sig = JSON.stringify([item.organization, item.role, item.date, item.evidence]);
      if (!seen.has(sig)) { seen.add(sig); (merged[key] = merged[key] || []).push(item); }
    }
  }
  out.claims = merged;

  const srcSeen = new Set((out.sources || []).map(s => s.url || s.id));
  out.sources = [...(out.sources || [])];
  for (const s of other.sources || []) {
    const k = s.url || s.id;
    if (!srcSeen.has(k)) { srcSeen.add(k); out.sources.push(s); }
  }
  return out;
}

(async () => {
  const index = await api('/api/entities?type=person&limit=20000');
  // Only groups that share a name can be duplicates; fetch full details for those.
  const names = new Map();
  for (const item of index) {
    const k = norm(item.name);
    if (!names.has(k)) names.set(k, []);
    names.get(k).push(item);
  }
  const entities = [];
  for (const [, group] of names) {
    if (group.length < 2) continue;
    for (const item of group) {
      entities.push(item.props ? item : await api('/api/entities/' + encodeURIComponent(item.id)));
    }
  }
  const byName = new Map();
  for (const e of entities) {
    const k = norm(e.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }

  const plan = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const used = new Set();
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;
      const cluster = [group[i]];
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue;
        if (sameFacts(group[i], group[j])) { cluster.push(group[j]); used.add(j); }
      }
      if (cluster.length > 1) {
        used.add(i);
        cluster.sort((a, b) => richness(b) - richness(a));
        plan.push({ name, keeper: cluster[0], drop: cluster.slice(1) });
      }
    }
  }

  console.log(`duplicate clusters: ${plan.length}`);
  for (const p of plan) {
    console.log(`- ${p.name}: keep ${p.keeper.id} (richness ${richness(p.keeper)}) <- ${p.drop.map(d => d.id + ' (' + richness(d) + ')').join(', ')}`);
  }
  if (!plan.length || !APPLY) {
    if (plan.length) console.log('\n(dry run; re-run with --apply to merge)');
    return;
  }

  let merged = 0;
  for (const p of plan) {
    let keeper = p.keeper;
    for (const d of p.drop) keeper = mergeInto(keeper, d);
    await api('/api/entities/' + encodeURIComponent(keeper.id), 'PUT', keeper);
    for (const d of p.drop) {
      await api('/api/entities/' + encodeURIComponent(d.id), 'DELETE');
      merged++;
    }
  }
  console.log(`\nmerged and removed ${merged} duplicate entities`);
})().catch(e => { console.error(e); process.exit(1); });
