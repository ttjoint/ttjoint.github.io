'use strict';
/**
 * Tests for the read-only query API and its browser client.
 *
 * The server is exercised by calling `route()` against a fake request/response
 * rather than by opening a socket: a port-binding test is flaky under parallel
 * runs and cannot assert on the routing table.
 *
 * The real database is used when present (`local_data/humanmap.sqlite3`); the
 * tests that need it skip otherwise, because a fresh clone has no corpus and
 * `npm run build:db` takes five minutes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { DatabaseSync } = require('node:sqlite');
const { DDL } = require('../../src/store/db_schema');
const api = require('../../scripts/serve_api');
const q = require('../../src/store/query_lang');

const REAL_DB = path.join(__dirname, '..', '..', 'local_data', 'humanmap.sqlite3');
const hasRealDb = fs.existsSync(REAL_DB);
const needsDb = { skip: hasRealDb ? false : 'no built database (run npm run build:db)' };

// ------------------------------------------------------------------ fixtures

/** Minimal graph: a grandfather, his son, and two grandchildren by different mothers. */
function seedGraph() {
  const db = new DatabaseSync(':memory:');
  for (const stmt of DDL) db.exec(stmt);

  const people = [
    ['person:gf', '祖父', 1000, 1080],
    ['person:f', '父親', 1030, 1100],
    ['person:c1', '長子', 1060, 1120],
    ['person:c2', '次子', 1065, 1130],
    ['person:m1', '母甲', 1040, 1110],
    ['person:m2', '母乙', 1045, 1115],
  ];
  const ins = db.prepare(
    `INSERT INTO entities (id,type,name,summary,props_json,valid_from,valid_to,folder,content_hash)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const [id, name, from, to] of people) {
    ins.run(id, 'person', name, null, null, from, to, 'persons', 'h-' + id);
  }

  const edge = db.prepare(
    'INSERT INTO edges (id,subject,predicate,object,qualifiers) VALUES (?,?,?,?,?)',
  );
  const edges = [
    ['person:f', 'father', 'person:gf', null],
    ['person:c1', 'father', 'person:f', null],
    ['person:c2', 'father', 'person:f', null],
    ['person:c1', 'mother', 'person:m1', null],
    ['person:c2', 'mother', 'person:m2', null],
    // A qualifier, so the concubine case has something to read.
    ['person:f', 'husband', 'person:m2', '{"role":"concubine"}'],
  ];
  edges.forEach(([s, p, o, ql], i) => edge.run(`edge:${i}`, s, p, o, ql));

  db.prepare('INSERT INTO aliases (entity_id, alias) VALUES (?,?)').run('person:gf', '太公');
  db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('schema_version', '1');
  return db;
}

/** Run a block against the real built database, then detach it. */
function withRealDb(fn) {
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  api._setDb(db);
  try {
    return fn(db);
  } finally {
    api._setDb(null);
    db.close();
  }
}

// The server module keeps a module-level `db`. Tests inject a fixture by
// requiring the module fresh, so these helpers swap it in and out.
function withFixture(fn) {
  const db = seedGraph();
  api._setDb(db);
  try {
    return fn(db);
  } finally {
    api._setDb(null);
    db.close();
  }
}

/** Fake req/res so `route()` can be called directly. */
function call(pathname, method = 'GET', body = null) {
  const req = { method, url: pathname, headers: { host: '127.0.0.1:8787' }, on() {}, };
  let payload = body ? JSON.stringify(body) : '';
  req.on = (ev, cb) => {
    if (ev === 'data' && payload) cb(Buffer.from(payload));
    if (ev === 'end') cb();
  };
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        Object.assign(this.headers, headers || {});
      },
      end(buf) {
        const text = buf.toString();
        try {
          resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null });
        } catch {
          resolve({ status: this.statusCode, body: text });
        }
      },
    };
    api.route(req, res).catch(reject);
  });
}

// ------------------------------------------------- static files: Pages parity

test('api: a directory URL serves index.html, like GitHub Pages', async () => {
  // Every static entity page is a directory (`site/p/person/cbdb-1/index.html`)
  // and the URL advertised in the sitemap and in canonical links is the
  // trailing-slash form. Serving those as 404 would make the whole generated tree
  // look broken locally while working on Pages — the exact divergence this server
  // exists to prevent.
  const r = await call('/browse/');
  assert.equal(r.status, 200);
  assert.match(String(r.body), /<html/i);
});

test('api: a nested entity directory URL serves its page', async () => {
  const r = await call('/p/person/cbdb-122316/');
  assert.equal(r.status, 200);
  assert.match(String(r.body), /<link rel="canonical"/);
});

test('api: directory resolution does not open the forbidden prefixes', async () => {
  // `resolveIndex` runs after the containment check, but a directory alias must not
  // become a way around the deny list either: `/raw/` is a directory and resolving
  // it to `index.html` would be a leak if the forbidden check were ever skipped.
  for (const p of ['/raw/', '/local_data/', '/src/']) {
    const r = await call(p);
    assert.equal(r.status, 403, `${p} must stay forbidden`);
  }
});

// ------------------------------------------------------- descriptor parsing

test('api: query string becomes a descriptor', () => {
  const sp = new URLSearchParams('type=person&where=name:prefix:王&orderBy=birthDate:desc&limit=20');
  const d = api.descriptorFromQuery(sp);
  assert.equal(d.type, 'person');
  assert.deepEqual(d.where, [{ field: 'name', op: 'prefix', value: '王' }]);
  assert.deepEqual(d.orderBy, [{ field: 'birthDate', dir: 'desc' }]);
  assert.equal(d.limit, 20);
});

test('api: repeated where conditions are ANDed, not overwritten', () => {
  // URLSearchParams.getAll is the only way to see both. Using `.get` here would
  // silently keep the last one, turning two filters into one.
  const sp = new URLSearchParams('where=name:prefix:王&where=dated:eq:true');
  const d = api.descriptorFromQuery(sp);
  assert.equal(d.where.length, 2);
  assert.equal(d.where[1].field, 'dated');
});

test('api: between and in values are split into arrays', () => {
  const sp = new URLSearchParams('where=birthDate:between:1000,2000&where=type:in:person,thing');
  const d = api.descriptorFromQuery(sp);
  assert.deepEqual(d.where[0].value, [1000, 2000]);
  assert.deepEqual(d.where[1].value, ['person', 'thing']);
});

test('api: q becomes a full-text where clause', () => {
  // `?q=冒樹楷` 曾被静默忽略——descriptorFromQuery 只认 where/orderBy/limit/type，
  // 于是检索框输入的名字变成「返回默认排序的前几条」。用户看到一堆无关的人，
  // 分不清是搜错了还是功能坏了。静默失败比报错更糟。
  const sp = new URLSearchParams('q=冒樹楷');
  const d = api.descriptorFromQuery(sp);
  assert.deepEqual(d.where, [{ field: 'name', op: 'text', value: '冒樹楷' }]);
});

test('api: q coexists with explicit where clauses', () => {
  const sp = new URLSearchParams('q=冒&where=type:eq:person');
  const d = api.descriptorFromQuery(sp);
  assert.equal(d.where.length, 2);
  assert.deepEqual(d.where[0], { field: 'type', op: 'eq', value: 'person' });
  assert.deepEqual(d.where[1], { field: 'name', op: 'text', value: '冒' });
});

test('api: blank q is ignored, not turned into an empty filter', () => {
  // 空字符串走 FTS 会编译成 MATCH ''，那要么报错要么匹配全部——
  // 两者都不是「没输入」该有的行为。
  for (const raw of ['q=', 'q=%20%20']) {
    const d = api.descriptorFromQuery(new URLSearchParams(raw));
    assert.equal(d.where, undefined, `${raw} should produce no filter`);
  }
});

test('api: booleans survive the trip as booleans', () => {
  const sp = new URLSearchParams('where=dated:eq:false');
  assert.equal(api.descriptorFromQuery(sp).where[0].value, false);
});

test('api: a malformed where clause is rejected, not guessed at', () => {
  assert.throws(() => api.descriptorFromQuery(new URLSearchParams('where=name')), /malformed/);
});

// ------------------------------------------------------------------ routes

test('api: schema endpoint reports the compiler whitelist', async () => {
  const r = await call('/api/schema');
  assert.equal(r.status, 200);
  assert.ok(r.body.fields.name.ops.includes('text'));
  assert.ok(Array.isArray(r.body.orderBy));
});

test('api: unknown field is a 400, not a 500', async () => {
  // The distinction matters to the frontend: 400 means "I asked wrong" and should
  // not be shown as a server fault.
  const r = await call('/api/query?where=id;DROP:eq:x');
  assert.equal(r.status, 400);
});

test('api: the URL normaliser removes traversal before it reaches the handler', async () => {
  // Not a guard test: `new URL` already collapses `%2e%2e`, so this asserts the
  // behaviour the static server relies on. If a future change decoded the path
  // before joining, this test fails — which is the point.
  const r = await call('/%2e%2e/data/persons/manifest.json');
  assert.equal(r.status, 200, 'resolved to /data/... inside the publish tree, not the corpus');
  assert.ok(r.body, 'served from site/data, the published subset');
});

// ------------------------------------------------------------ real database

test('api: family tree walks down with bounded depth', needsDb, () => {
  withRealDb(() => {
    const rows = api._tree('person:cbdb-11525', 'down', 2, null);
    assert.ok(rows.length > 0);
    assert.equal(rows[0].depth, 0, 'the seed comes first');
    assert.ok(rows.every((r) => r.depth <= 2), 'depth must be respected');
    // UNION deduplicates (id, depth) pairs, not ids. The same person appearing at
    // two depths is real information: a pedigree collapse, where the same ancestor
    // is reachable by more than one path. What must never happen is the same
    // person at the SAME depth twice — that would mean the recursion loops.
    const pairs = rows.map((r) => r.id + '@' + r.depth);
    assert.equal(new Set(pairs).size, pairs.length, 'no (id, depth) pair may repeat');
  });
});

test('api: family tree depth is clamped to the maximum', needsDb, () => {
  withRealDb(() => {
    // A caller asking for depth 999 must not be allowed to walk 486k nodes.
    const rows = api._tree('person:cbdb-11525', 'down', 999, null);
    assert.ok(rows.every((r) => r.depth <= api.MAX_DEPTH));
  });
});

test('api: up and down walk different columns', needsDb, () => {
  withRealDb(() => {
    // Direction semantics: `A --father--> B` reads "A's father is B", so walking
    // `down` (subject -> object) from a person follows their own ancestors, and
    // `up` (object -> subject) finds the people who name them as father.
    //
    // Restrict to `father` here: without a predicate the graph is not a tree at all
    // (a child reaches its parent "downward" through husband and sibling edges;
    // verified against the real data), so an unfiltered walk cannot test direction.
    const parent = api._db().prepare(
      "SELECT object FROM edges WHERE predicate='father' GROUP BY object ORDER BY COUNT(*) DESC LIMIT 1",
    ).get().object;
    const child = api._db()
      .prepare("SELECT subject FROM edges WHERE predicate='father' AND object=? LIMIT 1")
      .get(parent).subject;

    // Down from the child reaches the father: the child's father IS that person.
    const childDown = api._tree(child, 'down', 1, 'father').map((r) => r.id);
    assert.ok(childDown.includes(parent), "down from a child must reach its father");

    // Up from the father reaches the child: the child names him as father.
    const parentUp = api._tree(parent, 'up', 1, 'father').map((r) => r.id);
    assert.ok(parentUp.includes(child), 'up from a father must reach the child');

    // And the two are not symmetric: going down from the father follows HIS
    // ancestors, so the child must not appear.
    const parentDown = api._tree(parent, 'down', 1, 'father').map((r) => r.id);
    assert.ok(!parentDown.includes(child), 'down from the father must not reach the child');
  });
});

test('api: entity detail carries edges in both directions', needsDb, () => {
  withRealDb(() => {
    const d = api._detail('person:cbdb-11525');
    assert.equal(d.id, 'person:cbdb-11525');
    assert.ok(Array.isArray(d.outgoing));
    assert.ok(Array.isArray(d.incoming));
    assert.ok(!('props_json' in d), 'the raw JSON column must not leak');
    assert.ok(Array.isArray(d.aliases));
    assert.ok(Array.isArray(d.provenance));
  });
});

test('api: a missing entity is null, so the route can 404', needsDb, () => {
  withRealDb(() => {
    assert.equal(api._detail('person:does-not-exist'), null);
  });
});

test('api: timeline window returns rows in order and a cursor', needsDb, () => {
  withRealDb(() => {
    const r = q.run(api._db(), {
      where: [{ field: 'birthDate', op: 'between', value: [1929249, 1960000] }],
      orderBy: [{ field: 'birthDate', dir: 'asc' }],
      limit: 5,
    });
    assert.ok(r.rows.length > 0);
    assert.ok(r.nextCursor, 'more rows exist, so a cursor is required');
    const starts = r.rows.map((x) => x.lifespan.start);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });
});

test('api: health reports the same edge count the query sees', needsDb, () => {
  withRealDb(() => {
    const h = api._health();
    const sampled = h.predicates.reduce((s, p) => s + p.n, 0);
    assert.equal(sampled, h.counts.edges, 'per-predicate counts must sum to the total');
  });
});

// ------------------------------------------------------------ browser client

test('client: serializeDescriptor flattens repeats without losing them', () => {
  const { serializeDescriptor } = require('../../js/core/api');
  const out = serializeDescriptor({
    where: [
      { field: 'name', op: 'prefix', value: '王' },
      { field: 'birthDate', op: 'between', value: [1, 2] },
    ],
    orderBy: [{ field: 'name' }],
    limit: 10,
  });
  assert.deepEqual(out.where, ['name:prefix:王', 'birthDate:between:1,2']);
  assert.deepEqual(out.orderBy, ['name:asc'], 'a missing dir defaults to asc');
});

test('client: an unavailable API rejects rather than returning empty', () => {
  // Returning [] would render as "no results", which is a lie: the query never
  // ran. Rejecting forces the caller to choose the shard fallback explicitly.
  const { ApiClient } = require('../../js/core/api');
  const c = new ApiClient({ fetchImpl: null });
  c.status = 'down';
  return c.query({}).then(
    () => assert.fail('must reject'),
    (e) => assert.match(e.message, /unavailable/),
  );
});

test('client: capabilities collapse when the API is down', () => {
  const { ApiClient } = require('../../js/core/api');
  const c = new ApiClient({});
  c.status = 'down';
  const caps = c.capabilities();
  assert.equal(caps.tree, false);
  assert.equal(caps.entity, true, 'shards can still serve a single entity');
});

test('client: a probe failure downgrades silently and is attempted once', async () => {
  const { ApiClient } = require('../../js/core/api');
  let calls = 0;
  const c = new ApiClient({
    fetchImpl: () => {
      calls++;
      return Promise.reject(new Error('offline'));
    },
  });
  assert.equal(await c.probe(), false);
  assert.equal(await c.probe(), false);
  assert.equal(calls, 1, 'the probe result must be memoised');
  assert.equal(c.status, 'down');
});

test('client: a successful probe exposes the health payload', async () => {
  const { ApiClient } = require('../../js/core/api');
  const c = new ApiClient({
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ counts: { entities: 3 } }) }),
  });
  assert.equal(await c.probe(), true);
  assert.equal(c.status, 'up');
  assert.equal(c.health.counts.entities, 3);
  assert.equal(c.capabilities().tree, true);
});
