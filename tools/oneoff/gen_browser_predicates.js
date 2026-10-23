'use strict';
/**
 * Regenerate the browser half of the predicate table from the core registry.
 *
 * `js/core/predicates.js` mirrors `src/predicates/registry.js` because the
 * browser cannot require() CommonJS without a build step. The two used to be
 * edited by hand, and the parity test existed purely to catch the resulting
 * drift. This script removes the hand-editing: it rewrites the BUILTIN block in
 * place, preserving the surrounding file and the one-entry-per-line format so
 * diffs stay readable.
 *
 * Usage: node tools/oneoff/gen_browser_predicates.js [--check]
 *   --check   exit 1 if the file is out of date instead of writing it
 *
 * This is a one-off tool rather than a build step on purpose: the browser table
 * is committed, so a deploy does not need Node.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'js', 'core', 'predicates.js');
const { BUILTIN } = require(path.join(ROOT, 'src', 'predicates', 'registry.js'));

/** Render one predicate as the compact single-line object literal. */
function renderEntry(p) {
  const parts = [`key: ${JSON.stringify(p.key)}`, `label: ${JSON.stringify(p.label)}`];
  if (p.domain) parts.push(`domain: ${JSON.stringify(p.domain)}`);
  if (p.range) parts.push(`range: ${JSON.stringify(p.range)}`);
  if (p.inverse) parts.push(`inverse: ${JSON.stringify(p.inverse)}`);
  const aliases = (p.aliases || []).map((a) => JSON.stringify(a)).join(',');
  parts.push(`aliases: [${aliases}]`);
  parts.push(`symmetric: ${!!p.symmetric}`);
  parts.push(`negatable: ${p.negatable !== false}`);
  if (p.objectGender) parts.push(`objectGender: ${JSON.stringify(p.objectGender)}`);
  const quals = (p.qualifiers || []).map((q) => `QUAL.${q.toUpperCase()}`).join(',');
  parts.push(`qualifiers: [${quals}]`);
  return `    { ${parts.join(', ')} },`;
}

/** Render the whole BUILTIN array body, one predicate per line. */
function renderTable() {
  return BUILTIN.map(renderEntry).join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const src = fs.readFileSync(TARGET, 'utf8');

  // Anchor on the array literal itself; anything outside it is left untouched.
  const startMarker = '  var BUILTIN = [\n';
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('could not find "var BUILTIN = [" in ' + TARGET);
  const endMarker = '\n  ];';
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('could not find the end of the BUILTIN array');

  const before = src.slice(start + startMarker.length, end);
  const after = renderTable();
  const updated = src.slice(0, start + startMarker.length) + after + src.slice(end);

  if (before === after) {
    console.log(`browser predicates already up to date (${BUILTIN.length} entries)`);
    return;
  }
  if (checkOnly) {
    console.error('browser predicates are OUT OF DATE; run: node tools/oneoff/gen_browser_predicates.js');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(TARGET, updated);
  console.log(`regenerated ${BUILTIN.length} predicates into js/core/predicates.js`);
}

main();
