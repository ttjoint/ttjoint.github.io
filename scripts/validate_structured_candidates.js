#!/usr/bin/env node
/**
 * Validate every structured candidate batch in data/imports/official.
 *
 * Multiple batch families coexist (structured-*, structured-spp-*, structured-gov-*),
 * so validating only the lexicographically last file silently skipped batches.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'data', 'imports', 'official');
const files = fs.readdirSync(dir)
  .filter(x => x.startsWith('structured-') && x.endsWith('.json'))
  .sort();
if (!files.length) throw Error('run extract:structured first');

const ARRAYS = ['currentPositions', 'career'];
const STRINGS = ['name', 'birthDate', 'nativePlace', 'ethnicity', 'education', 'summary'];

let failed = false;
const report = [];

for (const f of files) {
  const x = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const errors = [];
  const ids = new Set();
  const records = Array.isArray(x.records) ? x.records : [];

  for (const r of records) {
    if (!/^person:[0-9a-f]{20}$/.test(r.id)) errors.push('invalid id ' + r.id);
    if (ids.has(r.id)) errors.push('duplicate id ' + r.id);
    ids.add(r.id);
    if (!r.evidence?.sourceUrl) errors.push('missing evidence url ' + r.id);
    if (!r.evidence?.excerpt) errors.push('missing evidence excerpt ' + r.id);
    if (!['pending', 'approved', 'rejected'].includes(r.status)) errors.push('invalid status ' + r.id);
    if (!r.candidate?.name) errors.push('missing name ' + r.id);
    if (!r.provenance?.method) errors.push('missing provenance ' + r.id);

    const c = r.candidate || {};
    // A batch is only valid if the LLM step actually succeeded.
    if (c.llmError) errors.push('llm failed for ' + r.id + ': ' + c.llmError);
    for (const k of ARRAYS) {
      if (c[k] !== undefined && !Array.isArray(c[k])) errors.push(k + ' must be array ' + r.id);
    }
    for (const k of STRINGS) {
      if (typeof c[k] === 'string' && c[k].includes('undefined')) errors.push(k + ' contains "undefined" ' + r.id);
    }
    // reject mojibake evidence
    if (r.evidence?.excerpt && /鐭|閲|鍏|鐜|鐨|銆/.test(r.evidence.excerpt)) errors.push('mojibake evidence ' + r.id);
  }

  if (x.count !== records.length) errors.push(`count mismatch: declared ${x.count}, actual ${records.length}`);
  if (errors.length) failed = true;
  report.push({ file: f, count: x.count, actual: records.length, uniqueIds: ids.size, errors });
}

const totals = report.reduce((n, r) => n + r.actual, 0);
console.log(JSON.stringify({ batches: report.length, records: totals, files: report }, null, 2));
process.exitCode = failed ? 1 : 0;
