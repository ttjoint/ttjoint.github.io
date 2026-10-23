'use strict';
/**
 * Browser data layer: entity cache + relation grouping, exercised in Node with a
 * fake fetch and a fake localStorage. These are the pieces that silently break
 * when index files change shape, so they get direct coverage instead of only
 * being reached through the UI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('node:vm');

function loadBrowserModules(files) {
  const sandbox = { console, JSON, fetch: undefined };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  for (const f of files) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', f), 'utf8'), sandbox);
  }
  return sandbox;
}

const win = loadBrowserModules(['predicates.js', 'data_store.js', 'relations.js', 'search.js', 'source_parser.js']);

function fakeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
  };
}

function makeStore(payload = {}) {
  const fetchJson = async url => {
    const key = Object.keys(payload).find(k => url.includes(k));
    if (!key) throw new Error('404 ' + url);
    return JSON.parse(JSON.stringify(payload[key]));
  };
  return new win.HMDataStore.DataStore({ fetchJson, storage: fakeStorage(), isLocalMode: false });
}

const INDEX = {
  'persons/index.json': [
    { id: 'person:a', name: '甲', type: 'person', props: {} },
    { id: 'person:b', name: '乙', type: 'person', props: {} },
  ],
  'organizations/index.json': [
    { id: 'org:x', name: '某部', type: 'organization', props: {} },
  ],
  'events/index.json': [],
};

test('data store: init loads the three indexes and lists them', async () => {
  const store = makeStore(INDEX);
  await store.init();
  assert.equal(store.personList.length, 2);
  assert.equal(store.orgList.length, 1);
  assert.equal(store.eventList.length, 0);
  assert.equal(store.getType('org:x'), 'organization');
  assert.equal(store.getType('missing'), 'unknown');
  assert.equal(store.resolveName('person:a'), '甲');
  assert.equal(store.resolveName('missing'), 'missing');
});

test('data store: a missing index degrades to empty, it does not throw', async () => {
  const store = makeStore({ 'persons/index.json': [{ id: 'person:a', name: '甲', type: 'person' }] });
  await store.init();
  assert.equal(store.personList.length, 1);
  // A missing index yields an empty list rather than an error.
  assert.equal(store.orgList.length, 0);
});

test('data store: resolveRef understands 【id】 and 【id|type】', async () => {
  const store = makeStore(INDEX);
  await store.init();
  const ref = store.resolveRef('【person:a】');
  // Objects built inside the sandbox have another realm's prototype, so assert
  // on the fields instead of deepEqual.
  assert.equal(ref.id, 'person:a');
  assert.equal(ref.name, '甲');
  assert.equal(ref.type, 'person');
  assert.equal(ref.explicitType, null);
  // Explicit type survives when the target is not loaded yet.
  const r = store.resolveRef('【person:ghost|组织】');
  assert.equal(r.id, 'person:ghost');
  assert.equal(r.type, 'organization');
  // Plain text is not a reference.
  assert.equal(store.resolveRef('普通文本'), null);
  assert.equal(store.resolveRef(''), null);
});

test('data store: a CBDB citation in 【】 is text, not a link', async () => {
  // CBDB uses 【】 as an ordinary Chinese quotation bracket in `史料注记`:
  //   【參考《清代人物生卒年表》#21525.】
  // Treating that as a reference produced a clickable tag linking to
  // /person/參考《清代人物生卒年表》#21525, which rendered “未找到该实体”. All 2,655
  // 【】 spans in the published props are this shape and none is a reference.
  const store = makeStore(INDEX);
  await store.init();
  for (const text of [
    '【參考《清代人物生卒年表》#21525.】',
    '【參考《清代人物生卒年表》#17056.】',
    '【蜀汉】',       // name, not an id
    '【person:】',     // empty slug
    '【person:a b】',  // a space is not part of an id
  ]) {
    assert.equal(store.resolveRef(text), null, `should not linkify: ${text}`);
  }
});

test('data store: a 【】 span inside a longer note is left alone', async () => {
  // `resolvedProps` scans with a global regex, so an embedded citation must not
  // match either. The anchors here are what make that hold.
  const store = makeStore(INDEX);
  await store.init();
  const note =
    'Yu(1) Yue(2) [30237] CHECK biographical sources cited. 《清代人物生卒年表》原注：「…」。' +
    '【參考《清代人物生卒年表》#17056.】';
  assert.equal(store.resolveRef(note), null);
});

test('data store: an unloaded reference takes its type from the id prefix', async () => {
  // The shard has not been fetched, so getEntity misses. Falling back to
  // 'unknown' made typeRoute('unknown', …) default to the person route, sending a
  // person click to the wrong page for organization/event/thing targets.
  const store = makeStore(INDEX);
  await store.init();
  const r = store.resolveRef('【organization:not-loaded-yet】');
  assert.equal(r.id, 'organization:not-loaded-yet');
  assert.equal(r.type, 'organization');
  // name falls back to the id so the tag is never blank.
  assert.equal(r.name, 'organization:not-loaded-yet');
});

test('relations: synonyms collapse onto one canonical predicate', () => {
  const store = makeStore(INDEX);
  const rm = new win.HMRelations.RelationManager(store, { predicates: win.HMPredicates });
  assert.equal(rm.canonicalKey('爸爸'), 'father');
  assert.equal(rm.canonicalKey('父亲/negate'), 'father/negate');
  assert.equal(rm.canonicalKey('不是词'), null);
});

test('relations: inverseKey mirrors the base and keeps modifiers', () => {
  const store = makeStore(INDEX);
  const rm = new win.HMRelations.RelationManager(store, { predicates: win.HMPredicates });
  assert.equal(rm.inverseKey('父亲'), 'childOfFather');
  assert.equal(rm.inverseKey('父亲/negate'), 'childOfFather/negate');
  assert.equal(rm.inverseKey('所属组织'), 'hasMember');
  // Attributes have no inverse and must not invent one.
  assert.equal(rm.inverseKey('性别'), null);
});

test('relations: grouping labels, flags and unresolved words', async () => {
  const store = makeStore(INDEX);
  await store.init();
  const rm = new win.HMRelations.RelationManager(store, { predicates: win.HMPredicates });
  const grouped = rm.group({
    id: 'person:a',
    relations: {
      '爸爸': ['person:b'],
      '所属组织/negate': [{ target: 'org:x', role: '部长' }],
      '???': ['person:b'],
    },
  });
  assert.equal(grouped.groups.length, 2);
  const father = grouped.groups.find(g => g.key === 'father');
  assert.equal(father.label, '父亲');
  assert.equal(father.rows[0].name, '乙');
  assert.equal(father.negated, false);
  const member = grouped.groups.find(g => g.key === 'memberOf/negate');
  assert.equal(member.negated, true);
  assert.equal(member.rows[0].role, '部长');
  assert.equal(member.rows[0].name, '某部');
  // Unknown words are surfaced, never silently swallowed.
  assert.equal(JSON.stringify(grouped.unresolved), JSON.stringify(['???']));
});

test('relations: searching 儿子 only returns male children', async () => {
  const store = makeStore(INDEX);
  await store.init();
  const rm = new win.HMRelations.RelationManager(store, { predicates: win.HMPredicates });
  const entities = [
    { id: 'person:a', name: '甲', relations: { '儿子/negate': ['person:b'] } },
    { id: 'person:b', name: '乙', relations: { '女儿': ['person:a'] } },
  ];
  const sons = rm.searchByGender(entities, '儿子', 'male');
  assert.equal(sons.length, 1);
  assert.equal(sons[0].entity.name, '甲');
  // Asking for daughters must not return the sons.
  const daughters = rm.searchByGender(entities, '女儿', 'female');
  assert.equal(daughters.length, 1);
  assert.equal(daughters[0].entity.name, '乙');
});

test('relations: 没有写路径（反向关系靠查询时推导）', async () => {
  // 曾有 syncInverseRelations / cleanupReferences：改 A 的关系就顺手改 B，
  // 两处都写进 localStorage 覆盖层，都没有 provenance。
  //
  // 已删除。反向关系在查询时由谓词的 `inverse` 推导（predicates.js 的 `/反`
  // 修饰符），不在存储层冗余——文档 §8.3 实测过 5,216 对纯冗余反向边。
  const store = makeStore(INDEX);
  store.isLocalMode = true;
  await store.init();
  const rm = new win.HMRelations.RelationManager(store, { predicates: win.HMPredicates });

  assert.equal(typeof rm.syncInverseRelations, 'undefined');
  assert.equal(typeof rm.cleanupReferences, 'undefined');
  assert.equal(typeof rm._addInverse, 'undefined');
  assert.equal(typeof rm._removeInverse, 'undefined');
  // 只读方法必须还在：group 给详情页分组关系，inverseKey 给 `/反` 用。
  assert.equal(typeof rm.group, 'function');
  assert.equal(typeof rm.inverseKey, 'function');
});

test('DataStore: 没有 saveEntity / deleteEntity', async () => {
  // 前端写路径已删除：写进去的数据没有 provenance、没有 commitId，
  // 刷新别人的视角也看不到。写路径只在第 0 层（raw/）。
  const store = makeStore(INDEX);
  await store.init();
  assert.equal(typeof store.saveEntity, 'undefined');
  assert.equal(typeof store.deleteEntity, 'undefined');
});

// ---------------------------------------------------------------- search & source

test('search: falls back to substring matching when Fuse is unavailable', async () => {
  const store = makeStore(INDEX);
  await store.init();
  const se = new win.HMSearch.SearchEngine(store, { Fuse: null });
  const hits = await se.search('甲');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'person:a');
  assert.equal((await se.search('不存在的名字')).length, 0);
  // An empty query returns nothing rather than everything.
  assert.equal((await se.search('')).length, 0);
});

test('search: searchNow works over what is already loaded, without fetching', () => {
  const store = makeStore(INDEX);
  const se = new win.HMSearch.SearchEngine(store, { Fuse: null });
  // No init() call: the engine reads the store's current lists directly.
  assert.equal(se.searchNow('甲').length, 0);
});

test('search: invalidateCache drops cached fuzzy indexes', async () => {
  const store = makeStore(INDEX);
  await store.init();
  const se = new win.HMSearch.SearchEngine(store, { Fuse: null });
  await se.search('甲');
  se._fuseByKey['x'] = {};
  se.invalidateCache();
  assert.equal(Object.keys(se._fuseByKey).length, 0);
});

test('search: concurrent keystrokes do not throw', async () => {
  const store = makeStore(INDEX);
  await store.init();
  const se = new win.HMSearch.SearchEngine(store, { Fuse: null });
  // The UI fires these in parallel while the user types.
  const results = await Promise.all([se.search('甲'), se.search('乙'), se.search('丙')]);
  assert.equal(results.length, 3);
});

test('source parser: relation words become predicates, others stay props', async () => {
  const store = makeStore(INDEX);
  await store.init();
  const sp = new win.HMSource.SourceParser(win.HMPredicates);
  const entity = sp.parse([
    '名称：甲',
    '别名：老甲',
    '性别：男',
    '父亲：【person:b】',
    '所属组织：【org:x】 | 部长 | 2001年 | 2005年',
    '备注：随便写的一句话',
  ].join('\n'), 'person');

  assert.equal(entity.name, '甲');
  assert.equal(entity.props['性别'], '男');
  assert.equal(entity.props['备注'], '随便写的一句话');
  assert.equal(entity.relations['父亲'][0], 'person:b');
  assert.equal(entity.relations['所属组织'][0].role, '部长');
  assert.equal(entity.relations['所属组织'][0].start, '2001年');
  assert.equal(entity.relations['所属组织'][0].end, '2005年');
});

test('source parser: stringify round-trips through parse', () => {
  const sp = new win.HMSource.SourceParser(win.HMPredicates);
  const original = {
    name: '甲', aliases: ['老甲'], tags: ['测试'],
    props: { '性别': '男' },
    relations: { '父亲': ['person:b'], '所属组织': [{ target: 'org:x', role: '部长', start: '2001年', end: '2005年' }] },
    sources: [{ name: '某来源', date: '2026年' }],
  };
  const back = sp.parse(sp.stringify(original), 'person');
  assert.equal(back.name, original.name);
  assert.equal(back.props['性别'], '男');
  assert.equal(back.relations['父亲'][0], 'person:b');
  assert.equal(back.relations['所属组织'][0].role, '部长');
  assert.equal(back.aliases.length, 1);
  assert.equal(back.sources.length, 1);
});

test('source parser: evidence-id sources do not stringify to empty lines', () => {
  // After the evidence migration `sources` holds ids. Reading .name off a string
  // produced bare "源：" lines, so an exported entity lost every citation and
  // re-parsing it yielded empty entries.
  const sp = new win.HMSource.SourceParser(win.HMPredicates);
  const entity = {
    name: '甲',
    relations: {},
    sources: ['evidence:aaa', 'evidence:bbb'],
  };
  const text = sp.stringify(entity);
  const sourceLines = text.split('\n').filter((l) => l.startsWith('源：'));
  assert.equal(sourceLines.length, 2);
  for (const line of sourceLines) {
    assert.ok(line.length > '源：'.length, `empty source line: ${JSON.stringify(line)}`);
    assert.ok(line.includes('evidence:'), `source id lost: ${line}`);
  }
});

test('source parser: string sources survive a round trip', () => {
  const sp = new win.HMSource.SourceParser(win.HMPredicates);
  const entity = { name: '乙', relations: {}, sources: ['evidence:ccc'] };
  const back = sp.parse(sp.stringify(entity), 'person');
  assert.ok(Array.isArray(back.sources));
  assert.equal(back.sources.length, 1);
  // Whatever shape the parser produces, the id must still be findable in it —
  // that is what makes the export lossless.
  const flat = JSON.stringify(back.sources);
  assert.ok(flat.includes('evidence:ccc'), `round trip lost the id: ${flat}`);
});

test('loadEntity fetches a shard for an entity outside the preloaded page', async () => {
  // Only the first index page is preloaded, so `getEntity` returns null for most
  // of the corpus. loadEntity used to bail out in that case, and the detail view
  // then fabricated `{name: id}` and SAVED it — overwriting the real record.
  const store = makeStore(INDEX);
  await store.init();
  const outsideId = 'person:ffffffffffffffffffff';
  assert.equal(store.getEntity(outsideId), null, 'precondition: not preloaded');

  const shard = { id: outsideId, type: 'person', name: '真实姓名', props: {}, relations: {}, sources: [] };
  const fetched = [];
  store.fetchJson = (url) => {
    fetched.push(url);
    return Promise.resolve(shard);
  };

  const got = await store.loadEntity(outsideId);
  assert.ok(got, 'loadEntity returned nothing for an un-preloaded entity');
  assert.equal(got.name, '真实姓名');
  // The path must be derived from the id, and must keep the shard naming rule.
  assert.equal(fetched.length, 1);
  assert.ok(
    fetched[0].includes(`entities/${encodeURIComponent(outsideId)}.json`),
    `unexpected shard path: ${fetched[0]}`,
  );
});

test('loadEntity reports a genuinely missing entity instead of inventing one', async () => {
  const store = makeStore(INDEX);
  await store.init();
  store.fetchJson = () => Promise.reject(new Error('404'));
  const got = await store.loadEntity('person:00000000000000000000');
  assert.equal(got, null, 'a missing entity must stay missing, not become a stub');
});

test('getType returns the literal unknown, which callers must handle', () => {
  // This is the trap that made the loadEntity fix silently ineffective: the
  // guard `if (!type)` never fires because 'unknown' is truthy.
  const store = makeStore(INDEX);
  assert.equal(store.getType('person:not-loaded'), 'unknown');
});
