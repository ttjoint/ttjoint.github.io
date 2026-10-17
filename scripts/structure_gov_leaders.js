#!/usr/bin/env node
/**
 * Convert State Council leadership records into structured-candidate format for
 * the admin review queue (same shape as extract_structured_candidates output).
 *
 * Source already provides structured fields, so provenance method is "rules".
 *
 * Usage: node scripts/structure_gov_leaders.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'imports', 'official');

const latest = fs.readdirSync(DIR)
  .filter(f => f.startsWith('gov-leaders-') && !f.includes('latest') && f.endsWith('.json'))
  .sort()
  .at(-1);
if (!latest) throw Error('no gov-leaders batch found; run npm run import:gov-leaders first');

const batch = JSON.parse(fs.readFileSync(path.join(DIR, latest), 'utf8'));

// Map a position string to organization + role.
const ORGS = [
  '中共二十届中央政治局常委',
  '中共二十届中央政治局委员',
  '中共二十届中央书记处书记',
  '中共二十届中央委员',
  '中共二十届中央',
  '国务院',
  '中央财经委员会办公室',
  '中央政法委员会',
  '中华全国妇女联合会',
  '公安部',
  '外交部',
  '国家发展和改革委员会',
  '教育部',
  '科学技术部',
  '国家民族事务委员会',
  '国家安全部',
  '民政部',
  '司法部',
  '财政部',
  '人力资源和社会保障部',
  '自然资源部',
  '生态环境部',
  '住房和城乡建设部',
  '交通运输部',
  '水利部',
  '农业农村部',
  '商务部',
  '文化和旅游部',
  '国家卫生健康委员会',
  '退役军人事务部',
  '应急管理部',
  '中国人民银行',
  '审计署',
];

function splitPosition(pos) {
  const org = ORGS.find(o => pos.startsWith(o));
  if (!org) return { organization: '', role: pos, evidence: pos };
  const role = pos.slice(org.length).trim();
  // When the position text is exactly the organization name, record it as the
  // organization with an empty role rather than duplicating the value.
  return role
    ? { organization: org, role, evidence: pos }
    : { organization: org, role: '', evidence: pos };
}

const records = [];
for (const p of batch.records) {
  const claims = p.positions.map(splitPosition).filter(c => c.role || c.organization);
  if (!claims.length) throw Error(`no positions for ${p.name}`);

  const candidate = {
    name: p.name,
    gender: p.gender,
    birthDate: p.birthDate,
    nativePlace: p.nativePlace || '',
    ethnicity: p.ethnicity || '',
    education: p.education || '',
    currentPositions: claims,
    career: [],
    summary: p.resume,
    sourceUrl: p.sourceUrl,
    confidence: 1,
  };
  for (const k of Object.keys(candidate)) {
    const v = candidate[k];
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete candidate[k];
  }

  records.push({
    id: p.id,
    type: 'person',
    candidate,
    evidence: { sourceUrl: p.sourceUrl, excerpt: p.resume },
    provenance: { method: 'rules', model: null, createdAt: new Date().toISOString() },
    status: 'pending',
  });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = `structured-gov-${stamp}.json`;
fs.writeFileSync(path.join(DIR, out), JSON.stringify({
  input: latest,
  createdAt: new Date().toISOString(),
  count: records.length,
  errors: [],
  records,
}, null, 2) + '\n');

console.log(`structured ${records.length} State Council candidates -> ${out}`);
for (const r of records) {
  console.log(` - ${r.candidate.name} | ${(r.candidate.currentPositions || []).length} positions`);
}
