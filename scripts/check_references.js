#!/usr/bin/env node
'use strict';
/**
 * Check that every relation target points at a real entity.
 *
 * Reads the complete entity set via src/store/data_reader.js. The previous
 * version read `index.json`, which is now a truncated compatibility file, so it
 * validated references for the first index page only — and, worse, resolved
 * targets against that truncated id set, which would have reported *false*
 * breakage for any target living on a later page.
 *
 * Where relations actually live: `claims.currentPositions` / `claims.career`
 * (each may name an `organization`), and `relations` for entities that use it.
 * Both are checked. Note that `relations` is empty for most of the curated data
 * — the people/organisation links come from claims — so a checker that only
 * looked at `relations` would report a clean run while inspecting nothing.
 *
 * Targets may be entity ids or plain labels; a label is only a problem when it
 * looks like an id (contains ':') and matches nothing.
 */
const { readEntities, allFolders } = require('../src/store/data_reader');
const rawStore = require('../src/store/raw_store');

let errors = 0;
let checkedRefs = 0;
const orgLabels = new Set();

const all = new Map(); // id -> folder
for (const folder of allFolders()) {
  for (const e of readEntities(folder)) all.set(e.id, folder);
}

function fail(msg) {
  console.error('  ERROR ' + msg);
  errors++;
}

/** Refuse to call a target broken just because it is a free-text label. */
function checkTarget(where, id) {
  if (typeof id !== 'string' || !id.trim()) return;
  if (id.startsWith('←')) return; // legacy inverse marker, not an id
  if (!id.includes(':')) return; // plain label, resolved at load time
  checkedRefs++;
  if (!all.has(id)) fail(`broken reference ${where} -> ${id}`);
}

for (const folder of allFolders()) {
  for (const e of readEntities(folder)) {
    for (const [rel, values] of Object.entries(e.relations || {})) {
      for (const v of values || []) {
        checkTarget(`${e.id} --${rel}-->`, typeof v === 'string' ? v : v && (v.target || v.id));
      }
    }

    // `claims.*.organization` holds a human-readable label, and graph_source
    // resolves it to an organization node when one matches. Count those labels
    // so this script actually inspects the person->organisation link surface.
    const claims = e.claims || {};
    for (const field of ['currentPositions', 'career']) {
      for (const c of claims[field] || []) {
        if (!c) continue;
        if (c.organizationId) checkTarget(`${e.id} .claims.${field}`, c.organizationId);
        if (c.organization) {
          orgLabels.add(String(c.organization));
          checkedRefs++;
        }
      }
    }

    // 【id】 / 【id|type】 references inside property values.
    //
    // Only content shaped like an entity id counts. CBDB's `史料注记` uses 【】 as an
    // ordinary quotation mark — `【參考《清代人物生卒年表》#8747.】` — on 22,858 rows.
    // Treating every 【】 as a reference reported 23,034 "broken references" that
    // were really a valid Chinese use of the bracket, and would have hidden any real
    // dangling reference in the noise.
    //
    // Verified against the corpus: of all 【】 spans in the CBDB notes, exactly zero
    // are shaped like an entity id, so this narrows nothing that was real.
    for (const [k, v] of Object.entries(e.props || {})) {
      if (typeof v !== 'string') continue;
      const re = /【([^】]+)】/g;
      let m;
      while ((m = re.exec(v)) !== null) {
        const id = m[1].split('|')[0].trim();
        if (!id) continue;
        // `person:cbdb-1`, `organization:local-000012`, `event:…`, `thing:…`
        if (!/^(person|organization|event|thing|evidence):[A-Za-z0-9._-]+$/.test(id)) continue;
        checkedRefs++;
        if (!all.has(id)) fail(`broken prop reference ${e.id} .${k} -> ${id}`);
      }
    }
  }
}

if (checkedRefs === 0) {
  // A checker that inspects nothing must not report success: that is exactly
  // how this script previously "passed" while covering 2000 of 5287 records.
  fail('no references were checked — the data layout probably changed');
}

// ---------------------------------------------------------------------------
// provenance[].rawRef must resolve in the layer-0 tree (§6.4)
// ---------------------------------------------------------------------------
//
// A provenance entry that cites a rawId which does not exist is worse than no
// provenance at all: it looks sourced. The same rule as the reference check
// above applies — a checker that inspects nothing must not report success, so
// we also fail when zero entries were seen.
//
// `raw_store.exists()` reads one group at a time and caches it, so 486k probes
// against a single CBDB table stay cheap; the check does not walk every group.
let provChecked = 0;
let provMissing = 0;
let provNoQuote = 0;
let provNotArray = 0;
const missingSamples = [];

for (const folder of allFolders()) {
  for (const e of readEntities(folder)) {
    if (e.provenance === undefined) continue;
    if (!Array.isArray(e.provenance) || !e.provenance.length) {
      // §6.4: provenance 必须是数组且非空。空数组 = 无出处断言。
      fail(`${e.id} has an empty provenance; omit the field or fill it`);
      provNotArray++;
      continue;
    }
    for (const it of e.provenance) {
      const ref = it && it.rawRef;
      if (!ref) {
        fail(`${e.id} provenance entry has no rawRef`);
        continue;
      }
      provChecked++;
      if (!rawStore.exists(ref)) {
        provMissing++;
        if (missingSamples.length < 5) missingSamples.push(`${e.id} -> ${ref}`);
      }
      // quote 必填非空：空字符串等于没出处。
      if (!it.quote || !String(it.quote).trim()) {
        fail(`${e.id} provenance entry for ${ref} has an empty quote`);
        provNoQuote++;
      }
    }
  }
}

if (provChecked === 0) {
  // Not a failure yet: the backfill may legitimately be partial while P1 is in
  // progress. Reported loudly so an empty run cannot masquerade as "all good".
  console.log('provenance: 0 entries checked — no entity declares provenance yet');
} else {
  console.log(
    `provenance: ${provChecked} rawRef checked, ${provMissing} missing from raw/, `
    + `${provNoQuote} empty quote, ${provNotArray} non-array`,
  );
  if (provMissing) {
    console.error(`  ERROR ${provMissing} provenance rawRef(s) do not resolve in raw/`);
    for (const s of missingSamples) console.error(`    ${s}`);
    errors++;
  }
}

// Report label resolution instead of failing on it: an unresolved label becomes
// a literal edge, which is lossy but not corrupt. Surfacing the ratio makes the
// organisation coverage gap visible rather than silently absorbed.
//
// Aliases count as resolution, because graph_source resolves a label through
// NameIndex, which indexes aliases too. Comparing against names only made this
// report understate coverage — 中共二十届 showed as unresolved even though it is
// an alias of 中共二十届中央委员会 and does produce a real edge.
const orgNames = new Set();
for (const folder of allFolders()) {
  if (folder !== 'organizations') continue;
  for (const o of readEntities(folder)) {
    orgNames.add(o.name);
    for (const a of o.aliases || []) orgNames.add(a);
  }
}
const resolved = [...orgLabels].filter((l) => orgNames.has(l));
const unresolved = [...orgLabels].filter((l) => !orgNames.has(l));

console.log(`references checked: ${checkedRefs} across ${all.size} entities`);
console.log(
  `organisation labels: ${orgLabels.size} distinct, `
  + `${resolved.length} resolve to an entity, ${unresolved.length} fall back to literal text`,
);
if (unresolved.length) {
  const sample = unresolved.slice(0, 5).join('、');
  console.log(`  unresolved (literal edges): ${sample}${unresolved.length > 5 ? ' …' : ''}`);
}
if (errors) console.error(`check_references: ${errors} problem(s)`);
process.exitCode = errors ? 1 : 0;
