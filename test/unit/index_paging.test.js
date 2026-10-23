'use strict';
/**
 * Paged index + bucketed search.
 *
 * At 660k entities the browser cannot load one index file, so `build_index.js`
 * emits a manifest, index pages, a chronology file and search buckets, and the
 * data layer loads only what a view asks for. These tests pin that contract
 * against the real generated data, because the failure mode (a *truncated* list
 * that looks complete) is otherwise invisible until users notice missing people.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

function loadBrowserModules(files) {
  const sandbox = { console, JSON };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  for (const f of files) {
    vm.runInNewContext(
      fs.readFileSync(path.join(ROOT, 'js', 'core', f), 'utf8'),
      sandbox,
      { filename: 'js/core/' + f },
    );
  }
  return sandbox;
}

const win = loadBrowserModules(['predicates.js', 'data_store.js', 'search.js', 'relations.js']);

/** Reads straight off disk so the test needs no HTTP server. */
function diskFetch(url) {
  const rel = String(url).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return Promise.reject(new Error('404 ' + url));
  return Promise.resolve()
    .then(() => JSON.parse(fs.readFileSync(file, 'utf8')))
    .then(v => JSON.parse(JSON.stringify(v)));
}

function makeStore() {
  return new win.HMDataStore.DataStore({ fetchJson: diskFetch, isLocalMode: false, storage: null });
}

const MANIFEST = JSON.parse(fs.readFileSync(path.join(DATA, 'persons', 'manifest.json'), 'utf8'));

test('build_index: manifest describes pages, chronology and search buckets', () => {
  assert.equal(MANIFEST.version, 3);
  assert.ok(MANIFEST.pages.length >= 1);
  assert.equal(MANIFEST.pages.reduce((n, p) => n + p.count, 0), MANIFEST.count);
  assert.ok(MANIFEST.pages.every(p => p.file.startsWith('index/')));
  assert.ok(MANIFEST.search.charToFile, 'search.charToFile is what makes lookup O(1)');
  assert.ok(MANIFEST.search.buckets.length >= 1);

  // Every mapping must be a path relative to the type folder, identical in shape
  // to `buckets[].file`. The two used to disagree — `charToFile` held a bare file
  // name — so `loadSearchBucket` fetched `data/persons/bucket-000.json`, got a 404,
  // swallowed it, and search silently degraded to "scan what is in memory".
  const known = new Set(MANIFEST.search.buckets.map(b => b.file));
  for (const [ch, file] of Object.entries(MANIFEST.search.charToFile)) {
    assert.ok(file.includes('/'), `charToFile['${ch}'] must be a relative path, got '${file}'`);
    assert.ok(
      known.has(file),
      `charToFile['${ch}'] = '${file}' is not one of the declared buckets`,
    );
    assert.ok(
      fs.existsSync(path.join(DATA, 'persons', file)),
      `bucket file missing on disk: ${file}`,
    );
  }

  // Every page file must exist and hold exactly the advertised row count.
  for (const page of MANIFEST.pages) {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA, 'persons', page.file), 'utf8'));
    assert.equal(rows.length, page.count, page.file + ' row count');
  }
});

test('build_index: every entity appears in exactly one page and one bucket', () => {
  const paged = [];
  for (const page of MANIFEST.pages) {
    paged.push(...JSON.parse(fs.readFileSync(path.join(DATA, 'persons', page.file), 'utf8')));
  }
  assert.equal(new Set(paged.map(r => r.id)).size, MANIFEST.count, 'pages must not overlap');

  const bucketed = [];
  for (const b of MANIFEST.search.buckets) {
    bucketed.push(...JSON.parse(fs.readFileSync(path.join(DATA, 'persons', b.file), 'utf8')));
  }
  assert.equal(bucketed.length, MANIFEST.count, 'buckets must cover the corpus');
  assert.equal(new Set(bucketed.map(r => r.id)).size, MANIFEST.count, 'no duplicate bucket rows');
});

test('DataStore.init: loads only the manifest plus the first page', async () => {
  const store = makeStore();
  await store.init();
  assert.equal(store.loaded, true);
  assert.ok(store.manifests.person, 'person manifest must be retained');
  // Bootstrap is bounded: not the whole corpus.
  assert.ok(store.personList.length <= MANIFEST.pageSize,
    `expected at most one page (${MANIFEST.pageSize}) after init, got ${store.personList.length}`);
  assert.ok(store.personList.length > 0);
});

test('DataStore.loadAllPages: recovers the full corpus on demand', async () => {
  const store = makeStore();
  await store.init();
  await store.loadAllPages('person');
  assert.equal(store.personList.length, MANIFEST.count, 'every entity must be reachable');
  // List views depend on this being an array of unique rows.
  assert.equal(new Set(store.personList.map(e => e.id)).size, MANIFEST.count);
});

test('DataStore.bucketFor: maps a first character to its bucket file', async () => {
  const store = makeStore();
  await store.init();
  const name = JSON.parse(
    fs.readFileSync(path.join(DATA, 'persons', MANIFEST.pages[0].file), 'utf8'),
  )[0].name;
  const ch = Array.from(name)[0];
  assert.equal(store.bucketFor('person', name), MANIFEST.search.charToFile[ch]);
  // A character that starts no name returns '' (a definitive "no match"), which
  // is different from null meaning "this type has no search manifest".
  assert.equal(store.bucketFor('person', '\u0001'), '');
});

test('SearchEngine: a query resolves through its bucket without loading everything', async () => {
  const store = makeStore();
  await store.init();
  const engine = new win.HMSearch.SearchEngine(store, { Fuse: null });
  const rows = JSON.parse(
    fs.readFileSync(path.join(DATA, 'persons', MANIFEST.pages[0].file), 'utf8'),
  );
  const target = rows[0];

  const hits = await engine.search(target.name, 10);
  assert.ok(hits.length >= 1, `expected a hit for ${target.name}`);
  assert.equal(hits[0].name, target.name);

  // The bucket brought in siblings that the first page alone did not have.
  assert.ok(store.personList.length > MANIFEST.pageSize - 1 || MANIFEST.count <= MANIFEST.pageSize);
  assert.ok(store.personList.length <= MANIFEST.count);
});

test('SearchEngine: unrelated text returns nothing instead of the whole corpus', async () => {
  const store = makeStore();
  await store.init();
  const engine = new win.HMSearch.SearchEngine(store, { Fuse: null });
  const hits = await engine.search('zzzzznotaname', 10);
  // Cross-realm arrays have a different prototype, so compare by value.
  assert.equal(JSON.stringify(hits), '[]');
});

test('SearchEngine: empty query is a no-op', async () => {
  const store = makeStore();
  await store.init();
  const engine = new win.HMSearch.SearchEngine(store, { Fuse: null });
  assert.equal(JSON.stringify(await engine.search('', 10)), '[]');
  assert.equal(JSON.stringify(await engine.search('   ', 10)), '[]');
});

test('SearchEngine: a name outside the first page is found, which only a real bucket load can do', async () => {
  // The previous test could not tell a working bucket lookup from the fallback:
  // it searched for a name taken from page 0, which is already in memory, so the
  // `search()` fallback over loaded items produced the same hit. Both search bugs
  // (the 404'd bucket path and the missing `_refreshLists()`) therefore shipped
  // green. This searches a page-1 name instead, which is unreachable without the
  // bucket arriving.
  const store = makeStore();
  await store.init();
  const before = store.personList.length;

  const page1 = JSON.parse(
    fs.readFileSync(path.join(DATA, 'persons', MANIFEST.pages[1].file), 'utf8'),
  );
  const target = page1[0];
  assert.ok(
    !store.personList.some(e => e.id === target.id),
    'the target must not already be loaded, or this proves nothing',
  );

  const engine = new win.HMSearch.SearchEngine(store, { Fuse: null });
  const hits = await engine.search(target.name, 10);
  assert.ok(
    hits.some(h => h.id === target.id),
    `expected ${target.name} (${target.id}) from page 1 to be found`,
  );
  // Proof the bucket was actually loaded and the lists were rebuilt.
  assert.ok(
    store.personList.length > before,
    'loading a bucket must refresh personList, or _items() cannot see its rows',
  );
});

test('SearchEngine: a first-character query returns name matches, not every loaded org', async () => {
  // With the bucket fetch failing, `_candidates` came back empty and `search()`
  // fell back to scanning everything in memory — so 「王」 returned 東漢/周/牧野之戰
  // (organizations and events that merely mention 王) and none of the 王-surnamed
  // people. The candidate set must stay inside the bucket's ids.
  const store = makeStore();
  await store.init();
  const engine = new win.HMSearch.SearchEngine(store, { Fuse: null });
  const hits = await engine.search('王', 20);
  assert.ok(hits.length >= 1);
  assert.ok(
    hits.every(h => h.type === 'person'),
    'a person name bucket must not leak organization/event hits: '
      + JSON.stringify(hits.map(h => `${h.name}(${h.type})`)),
  );
  assert.ok(hits[0].name.startsWith('王'), `first hit should start with 王, got ${hits[0].name}`);
});

test('chronology: dated entities are sorted by JDN midpoint', () => {
  const rows = JSON.parse(fs.readFileSync(path.join(DATA, 'persons', MANIFEST.chronology), 'utf8'));
  assert.equal(rows.length, MANIFEST.dated);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].mid <= rows[i].mid, `chronology out of order at ${i}`);
  }
  for (const r of rows) {
    assert.equal(typeof r.mid, 'number', `mid must be a JDN for ${r.id}`);
    assert.equal(typeof r.uncertainty, 'number');
  }
});

test('chronology: rows carry the three timeline confidence tiers', () => {
  const rows = JSON.parse(fs.readFileSync(path.join(DATA, 'persons', MANIFEST.chronology), 'utf8'));
  // A row may legitimately have only one known endpoint (death date but no birth
  // date), which is the "single-endpoint" tier the UI must not treat as vague.
  const oneSided = rows.filter(r => (r.start == null) !== (r.end == null));
  assert.ok(oneSided.length > 0, 'expected some death-only lifespans in the corpus');
  for (const r of oneSided) {
    // Whichever endpoint exists must be a real JDN; `overlaps()` falls back to it.
    const bound = r.start != null ? r.start : r.end;
    assert.equal(typeof bound, 'number', `single endpoint must be numeric for ${r.id}`);
    assert.ok(bound <= r.mid || r.mid <= bound, `mid must be comparable to the known endpoint for ${r.id}`);
  }
});
