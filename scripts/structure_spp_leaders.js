#!/usr/bin/env node
/**
 * Convert SPP leadership records into the structured-candidate format consumed
 * by the admin review queue (same shape as extract_structured_candidates output).
 *
 * The SPP page already yields structured fields (name/gender/ethnicity/birthDate/
 * education/positions), so no LLM pass is needed: provenance method is "rules".
 *
 * Usage: node scripts/structure_spp_leaders.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'imports', 'official');

const latest = fs.readdirSync(DIR)
  .filter(f => f.startsWith('spp-leaders-') && f.endsWith('.json'))
  .sort()
  .at(-1);
if (!latest) throw Error('no spp-leaders batch found; run npm run import:spp first');

const batch = JSON.parse(fs.readFileSync(path.join(DIR, latest), 'utf8'));

// Split "最高人民检察院副检察长" into organization + role for claim records.
const ORGS = [
  '最高人民检察院',
  '中共中央纪律检查委员会',
  '中共二十届中央',
  '中央纪委国家监委',
];

function splitPosition(pos) {
  const org = ORGS.find(o => pos.startsWith(o));
  if (!org) return { organization: '', role: pos, evidence: pos };
  const role = pos.slice(org.length).trim();
  return { organization: org, role: role || pos, evidence: pos };
}

const records = [];
for (const p of batch.records) {
  const claims = p.positions.map(splitPosition).filter(c => c.role);
  const candidate = {
    name: p.name,
    gender: p.gender,
    birthDate: p.birthDate,
    ethnicity: p.ethnicity || '',
    education: p.education || '',
    currentPositions: claims,
    career: [],
    summary: p.resume,
    sourceUrl: p.sourceUrl,
    confidence: 1,
  };
  // Drop empty strings so validation sees clean fields.
  for (const k of Object.keys(candidate)) {
    const v = candidate[k];
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete candidate[k];
  }
  if (!candidate.currentPositions) throw Error(`no positions for ${p.name}`);

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
const out = `structured-spp-${stamp}.json`;
fs.writeFileSync(path.join(DIR, out), JSON.stringify({
  input: latest,
  createdAt: new Date().toISOString(),
  count: records.length,
  errors: [],
  records,
}, null, 2) + '\n');

console.log(`structured ${records.length} SPP candidates -> ${out}`);
for (const r of records) {
  console.log(` - ${r.candidate.name} | ${(r.candidate.currentPositions || []).length} positions`);
}
