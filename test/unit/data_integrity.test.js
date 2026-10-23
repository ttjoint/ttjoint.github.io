'use strict';
/**
 * Guards against silent coverage loss in the data pipeline.
 *
 * The paged index refactor introduced a class of bug that no existing test
 * caught: `index.json` became a *truncated* compatibility file, but validators
 * and importers still read it. `npm run check` stayed green while
 *   - validate_data checked 2000 of 5287 entities,
 *   - check_references resolved targets against a 2000-id universe,
 *   - the admin database seeded 2064 of 5351 entities,
 *   - importers merged new records into a partial index and wrote it back.
 *
 * Each of those is a *silent* failure: exit code 0, no exception, wrong data.
 * These tests therefore assert on the numbers and on the invariants, not just
 * on "does it run".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const reader = require(path.join(ROOT, 'src', 'store', 'data_reader'));
const writer = require(path.join(ROOT, 'src', 'store', 'entity_writer'));

// ---------------------------------------------------------------------------
// Cached corpus reads
// ---------------------------------------------------------------------------
//
// `readEntities`/`readAll` open one file per entity. That was fine for the 7k-entity
// corpus these tests were written against; at 486k shards a single call takes ~78 s,
// and the assertions below make thirteen of them. The suite did not fail, it hit the
// per-test timeout, which reads as "the checker is broken".
//
// The data does not change during a test run, so reading once is both correct and
// the difference between a 3-minute file and a half-hour one.
const corpusCache = new Map();
function corpus(folder) {
  if (!corpusCache.has(folder)) corpusCache.set(folder, reader.readEntities(folder));
  return corpusCache.get(folder);
}
const writerCache = new Map();
function entityAll(type) {
  if (!writerCache.has(type)) writerCache.set(type, writer.readAll(type));
  return writerCache.get(type);
}

/** Run a script and return its combined output, optionally tolerating a failure. */
function run(script, opts = {}) {
  try {
    return execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The corpus is 486k shards, and `check_references` must open every one of them:
      // edges live only in the shards, not in the index, so it cannot be sped up the
      // way the read-only assertions in this file were. The default 200 s budget was
      // sized for a 7k-entity corpus and now expires mid-run, which looks like a
      // failure of the checker rather than of the clock.
      timeout: opts.timeout || 30 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (opts.allowFailure) return String(e.stdout || '') + String(e.stderr || '');
    throw e;
  }
}

test('index.json is smaller than the corpus, so reading it alone loses data', () => {
  const total = corpus('persons').length;
  const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'persons', 'index.json'), 'utf8'));
  const rows = Array.isArray(legacy) ? legacy : legacy.rows;
  // The whole point of the guard: if these are ever equal, this test is moot,
  // but while it holds, anything reading only index.json is under-counting.
  assert.ok(rows.length < total, `index.json (${rows.length}) should be a page, corpus is ${total}`);
});

test('data_reader returns the complete corpus, not the first index page', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'persons', 'manifest.json'), 'utf8'),
  );
  const entities = corpus('persons');
  const rows = reader.readIndexRows('persons');
  assert.equal(entities.length, manifest.count);
  assert.equal(rows.length, manifest.count);
});

test('validate_data checks every entity', () => {
  // This asserts COVERAGE, not cleanliness. It previously required the exact
  // line `validate_data: N entities OK`, which conflated the two: the moment a
  // real defect was detected (hollow shards) this test failed, making the
  // validator look broken rather than the data. Data cleanliness is asserted by
  // the `no shard is hollow` / `no shard carries a generated field` tests.
  //
  // `run` allows a non-zero exit here; the point is that the report covers the
  // whole corpus.
  const output = run('validate_data.js', { allowFailure: true });
  const total = reader.allFolders()
    .reduce((n, f) => n + corpus(f).length, 0);
  assert.match(
    output,
    new RegExp(`validate_data: ${total} entities (OK|checked)`),
    'the validator must report every entity',
  );
  for (const folder of reader.allFolders()) {
    const type = reader.typeOf(folder);
    assert.ok(output.includes(`${folder}:`), `validator skipped ${type}`);
  }
});

test('check_references actually inspects something', () => {
  const output = run('check_references.js');
  const m = output.match(/references checked: (\d+)/);
  assert.ok(m, 'expected a reference count in the output');
  // The old version reported "0 across 2064" and passed. Zero means the checker
  // is looking at the wrong place, not that the data is clean.
  assert.ok(Number(m[1]) > 0, `checker inspected ${m[1]} references — it is not looking at real relations`);
});

test('no script writes the generated index.json', () => {
  // index.json is output of build_index.js. Any other writer would corrupt it.
  const scriptsDir = path.join(ROOT, 'scripts');
  const offenders = [];
  for (const file of fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js'))) {
    if (file === 'build_index.js') continue;
    const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    // Look for a write whose path expression mentions index.json.
    const re = /writeFileSync\([^)]*index\.json/;
    if (re.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'these scripts must write entity shards, not index.json');
});

test('entity_writer round-trips without losing entities', () => {
  const before = entityAll('person');
  const stats = writer.upsertAll('person', []);
  assert.equal(stats.added, 0);
  assert.equal(stats.total, before.length, 'a no-op upsert must not change the entity count');
  const ids = new Set(entityAll('person').map((e) => e.id));
  for (const e of before) assert.ok(ids.has(e.id), `lost ${e.id} during round-trip`);
});

test('entity_writer merges curated data and appends sources', () => {
  // Exercise the real merge rule, not a re-implementation of it. The previous
  // version copied the algorithm into the test and asserted its own output,
  // so it passed even when defaultMerge was broken.
  const { defaultMerge } = require('../../src/store/entity_writer');
  const prev = { id: 'person:test', name: '测试', props: { 性别: '男' }, sources: [{ url: 'a' }] };
  const rec = { id: 'person:test', name: '测试', props: { 出生年月: '1900' }, sources: [{ url: 'b' }] };

  const merged = defaultMerge(prev, rec);
  assert.equal(merged.props['性别'], '男', 'curated props must win');
  assert.equal(merged.props['出生年月'], '1900', 'new props are added');
  assert.equal(merged.sources.length, 2, 'new sources are appended, not dropped');
});

test('entity_writer can replace sources, which a migration needs', () => {
  // Rewriting source objects into evidence ids is unrecoverable without this:
  // the union re-adds the inline objects the migration just removed, so the next
  // write silently undoes it. This actually bit the evidence migration.
  const { defaultMerge } = require('../../src/store/entity_writer');
  const prev = { id: 'person:t', sources: [{ url: 'a' }, { url: 'b' }] };
  const rec = { id: 'person:t', sources: ['evidence:1'] };

  const union = defaultMerge(prev, rec);
  assert.equal(union.sources.length, 3, 'default behaviour is a union');

  const replaced = defaultMerge(prev, rec, { replaceSources: true });
  assert.deepEqual(replaced.sources, ['evidence:1']);
});

test('entity_writer accepts a corrected claims field', () => {
  // `claims` holds structured data that importers recompute. If the merge lets
  // `prev` win on it, a corrected position is discarded and upsertAll reports
  // updated: 0 for a record that really did change.
  const { defaultMerge } = require('../../src/store/entity_writer');
  const prev = { id: 'person:t', claims: { currentPositions: [{ organization: '甲', role: '' }] } };
  const rec = { id: 'person:t', claims: { currentPositions: [{ organization: '乙', role: '委员' }] } };
  const merged = defaultMerge(prev, rec);
  assert.equal(merged.claims.currentPositions[0].organization, '乙');
  assert.equal(merged.claims.currentPositions[0].role, '委员');
});

// ---------------------------------------------------------------------------
// Evidence migration invariants.
//
// These assert the *result* of moving inline sources into evidence nodes, on the
// real corpus. A migration that silently dropped half the citations, or left
// references pointing at nodes that were never written, would still pass every
// schema check — so the invariants have to be stated explicitly.
// ---------------------------------------------------------------------------

test('every source reference resolves to a real evidence node', () => {
  const evidence = new Set(corpus('evidence').map((e) => e.id));
  const sources = require('../../src/store/sources');
  const dangling = [];
  let refs = 0;
  for (const folder of reader.allFolders()) {
    if (folder === 'evidence') continue;
    for (const e of corpus(folder)) {
      for (const s of sources.listSources(e)) {
        if (s.kind !== 'evidence') continue;
        refs++;
        if (!evidence.has(s.id)) dangling.push(`${e.id} -> ${s.id}`);
      }
    }
  }
  assert.ok(refs > 0, 'no evidence references found — the migration did not run');
  assert.deepEqual(dangling, []);
});

test('no entity still holds an inline source object', () => {
  // The migration is only complete when the old shape is gone. Leaving a mix
  // means two code paths stay alive and `sources[0].url` silently returns
  // undefined for half the corpus.
  const sources = require('../../src/store/sources');
  const offenders = [];
  for (const folder of reader.allFolders()) {
    if (folder === 'evidence') continue;
    for (const e of corpus(folder)) {
      const inline = sources.listSources(e).filter((s) => s.kind === 'inline');
      if (inline.length) offenders.push(`${e.name} (${inline.length})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every evidence node has a carrier that exists', () => {
  // An evidence node with a dangling carrier is worse than an unresolved one:
  // it claims attribution to a body that is not in the graph.
  //
  // This test used to pass while every single carrier was wrong. `carrier` is a
  // bare entity reference that lives outside `relations` and `sources`, so the id
  // migration rewrote all the edges and none of the carriers — and because the
  // local-id allocator renumbered things in the same run, the stale ids still
  // resolved to *something* (`thing:local-000008` instead of `thing:local-000007`).
  // Existence was never the property worth checking.
  const byId = new Map();
  for (const folder of reader.allFolders()) {
    for (const e of corpus(folder)) byId.set(e.id, e);
  }

  const broken = [];
  for (const e of corpus('evidence')) {
    if (!e.carrier) continue;
    const carrier = byId.get(e.carrier);
    if (!carrier) {
      broken.push(`${e.name} -> ${e.carrier} (不存在)`);
      continue;
    }
    // A carrier is a publication or a body, never a person or another citation.
    if (!['thing', 'organization'].includes(carrier.type)) {
      broken.push(`${e.name} -> ${carrier.name} (${carrier.type})`);
    }
    // And it must be the publisher that actually hosts the cited URL. The corpus
    // describes domains only in prose (`简介`), so the mapping is pinned here; a
    // test that has to be updated when a carrier changes is the point.
    const host = (String(e.url || '').match(/^https?:\/\/([^/]+)/) || [])[1];
    const allowed = CARRIER_HOSTS[carrier.name];
    if (host && !allowed) {
      broken.push(`${e.name} -> ${carrier.name} (该载体未登记归属域名)`);
    } else if (host && !allowed.includes(host)) {
      broken.push(`${e.name} -> ${carrier.name} @ ${host}`);
    }
  }
  assert.deepEqual(broken.slice(0, 10), []);

  // The mapping has to stay a bijection: two carriers claiming one host would
  // mean one of them is wrong, and the test above could not tell which.
  const seen = new Map();
  for (const [name, hosts] of Object.entries(CARRIER_HOSTS)) {
    for (const h of hosts) {
      assert.ok(!seen.has(h), `${h} claimed by both ${seen.get(h)} and ${name}`);
      seen.set(h, name);
    }
  }
});

// Which publisher each carrier stands for. Written out rather than derived: the
// shards record domains only in prose, and guessing from text is how a check
// turns into a tautology.
const CARRIER_HOSTS = {
  '中国人民政治协商会议全国委员会': ['www.cppcc.gov.cn'],
  '中国共产党新闻网': ['cpc.people.com.cn'],
  '中国政府网': ['www.gov.cn'],
  '最高人民检察院': ['www.spp.gov.cn'],
  '人民网': ['www.people.com.cn', 'paper.people.com.cn'],
};

test('evidence ids are unique and derived from content', () => {
  const ev = corpus('evidence');
  assert.equal(new Set(ev.map((e) => e.id)).size, ev.length, 'duplicate evidence ids');
  // Two evidence nodes must never share a URL: distinct citations of one page
  // are one citation, and the migration is supposed to collapse them.
  const urls = ev.map((e) => e.url).filter(Boolean);
  const dupes = urls.filter((u, i) => urls.indexOf(u) !== i);
  assert.deepEqual(dupes, [], `same URL became several evidence nodes: ${dupes.slice(0, 3)}`);
});

test('graph exposes evidence as nodes with carriedBy edges', () => {
  const { loadGraph } = require('../../src/store/graph_source');
  const g = loadGraph();
  const evidence = [...g.nodes.values()].filter((n) => n.type === 'evidence');
  assert.ok(evidence.length > 0, 'evidence nodes are missing from the graph');
  const carried = g.byPredicate.get('carriedBy') || [];
  assert.equal(carried.length, evidence.length, 'each evidence node needs one carriedBy edge');
  for (const e of evidence) {
    assert.ok(g.nodes.has(e.carrier), `carrier of ${e.name} is not a node`);
  }
});

test('entity_writer does not re-add an inline source for an already-cited url', () => {
  // The review database (SQLite) is seeded before the sources→evidence
  // migration, so it still holds the pre-migration inline objects while the
  // shards hold references. `npm run publish` merged them and every entity
  // citing a migrated article got the old object appended back: 114 inline
  // sources reappeared and the migration looked undone on disk.
  const { defaultMerge } = require('../../src/store/entity_writer');
  const evidenceUrl = { 'evidence:abc': 'https://example.org/a' };
  const prev = { id: 'person:t', sources: ['evidence:abc'] };
  const rec = { id: 'person:t', sources: [{ name: '某站', url: 'https://example.org/a' }] };

  const merged = defaultMerge(prev, rec, { sourcesAudit: true, evidenceUrl });
  assert.deepEqual(merged.sources, ['evidence:abc'], 'the reference must win over its old inline copy');
});

test('entity_writer keeps an inline source the record cites but the shard does not', () => {
  // The audit guard must only drop *duplicates*. A citation the shard has never
  // seen is new information and has to survive, otherwise `publish` silently
  // loses sources added through the review UI.
  const { defaultMerge } = require('../../src/store/entity_writer');
  const evidenceUrl = { 'evidence:abc': 'https://example.org/a' };
  const prev = { id: 'person:t', sources: ['evidence:abc'] };
  const rec = {
    id: 'person:t',
    sources: [{ name: '新出处', url: 'https://example.org/b' }],
  };

  const merged = defaultMerge(prev, rec, { sourcesAudit: true, evidenceUrl });
  assert.equal(merged.sources.length, 2, 'a genuinely new source must not be dropped');
  assert.equal(merged.sources[0], 'evidence:abc');
  assert.equal(merged.sources[1].url, 'https://example.org/b');
});

test('entity_writer deduplicates inline sources by url', () => {
  const { defaultMerge } = require('../../src/store/entity_writer');
  const prev = { id: 'person:t', sources: [{ name: '甲', url: 'https://example.org/a' }] };
  const rec = { id: 'person:t', sources: [{ name: '甲（不同标签）', url: 'https://example.org/a' }] };
  const merged = defaultMerge(prev, rec);
  assert.equal(merged.sources.length, 1, 'one url is one source whatever the label');
});

// ---------------------------------------------------------------------------
// Shard integrity: the authoritative store must not look like an index row.
//
// `shard_data.js` (since deleted) split index.json into summaries plus shards,
// then overwrote index.json with those summaries. Running it a second time read
// the summaries back and wrote them out AS entities: 5269 shards lost their
// props and kept a `detail` field that only build_index.js is supposed to
// produce. Nothing detected it — every existing check passed, because every
// check asked "does it parse", not "is this an entity".
// ---------------------------------------------------------------------------

test('validate_data rejects an entity carrying a generated field', () => {
  // Static check on the source: the rule must exist at all. The live corpus is
  // checked separately below, and the two failure modes are different (a rule
  // that was removed vs. data that violates it).
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'validate_data.js'), 'utf8');
  assert.ok(/GENERATED_FIELDS/.test(src), 'validate_data must define generated fields');
  assert.ok(/'detail'/.test(src), '`detail` must be listed as generated');
});

test('validate_data treats a contentless entity as an error, but not evidence', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'validate_data.js'), 'utf8');
  // The predicate itself lives in src/store/entity_shape.js so the validator and
  // this suite cannot drift apart; here we only assert it is wired up.
  assert.ok(/require\('\.\.\/src\/store\/entity_shape'\)/.test(src),
    'validate_data must use the shared shape predicate');
  assert.ok(/isHollow/.test(src), 'validate_data must check for hollow entities');

  const shape = require(path.join(ROOT, 'src', 'store', 'entity_shape'));
  // An evidence node's payload is carrier/medium/url, not props. A blanket rule
  // would mark all 111 evidence nodes broken and the check would be turned off.
  assert.equal(shape.isHollow({ id: 'evidence:x', name: 'x' }, 'evidence'), false,
    'evidence must be exempt from the hollow rule');
  assert.equal(shape.isHollow({ id: 'person:x', name: 'x', props: {} }, 'person'), true,
    'a person with empty props and no relations is hollow');
  // The distinction that matters: hollow + the index-row fingerprint is damage;
  // hollow with no fingerprint is a gap to fill, however aliases look.
  assert.equal(shape.wasWrittenFromIndex({ detail: 'entities/x.json' }), true,
    'a shard carrying `detail` came from an index row');
  assert.equal(shape.isDamaged({ id: 'event:x', name: 'x', props: {}, detail: 'entities/x.json' }, 'event'), true,
    'hollow plus an index fingerprint is damage');
  assert.equal(shape.isDamaged({ id: 'event:x', name: 'x', props: {}, aliases: ['y'] }, 'event'), false,
    'a hand-entered skeleton must not read as round-trip damage');
  assert.equal(shape.isSkeleton({ id: 'event:x', name: 'x', props: {} }, 'event'), true,
    'a hollow entity with no fingerprint is a gap, not damage');
  assert.equal(shape.isDamaged({ id: 'person:x', name: 'x', props: {}, detail: 'd' }, 'evidence'), false,
    'evidence is exempt even with a fingerprint');
});

test('no shard carries a generated `detail` field', () => {
  // Runs against the real corpus so a regression is caught by `npm test`, not
  // only by `npm run validate`.
  const offenders = [];
  for (const folder of reader.allFolders()) {
    for (const x of corpus(folder)) {
      if ('detail' in x) offenders.push(`${folder}:${x.id}`);
    }
  }
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} shards carry a generated field`);
});

test('no shard is damaged (hollow without being a known skeleton)', () => {
  // Same predicate as validate_data.js. A hand-entered skeleton (no props but
  // with aliases) is a data gap, not the index->shard round trip that hollowed
  // 5269 shards. Keeping a second copy of the rule here would let the test stay
  // green while the validator was quietly relaxed.
  const shape = require(path.join(ROOT, 'src', 'store', 'entity_shape'));
  const offenders = [];
  for (const folder of reader.allFolders()) {
    const type = reader.typeOf(folder);
    for (const x of corpus(folder)) {
      if (shape.isDamaged(x, type)) offenders.push(`${folder}:${x.name || x.id}`);
    }
  }
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} shards are damaged`);
});

test('admin_server refreshes an existing database instead of only seeding a new one', () => {
  // The audit SQLite used to be seeded only `if (isNew)`. It then drifted: after
  // a re-import repaired the shards, `npm run publish` exported the stale rows
  // back over them — reported as "5269 files changed" — undoing the repair. The
  // guard is that a non-first run has an explicit refresh path.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'admin_server.js'), 'utf8');
  assert.ok(/function refreshFromShards/.test(src), 'admin_server must expose a refresh path');
  assert.ok(/--refresh/.test(src), 'refresh must be reachable without editing code');
  // Overwriting rows is opt-in: the database has no "reviewer edited this" flag,
  // so an unconditional rewrite from disk could discard review work.
  assert.ok(/--from-shards/.test(src), 'overwriting existing rows must be opt-in');
});

test('import_cbdb keys entities by the CBDB row, never by the name', () => {
  // Three separate defects used to live here, all downstream of one mistake: the
  // importer treated a person's *name* as their identity.
  //
  //   1. `id: uniqueName` — the bare name was the id, so a second 王雅 could not
  //      exist and a re-run minted a duplicate file for the same person.
  //   2. `MAX_PERSONS = 5000` sliced in database order, so a re-import repaired
  //      1209 of 5205 hollow shards and never the same ones twice.
  //   3. Per-name counters (`劉環雋（1）`) decided which existing shard to adopt,
  //      but the counted name did not match the bare name on disk — so instead of
  //      filling the hollow shard it forked a twin. 163 cbdbIds ended up owning
  //      two entities each.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'import_cbdb.js'), 'utf8');

  // The identity now comes from the source's own primary key.
  assert.ok(/cbdbPersonId\(pid\)/.test(src), 'persons must be keyed by c_personid');
  assert.ok(!/personId\(/.test(src), 'no name-derived person ids may remain');
  assert.ok(!/id: uniqueName/.test(src), 'the name itself must never be the id');
  assert.ok(!/nameIndex|claimedIds|existingByName/.test(src),
    'the name-collision workaround must be deleted, not merely bypassed');

  // The name is still written, as an ordinary repeatable field.
  assert.ok(/^\s+name,$/m.test(src), 'the name must still be stored');

  assert.ok(!/MAX_PERSONS = 5000/.test(src), 'the hard 5000 cap must be gone');
  assert.ok(/--limit=/.test(src), 'a cap must be opt-in');

  // c_notes is CBDB's scholarly apparatus, not a biography.
  assert.ok(!/props: \{[^}]*'简介': buildDescription/.test(src) || !/c_notes\) parts\.push/.test(src),
    'c_notes must not be concatenated into the summary');

  // 295 CBDB association rows have no registered predicate. Folding them into a
  // catch-all produced 109 edges literally keyed '其他', which no registry can
  // invert or label.
  assert.ok(!/= ASSOC_CODE_MAP\[assocCode\] \|\|/.test(src),
    'unmapped associations must be skipped, not relabelled');
  assert.ok(/association rows have no registered predicate|无对应谓词的社会关系/.test(src),
    'skipped associations must be reported, not silently dropped');
});

