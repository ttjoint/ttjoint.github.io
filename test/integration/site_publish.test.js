'use strict';
/**
 * The published site must be self-contained and correctly filtered.
 *
 * The repository no longer tracks `data/` — it tracks `site/`, which is what GitHub
 * Pages serves. That makes `site/` a load-bearing artefact: if a shell file is not
 * copied, or a manifest points at a page that was not written, the deployed site
 * breaks while every other test stays green (the tests read `data/`, which is
 * present locally).
 *
 * These tests exist because of exactly that gap: the split between "local full
 * corpus" and "committed public subset" is new, and a silent break in it would only
 * show up as a 404 in a browser.
 *
 * `site/` is a build product, so when it is absent (fresh clone before
 * `npm run build:site`) these tests skip rather than fail.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');

const hasSite = fs.existsSync(path.join(SITE, 'index.html'));

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(SITE, ...parts), 'utf8'));
}

test('site: shell is complete', { skip: !hasSite && 'site/ not built' }, () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  // Local references only: CDN URLs are intentionally not vendored.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('#') && !u.startsWith('data:'));
  assert.ok(refs.length > 0, 'index.html references no local assets');
  const missing = refs.filter((r) => !fs.existsSync(path.join(SITE, r)));
  assert.deepEqual(missing, [], 'index.html references files that were not copied into site/');
});

test('site: predicates registry is present', { skip: !hasSite && 'site/ not built' }, () => {
  // Without it the browser cannot label a single edge; every relation would render
  // as a raw English key.
  const file = path.join(SITE, 'data', 'predicates', 'registry.json');
  assert.ok(fs.existsSync(file), 'missing data/predicates/registry.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Object.keys(registry).length > 0);
});

test('site: every manifest reference resolves', { skip: !hasSite && 'site/ not built' }, () => {
  const types = fs.readdirSync(path.join(SITE, 'data'))
    .filter((t) => fs.existsSync(path.join(SITE, 'data', t, 'manifest.json')));
  assert.ok(types.length >= 5, `expected 5 entity types, found ${types.length}`);

  const missing = [];
  for (const t of types) {
    const m = readJson('data', t, 'manifest.json');
    const check = (rel) => {
      if (rel && !fs.existsSync(path.join(SITE, 'data', t, rel))) missing.push(`${t}/${rel}`);
    };
    for (const p of m.pages || []) check(p.file);
    check(m.chronology);
    for (const b of (m.search && m.search.buckets) || []) check(b.file);
    check('index.json');
  }
  assert.deepEqual(missing, []);
});

test('site: every list row has a detail file', { skip: !hasSite && 'site/ not built' }, () => {
  // The publish build copies shards one by one; a mismatch between the filter used
  // for rows and the filter used for copies would produce links to absent files.
  const missing = [];
  let checked = 0;
  for (const t of fs.readdirSync(path.join(SITE, 'data'))) {
    const indexDir = path.join(SITE, 'data', t, 'index');
    if (!fs.existsSync(indexDir)) continue;
    for (const f of fs.readdirSync(indexDir)) {
      if (!/^page-/.test(f)) continue;
      for (const row of JSON.parse(fs.readFileSync(path.join(indexDir, f), 'utf8'))) {
        checked++;
        if (!row.detail) missing.push(`${t} ${row.name}: no detail path`);
        else if (!fs.existsSync(path.join(SITE, 'data', t, row.detail))) {
          missing.push(`${t} ${row.name} -> ${row.detail}`);
        }
      }
    }
  }
  assert.ok(checked > 1000, `only ${checked} rows checked`);
  assert.deepEqual(missing.slice(0, 5), []);
});

test('site: only modern persons are published', { skip: !hasSite && 'site/ not built' }, () => {
  // The core promise of the split: the repo carries the modern subset, not the whole
  // 486k CBDB import.
  const top = readJson('data', 'manifest.json');
  assert.equal(top.publish.filtered, true, 'site build must declare itself filtered');
  assert.equal(top.publish.personsFromYear, 1900);

  const persons = readJson('data', 'persons', 'manifest.json');
  const JDN_1900 = 2415021;
  const offenders = [];
  for (const page of persons.pages) {
    for (const row of readJson('data', 'persons', page.file)) {
      if (!row.lifespan) { offenders.push(`${row.name}: undated`); continue; }
      const latest = row.lifespan.end ?? row.lifespan.start ?? row.lifespan.mid;
      if (latest == null || latest < JDN_1900) offenders.push(`${row.name}: ${latest}`);
    }
  }
  assert.deepEqual(offenders.slice(0, 5), []);
});

test('site: is small enough to commit', { skip: !hasSite && 'site/ not built' }, () => {
  // Git rejects files over 100 MB and warns above 50 MB; the whole tree must stay
  // far below that or "commit the site" stops being viable.
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d)) {
      const p = path.join(d, entry);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else bytes += st.size;
    }
  };
  walk(SITE);
  const mb = bytes / 1024 / 1024;
  assert.ok(mb < 50, `site/ is ${mb.toFixed(1)} MB, too large to commit`);
});
