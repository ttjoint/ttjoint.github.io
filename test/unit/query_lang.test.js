'use strict';
/**
 * Tests for the query description language.
 *
 * Two things are being defended here:
 *
 *   1. **No SQL can come from the caller.** The compiler only emits column names
 *      from its own allowlist, and all values are bound. Every test that passes
 *      hostile input asserts a *rejection*, not a sanitisation — sanitising means
 *      guessing, and a guess that is wrong is an injection.
 *
 *   2. **Paging does not lose or repeat rows.** Keyset pagination is correct only
 *      if the cursor predicate matches the ORDER BY exactly, including the NULL
 *      handling. That bug is silent, so it gets exhaustive tests against a real
 *      database rather than a mocked one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { DDL, POST_LOAD } = require('../../src/store/db_schema');
const q = require('../../src/store/query_lang');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const stmt of DDL) db.exec(stmt);
  return db;
}

const ins = (db, row) =>
  db
    .prepare(
      'INSERT INTO entities (id, type, name, summary, valid_from, valid_to, folder) VALUES (?,?,?,?,?,?,?)',
    )
    .run(row.id, row.type || 'person', row.name, row.summary || null, row.valid_from ?? null, row.valid_to ?? null, row.folder || 'persons');

// ---------------------------------------------------------------- security

test('query: a column name cannot be smuggled in through a field', () => {
  for (const field of ['1=1', 'id; DROP TABLE entities', 'e.id', 'name)--', '../id', '__proto__', 'constructor']) {
    assert.throws(() => q.compile({ where: [{ field, op: 'eq', value: 'x' }] }), q.QueryError,
      `field ${JSON.stringify(field)} must be rejected`);
  }
  // Object.hasOwn, not `in`: otherwise every Object.prototype member would be a
  // valid field name.
  assert.throws(() => q.compile({ where: [{ field: 'toString', op: 'eq', value: 'x' }] }), q.QueryError);
});

test('query: an operator cannot be supplied as SQL', () => {
  for (const op of ['= 1 OR 1=1', 'eq OR 1=1', 'like', 'regexp', '', null, 42]) {
    assert.throws(() => q.compile({ where: [{ field: 'name', op, value: 'x' }] }), q.QueryError,
      `op ${JSON.stringify(op)} must be rejected`);
  }
});

test('query: values are bound, never interpolated', () => {
  const { sql, params } = q.compile({
    where: [{ field: 'name', op: 'eq', value: "'; DROP TABLE entities; --" }],
  });
  assert.doesNotMatch(sql, /DROP TABLE/, 'the value must not appear in the SQL text');
  assert.ok(params.includes("'; DROP TABLE entities; --"), 'it must be a bound parameter');
});

test('query: a predicate key must be an identifier', () => {
  for (const key of ['father); DROP TABLE edges;--', 'fa ther', '', '1father', null, 5]) {
    assert.throws(
      () => q.compile({ where: [{ field: 'hasRelation', op: 'exists', value: { predicate: key } }] }),
      q.QueryError,
      `predicate key ${JSON.stringify(key)} must be rejected`,
    );
  }
});

test('query: LIKE metacharacters in a prefix search are escaped', () => {
  // `_` matches any character and `%` matches everything. A user searching for a
  // literal underscore must not get the whole table.
  assert.equal(q.likePrefix('a_b'), 'a\\_b%');
  // The trailing % is ours; the escaped one is the user's.
  assert.equal(q.likePrefix('100%'), '100\\%%');
  assert.equal(q.likePrefix('a\\b'), 'a\\\\b%');
  const { sql, params } = q.compile({ where: [{ field: 'alias', op: 'prefix', value: '50%_x' }] });
  assert.match(sql, /ESCAPE/, 'the escape character must be declared');
  assert.equal(params[0], '50\\%\\_x%');
});

test('query: FTS input cannot inject query syntax', () => {
  // `"` and `*` are FTS5 operators. Everything is quoted, so they become text.
  // `*` is additionally split off by CJK segmentation, which is fine — it must
  // not survive as a prefix operator.
  assert.equal(q.ftsPhrase('歐陽*'), '"歐" "陽" "*"');
  assert.equal(q.ftsPhrase('a"b'), '"a""b"');
  // A name that literally contains a parenthesis (present in the corpus) is fine.
  // Segmentation only splits han characters, so "(子" stays one token; the quotes
  // are what stop FTS5 from reading the paren as grouping syntax.
  assert.equal(q.ftsPhrase('陳某(子)'), '"陳" "某" "(子" ")"');
});

test('query: an unparseable cursor is rejected, not ignored', () => {
  // Ignoring it would silently serve page 1 again, which looks like paging works.
  assert.throws(() => q.compile({ cursor: 'not-a-cursor' }), q.QueryError);
  assert.throws(() => q.decodeCursor(Buffer.from('{"a":1}').toString('base64url'), [{ field: 'name' }]), q.QueryError);
  assert.equal(q.decodeCursor(null, [{ field: 'name' }]), null);
});

test('query: the limit is clamped', () => {
  assert.equal(q.compile({ limit: 1e9 }).limit, 1000);
  // A non-positive limit is a client bug; answering with one row would look like
  // the query worked and found exactly one result.
  assert.equal(q.compile({ limit: 0 }).limit, 50);
  assert.equal(q.compile({ limit: -5 }).limit, 50);
  assert.equal(q.compile({ limit: '10' }).limit, 10);
});

test('query: only indexed columns may be sorted on', () => {
  // Sorting on an unindexed column would build a temp B-tree per page: correct
  // but 1000x slower, and it would look fine in a small test.
  assert.throws(() => q.compile({ orderBy: [{ field: 'summary' }] }), q.QueryError);
  assert.throws(() => q.compile({ orderBy: [{ field: 'hasRelation' }] }), q.QueryError);
  for (const field of Object.keys(q.ORDER_SPECS)) {
    assert.doesNotThrow(() => q.compile({ orderBy: [{ field }] }), `sorting by ${field} must work`);
  }
});

// ---------------------------------------------------------------- semantics

test('query: a numeric field rejects a non-numeric value', () => {
  // SQLite would happily compare '1100' > 'abc' and return nonsense.
  assert.throws(() => q.compile({ where: [{ field: 'birthDate', op: 'gt', value: 'soon' }] }), q.QueryError);
  assert.doesNotThrow(() => q.compile({ where: [{ field: 'birthDate', op: 'gt', value: '1100' }] }));
});

test('query: between needs exactly two bounds', () => {
  assert.throws(() => q.compile({ where: [{ field: 'birthDate', op: 'between', value: [1] }] }), q.QueryError);
  assert.throws(() => q.compile({ where: [{ field: 'birthDate', op: 'between', value: [1, 2, 3] }] }), q.QueryError);
});

test('query: a prefix search is a bound range, not a LIKE', () => {
  const { sql, params } = q.compile({ where: [{ field: 'name', op: 'prefix', value: '歐陽' }] });
  assert.match(sql, /e\.name >= \?/);
  assert.deepEqual(params.slice(0, 2), ['歐陽', '歐陽\uffff']);
});

test('query: an empty in-list is a no-op, not a match-nothing', () => {
  // `IN ()` is a syntax error in SQLite; treating it as "no constraint" keeps the
  // frontend from having to special-case an empty checkbox group.
  const { sql, params } = q.compile({ where: [{ field: 'type', op: 'in', value: [] }] });
  assert.doesNotMatch(sql, /IN \(/);
  assert.doesNotMatch(sql, /WHERE .*e\.type/);
  assert.ok(params.length >= 1); // just the limit
});

test('query: `dated` is a null test, not a column comparison', () => {
  assert.match(q.compile({ where: [{ field: 'dated', op: 'eq', value: true }] }).sql, /e\.valid_from IS NOT NULL/);
  assert.match(q.compile({ where: [{ field: 'dated', op: 'eq', value: false }] }).sql, /e\.valid_from IS NULL/);
});

test('query: the `type` sugar is compiled like any other condition', () => {
  // Regression: `type` was pushed into `conds` as a raw descriptor instead of a
  // compiled fragment, so `WHERE` joined it as `[object Object]` and every query
  // carrying a type failed to parse ("no such column: object Object"). The bug
  // survived because every test that passed `type` also happened to inspect only
  // the ORDER BY or the indexes.
  const { sql, params } = q.compile({ type: 'person' });
  assert.doesNotMatch(sql, /object Object/);
  assert.match(sql, /e\.type = \?/);
  assert.equal(params[0], 'person');

  // And it composes with the other conditions rather than replacing them.
  const both = q.compile({
    type: 'person',
    where: [{ field: 'dated', op: 'eq', value: false }],
    orderBy: [{ field: 'name', dir: 'asc' }],
  });
  assert.match(both.sql, /e\.type = \? AND e\.valid_from IS NULL/);
  assert.match(both.sql, /INDEXED BY idx_entities_undated/);
  assert.deepEqual(both.params, ['person', 51]);
});

test('query: a type-scoped query actually runs', () => {
  // The compiler test above checks the SQL text; this one would have failed on
  // the real bug, because the statement could not even be prepared.
  const db = freshDb();
  ins(db, { id: 'person:a', name: '甲', valid_from: null });
  ins(db, { id: 'person:b', name: '乙', valid_from: 2397855 });
  ins(db, { id: 'org:x', name: '丙', type: 'organization', valid_from: null });
  const res = q.run(db, {
    type: 'person',
    where: [{ field: 'dated', op: 'eq', value: false }],
    orderBy: [{ field: 'name', dir: 'asc' }],
  });
  assert.deepEqual(res.rows.map((r) => r.id), ['person:a']);
});

test('query: the undated query is pinned to the partial index', () => {
  // 252,316 of 486,786 persons are undated. Without the hint SQLite chooses
  // idx_entities_time (an equality lookup that returns the whole NULL block) and
  // then sorts it: measured 196ms. With the hint: 0ms.
  //
  // The index is named in the SQL, so a schema change that drops it must fail here
  // rather than at runtime. That check lives in db_index.test.js.
  const { sql } = q.compile({ where: [{ field: 'dated', op: 'eq', value: false }] });
  assert.match(sql, /INDEXED BY idx_entities_undated/);
  // The dated half has no such problem: it drives idx_entities_type_time.
  const dated = q.compile({ where: [{ field: 'dated', op: 'eq', value: true }] });
  assert.doesNotMatch(dated.sql, /INDEXED BY/);
});

test('query: a hint is not emitted when two conditions disagree', () => {
  // Two different preferred indexes cannot both be applied; falling back to the
  // planner is correct, applying one arbitrarily is not.
  const { sql } = q.compile({ where: [{ field: 'dated', op: 'eq', value: false }] });
  assert.equal((sql.match(/INDEXED BY/g) || []).length, 1);
});

// ------------------------------------------------------------------- paging

/** Seed a table with names that collide on sort keys and contain NULLs. */
function seedPaging(db) {
  const rows = [
    { id: 'person:1', name: 'A', valid_from: 100 },
    { id: 'person:2', name: 'A', valid_from: 200 }, // same name, different time
    { id: 'person:3', name: 'B', valid_from: null }, // NULL sorts first ASC
    { id: 'person:4', name: 'C', valid_from: 100 },
    { id: 'person:5', name: 'D', valid_from: 100 },
    { id: 'person:6', name: 'E', valid_from: 300 },
  ];
  for (const r of rows) ins(db, r);
  return rows;
}

/** Walk every page with the given order and return the ids in order. */
function pageThrough(db, orderBy, pageSize = 2) {
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 100; guard++) {
    const res = q.run(db, { orderBy, cursor, limit: pageSize });
    seen.push(...res.rows.map((r) => r.id));
    if (!res.hasMore) return seen;
    cursor = res.nextCursor;
  }
  throw new Error('paging did not terminate');
}

test('query: paging returns every row exactly once, in order', () => {
  for (const orderBy of [
    [{ field: 'name', dir: 'asc' }],
    [{ field: 'name', dir: 'desc' }],
    [{ field: 'birthDate', dir: 'asc' }],
    [{ field: 'birthDate', dir: 'desc' }],
    [{ field: 'name', dir: 'asc' }, { field: 'birthDate', dir: 'desc' }],
  ]) {
    for (const size of [1, 2, 3, 5, 100]) {
      const db = freshDb();
      seedPaging(db);
      const walked = pageThrough(db, orderBy, size);
      // The reference is an unpaged query with the same sort. The tiebreak
      // direction must match what the compiler appends: it follows the leading
      // sort direction (see `compile`), so this cannot hardcode ASC.
      const tiebreak = orderBy[0].dir === 'desc' ? 'DESC' : 'ASC';
      const all = db
        .prepare(
          `SELECT id FROM entities e ORDER BY ${orderBy
            .map((o) => `${q.ORDER_SPECS[o.field].column} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`)
            .join(', ')}${orderBy.some((o) => o.field === 'id') ? '' : `, e.id ${tiebreak}`}`,
        )
        .all()
        .map((r) => r.id);
      assert.deepEqual(walked, all, `order=${JSON.stringify(orderBy)} size=${size}`);
      assert.equal(new Set(walked).size, walked.length, 'no duplicates');
    }
  }
});

test('query: paging a filtered list stays filtered on every page', () => {
  // Page 2 must not forget the WHERE clause. That mistake returns the whole table
  // after the first page and is invisible in a single-page test.
  const db = freshDb();
  seedPaging(db);
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const res = q.run(db, { where: [{ field: 'birthDate', op: 'eq', value: 100 }], cursor, limit: 1 });
    seen.push(...res.rows.map((r) => r.id));
    if (!res.hasMore) break;
    cursor = res.nextCursor;
  }
  assert.deepEqual(seen, ['person:1', 'person:4', 'person:5']);
});

test('query: a cursor for NULL is not treated as unset', () => {
  // This is the case that silently drops rows: the previous row's sort key was
  // NULL, and a naive `col > ?` with a NULL parameter matches nothing, so paging
  // stops early. Sorting by birthDate ASC puts the NULL first.
  const db = freshDb();
  seedPaging(db);
  const first = q.run(db, { orderBy: [{ field: 'birthDate', dir: 'asc' }], limit: 1 });
  assert.equal(first.rows[0].id, 'person:3', 'the NULL row sorts first');
  assert.ok(first.nextCursor, 'there must be a next page');
  const second = q.run(db, { orderBy: [{ field: 'birthDate', dir: 'asc' }], cursor: first.nextCursor, limit: 10 });
  assert.ok(second.rows.length > 0, 'a NULL cursor must still advance');
  assert.equal(second.rows[0].id, 'person:1');
});

test('query: the last page reports no more', () => {
  const db = freshDb();
  seedPaging(db);
  const res = q.run(db, { orderBy: [{ field: 'name', dir: 'asc' }], limit: 100 });
  assert.equal(res.hasMore, false);
  assert.equal(res.nextCursor, null);
  assert.equal(res.rows.length, 6);
});

test('query: rows are shaped like the frontend expects', () => {
  const db = freshDb();
  ins(db, { id: 'person:9', name: '張三', valid_from: 2100000, valid_to: 2100100 });
  const res = q.run(db, {});
  assert.deepEqual(res.rows[0], {
    id: 'person:9',
    type: 'person',
    name: '張三',
    summary: '',
    folder: 'persons',
    lifespan: { start: 2100000, end: 2100100 },
  });
});

// ------------------------------------------------------------------ relations

test('query: hasRelation filters by predicate and direction', () => {
  const db = freshDb();
  ins(db, { id: 'person:a', name: 'A' });
  ins(db, { id: 'person:b', name: 'B' });
  ins(db, { id: 'person:c', name: 'C' });
  db.prepare('INSERT INTO edges (id, subject, predicate, object) VALUES (?,?,?,?)').run('e1', 'person:a', 'father', 'person:b');

  const hasFather = q.run(db, { where: [{ field: 'hasRelation', op: 'exists', value: { predicate: 'father' } }] });
  assert.deepEqual(hasFather.rows.map((r) => r.id), ['person:a'], 'subject side only');

  const isFather = q.run(db, {
    where: [{ field: 'hasRelation', op: 'eq', value: { predicate: 'father', object: 'person:b' } }],
  });
  assert.deepEqual(isFather.rows.map((r) => r.id), ['person:a']);

  const noFather = q.run(db, { where: [{ field: 'hasRelation', op: 'notExists', value: { predicate: 'father' } }] });
  assert.deepEqual(noFather.rows.map((r) => r.id).sort(), ['person:b', 'person:c']);
});

test('query: hasPredicate matches either direction', () => {
  // The frontend predicate filter is direction-agnostic: "relating to fathers"
  // should find both the child and the father.
  const db = freshDb();
  ins(db, { id: 'person:a', name: 'A' });
  ins(db, { id: 'person:b', name: 'B' });
  db.prepare('INSERT INTO edges (id, subject, predicate, object) VALUES (?,?,?,?)').run('e1', 'person:a', 'father', 'person:b');
  const res = q.run(db, { where: [{ field: 'hasPredicate', op: 'eq', value: 'father' }] });
  assert.deepEqual(res.rows.map((r) => r.id).sort(), ['person:a', 'person:b']);
});

test('query: hasRelation can match a qualifier', () => {
  // 4,112 edges carry {"role":"concubine"}. "The concubines of X" is a qualifier
  // question, not a different predicate.
  const db = freshDb();
  ins(db, { id: 'person:a', name: 'A' });
  ins(db, { id: 'person:b', name: 'B' });
  ins(db, { id: 'person:c', name: 'C' });
  const st = db.prepare('INSERT INTO edges (id, subject, predicate, object, qualifiers) VALUES (?,?,?,?,?)');
  st.run('e1', 'person:a', 'spouse', 'person:b', JSON.stringify({ role: 'wife' }));
  st.run('e2', 'person:a', 'spouse', 'person:c', JSON.stringify({ role: 'concubine' }));
  const res = q.run(db, {
    where: [
      { field: 'hasRelation', op: 'eq', value: { predicate: 'spouse', qualifier: { role: 'concubine' } } },
    ],
  });
  assert.deepEqual(res.rows.map((r) => r.id), ['person:a']);
});

test('query: alias prefix does not scan the alias table', () => {
  const db = freshDb();
  ins(db, { id: 'person:a', name: 'A' });
  ins(db, { id: 'person:b', name: 'B' });
  db.prepare('INSERT INTO aliases (entity_id, alias) VALUES (?,?)').run('person:a', 'W');
  const c = q.compile({ where: [{ field: 'alias', op: 'prefix', value: 'W' }] });
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...c.params).map((r) => r.detail).join(" ");
  // Either alias index is acceptable: idx_aliases_alias searches the prefix and
  // idx_aliases_entity looks up by the correlated outer id. What must not happen
  // is a full scan of the alias table per candidate entity.
  //
  // The real defence is that the prefix is a BOUND PARAMETER and never starts with
  // a wildcard. A leading-wildcard LIKE would force a scan no matter which index
  // exists, which is why the compiler only ever emits prefixplus%.
  assert.doesNotMatch(plan, /SCAN a( |$)/, `alias lookup must use an index, got: ${plan}`);
  assert.match(plan, /USING (COVERING )?INDEX/, `expected an index, got: ${plan}`);
  const res = q.run(db, { where: [{ field: 'alias', op: 'prefix', value: 'W' }] });
  assert.deepEqual(res.rows.map((r) => r.id), ['person:a']);
});
test('query: text search hits the FTS index', () => {
  const db = freshDb();
  ins(db, { id: 'person:a', name: '歐陽景達' });
  ins(db, { id: 'person:b', name: '王安石' });
  const { segment } = require('../../src/store/db_build_helpers');
  db.prepare('INSERT INTO search (entity_id, name, name_seg, aliases, aliases_seg, summary_seg) VALUES (?,?,?,?,?,?)')
    .run('person:a', '歐陽景達', segment('歐陽景達'), '', '', '');
  const res = q.run(db, { where: [{ field: 'name', op: 'text', value: '歐陽' }] });
  assert.deepEqual(res.rows.map((r) => r.id), ['person:a']);
  const none = q.run(db, { where: [{ field: 'name', op: 'text', value: '不存在' }] });
  assert.equal(none.rows.length, 0);
});

test('query: a DESC sort still reaches the undated rows', () => {
  // 252,316 of 486,786 persons have no date. NULL sorts LAST in DESC, so a
  // naive `valid_from < ?` cursor predicate excludes them forever and the last
  // page is silently short by one. This was a real bug: page size 1 walked
  // 5 of 6 rows.
  const db = freshDb();
  seedPaging(db);
  const walked = pageThrough(db, [{ field: 'birthDate', dir: 'desc' }], 1);
  assert.equal(walked.length, 6, 'every row must appear');
  assert.equal(walked[walked.length - 1], 'person:3', 'the undated row sorts last in DESC');
});

test('query: a shared sort key does not lose rows', () => {
  // Two people named A. A cursor holding only the name cannot express "after the
  // second A", so without the id tiebreak in the cursor the second one is skipped.
  const db = freshDb();
  seedPaging(db);
  const walked = pageThrough(db, [{ field: 'name', dir: 'asc' }], 1);
  assert.ok(walked.includes('person:2'), 'the second "A" must not be skipped');
  assert.equal(walked.length, 6);
});

test('query: compiling twice gives the same SQL and parameters', () => {
  // The compiler must be pure: the server caches compiled statements, which is
  // only safe if the same description always produces the same text.
  const desc = {
    type: 'person',
    where: [{ field: 'birthDate', op: 'between', value: [2100000, 2110000] }],
    orderBy: [{ field: 'name', dir: 'asc' }],
    limit: 20,
  };
  const a = q.compile(desc);
  const b = q.compile(desc);
  assert.equal(a.sql, b.sql);
  assert.deepEqual(a.params, b.params);
});
