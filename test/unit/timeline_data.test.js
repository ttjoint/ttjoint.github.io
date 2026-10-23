'use strict';
/**
 * Timeline data: the corpus must actually be dated, and dates must be honest.
 *
 * This file exists because of a defect that was invisible from every angle. The
 * importer wrote a prose string (`props['生卒'] = '0年 ~ 不详'`) while the rest of
 * the system read `出生年月` / `逝世时间`. The result was not an error — it was
 * **7,120 persons with `lifespan === null`**. The timeline filter, the dated index
 * bucket and every date query were all operating on an empty set, and they did so
 * silently: a search that matches nothing looks exactly like a search that found
 * nothing.
 *
 * The other half of the same defect: the importer read `c_death_year`, but
 * BIOG_MAIN's column is `c_deathyear`. That returned `undefined` on every row, so
 * 71,283 known death years never reached the corpus.
 *
 * ## Why these tests read the index, not the shards
 *
 * There are 486,994 entities. `readEntities()` opens one file per entity, which
 * takes ~5 minutes per test and made this file unusable. The generated
 * `index/chrono.json` and `index/page-*.json` carry exactly the fields under test
 * (lifespan buckets, names, ids) and are derived from the shards by the same
 * builder the site uses, so reading them tests the same data at a fraction of the
 * cost.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const IMPORT_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'import_cbdb.js'), 'utf8');

const importCode = IMPORT_SRC.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

function readManifest(type) {
  const file = path.join(DATA, type, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every row of a type's list pages. */
function readRows(type) {
  const m = readManifest(type);
  if (!m) return [];
  const rows = [];
  for (const page of m.pages || []) {
    rows.push(...JSON.parse(fs.readFileSync(path.join(DATA, type, page.file), 'utf8')));
  }
  return rows;
}

test('timeline: the index records a substantial number of dated persons', () => {
  const m = readManifest('persons');
  assert.ok(m, 'data/persons/manifest.json missing; run npm run build:index');
  // The headline number. If this collapses, the timeline is dead and nothing else in
  // the app will say so.
  //
  // It is not 100%: CBDB has no year for 252k of its people, and an undated person
  // legitimately has no place on a timeline.
  assert.ok(m.dated > 200000, `only ${m.dated} dated persons in the index`);
  assert.ok(m.dated <= m.count, 'dated cannot exceed total');
});

test('timeline: every chronology entry has a usable range', () => {
  const file = path.join(DATA, 'persons', 'index', 'chrono.json');
  assert.ok(fs.existsSync(file), 'chrono.json missing');
  const chrono = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(chrono.length > 0);
  for (const row of chrono.slice(0, 500)) {
    assert.ok(Number.isFinite(row.mid), `${row.name} has no mid`);
    assert.ok(row.start != null || row.end != null, `${row.name} has no endpoint`);
  }
});

test('timeline: the year 0 never appears as a date', () => {
  // CBDB stores unknown years as 0 and the importer rendered that literally as
  // "0年". A person pinned to year 0 sorts ahead of everyone and reads as the
  // earliest figure in the corpus — worse than having no date at all.
  const chrono = JSON.parse(fs.readFileSync(path.join(DATA, 'persons', 'index', 'chrono.json'), 'utf8'));
  const offenders = chrono.filter((r) => {
    // JDN 1721060 is roughly the year 0; nothing legitimate sits there.
    return r.mid != null && r.mid > 1721000 && r.mid < 1721200;
  });
  assert.deepEqual(offenders.slice(0, 5).map((r) => r.name), []);
});

test('timeline: ids are opaque, never derived from names', () => {
  // The corpus keeps namesakes as separate people (>500 name groups). If an id were
  // a name hash those people would collapse into one node.
  const rows = readRows('persons').slice(0, 2000);
  for (const r of rows) {
    assert.match(r.id, /^person:[a-z]+[-:]/i, `${r.name} has a non-source id: ${r.id}`);
  }
});

test('importer: reads c_deathyear, the column that actually exists', () => {
  // Comments explaining the bug are allowed; only code lines are checked.
  assert.match(importCode, /c_deathyear/);
  assert.ok(!/c_death_year/.test(importCode), 'c_death_year is not a column');
  assert.ok(!/C_DEATH_YEAR/.test(importCode), 'C_DEATH_YEAR is not a column');
});

test('importer: emits the structured date props the reader looks for', () => {
  assert.match(importCode, /出生年月/, 'must emit 出生年月');
  assert.match(importCode, /逝世时间/, 'must emit 逝世时间');
  // The old single-string helper wrote prose only, so nothing downstream could read
  // a date out of it.
  assert.ok(!/formatLifeSpan\(/.test(importCode), 'formatLifeSpan must be gone');
});

test('importer: treats 0 as unknown rather than as a year', () => {
  // 290 CBDB rows carry c_index_year = 0 as a sentinel, and 352k rows carry no year.
  assert.match(importCode, /function realYear/);
  assert.match(importCode, /n === 0\) return null|n===0/);
});

test('importer: does not drop people merely because they are undated', () => {
  // The old filter skipped anyone with no year. CBDB has 352,779 such rows, and they
  // include 關羽, 劉備 and 張遼 — while a 1064 CE 周瑜 got through. A missing date is
  // a gap in the source, not a reason to exclude a person.
  assert.ok(!/MIN_YEAR_KNOWN/.test(importCode), 'the hard year gate must be gone');
  assert.match(importCode, /无年份者保留|含无年份者/, 'undated rows are kept');
  assert.match(importCode, /--years=/, 'a year window must be opt-in');
});

test('importer: 不再把年份分档写成 era 边', () => {
  // 旧实现把年份分档写成 `era` 边，而最后一档「隋唐及以后」吸收了 589 年以后所有人，
  // 占全部 era 边的 97.5%——它实际上是「不知道」。按设计 §2.6，只知道大致时期
  // 就写带区间的生卒日期，时代分类是查询时推导的产物。
  assert.ok(!/隋唐及以后/.test(importCode), '粗粒度朝代分档必须已删除');
  assert.ok(!/eraLabel/.test(importCode), '不得再有年份→朝代的分档变量');
  assert.ok(!/relations\['时代'\]/.test(importCode), '不得再写 era 边');
  assert.ok(!/年代不详/.test(importCode), 'unknown era must not be encoded as a value');
});
test('publish: the site carries only modern persons and all other types', () => {
  const site = path.join(ROOT, 'site', 'data');
  if (!fs.existsSync(site)) {
    // The site is a build product; absent it, there is nothing to check.
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(site, 'manifest.json'), 'utf8'));
  assert.equal(manifest.publish.filtered, true, 'site build must declare itself filtered');
  assert.equal(manifest.publish.personsFromYear, 1900);

  // Every published person must be dated 1900 or later. JDN 2415021 = 1900-01-01.
  //
  // The top-level manifest only carries counts; the page list lives in the
  // per-type manifest, which is what the browser fetches first.
  const personsManifest = JSON.parse(fs.readFileSync(path.join(site, 'persons', 'manifest.json'), 'utf8'));
  const rows = [];
  for (const page of personsManifest.pages) {
    const file = path.join(site, 'persons', page.file);
    rows.push(...JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const early = rows.filter((r) => {
    if (!r.lifespan) return true;
    const latest = r.lifespan.end ?? r.lifespan.start ?? r.lifespan.mid;
    return latest == null || latest < 2415021;
  });
  assert.deepEqual(early.slice(0, 5).map((r) => `${r.name} ${JSON.stringify(r.lifespan)}`), []);
  assert.ok(rows.length > 1000, `only ${rows.length} persons published`);
});
