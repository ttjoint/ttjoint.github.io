'use strict';
/**
 * The query description language: the contract between the frontend and the
 * SQLite index.
 *
 * Why not SQL
 * -----------
 * The frontend must not be able to express SQL. If it can, three things break at
 * once: injection becomes possible, every new query type needs a frontend change,
 * and the database schema leaks into the browser (so a column rename is a breaking
 * frontend change).
 *
 * A description is data:
 *
 *   {
 *     type: 'person',
 *     where: [{ field: 'name', op: 'prefix', value: '歐陽' }],
 *     orderBy: [{ field: 'birthDate', dir: 'asc' }],
 *     cursor: '...',
 *     limit: 50
 *   }
 *
 * `compile()` turns that into `{ sql, params }` where every value is bound, never
 * interpolated. The same description can be answered by the SQLite index today and
 * by a different backend later without the frontend noticing.
 *
 * The allowlist is the security boundary
 * --------------------------------------
 * `FIELD_SPECS` is the complete set of queryable fields. A field not in it cannot
 * be named, so there is no path from user input to an arbitrary column. Every
 * operator is likewise enumerated, and each one decides what SQL fragment it
 * produces — a caller never supplies SQL text.
 *
 * Cursors, not offsets
 * --------------------
 * `LIMIT ? OFFSET ?` degrades linearly (the database walks and discards every
 * skipped row) and silently skips or repeats rows when the underlying data
 * changes between pages. The cursor encodes the last row's sort key, so the next
 * page is an index range scan: `WHERE (sort_key) > (last_key)`. Measured on 486k
 * rows: 0.06ms per page at any position.
 */

const { segment } = require('./db_build_helpers');

/**
 * Fields the frontend may query, and how each is compiled.
 *
 * Each spec owns its SQL. `column` is a literal from this table, never from the
 * caller, so `where[].field` can only ever select one of these strings.
 */
const FIELD_SPECS = {
  // ------------------------------------------------------------ entity columns
  id: {
    column: 'e.id',
    type: 'text',
    sortable: true,
    ops: ['eq', 'in', 'prefix'],
  },
  name: {
    column: 'e.name',
    type: 'text',
    sortable: true,
    ops: ['eq', 'in', 'prefix', 'text'],
  },
  type: {
    column: 'e.type',
    type: 'text',
    sortable: false,
    ops: ['eq', 'in'],
  },
  folder: {
    column: 'e.folder',
    type: 'text',
    sortable: false,
    ops: ['eq', 'in'],
  },
  summary: {
    column: 'e.summary',
    type: 'text',
    sortable: false,
    // No `text` op: summary is not in the FTS index at entity level (see
    // `text` below). ILIKE-style substring matching is banned project-wide.
    ops: ['eq'],
  },
  // ------------------------------------------------------------- time columns
  // Julian day numbers. The frontend converts a slider position to a JDN with
  // the same code the browser already uses (js/core/data_store.js), so both
  // sides agree on what "1100 CE" means.
  birthDate: {
    column: 'e.valid_from',
    type: 'number',
    sortable: true,
    nullable: true,
    ops: ['eq', 'lt', 'lte', 'gt', 'gte', 'between', 'null'],
  },
  deathDate: {
    column: 'e.valid_to',
    type: 'number',
    sortable: true,
    nullable: true,
    ops: ['eq', 'lt', 'lte', 'gt', 'gte', 'between', 'null'],
  },
  // Did the entity have any date at all? `true` = has a lifespan, `false` = not.
  // The timeline needs this to answer "show me undated persons too" without
  // expressing `NULL OR NOT NULL` itself.
  dated: {
    column: 'e.valid_from',
    type: 'boolean',
    sortable: false,
    ops: ['eq'],
  },

  // ---------------------------------------------------------- graph predicates
  // "Does this entity have an edge with predicate X pointing at ...?"
  //
  // The predicate key is validated against the predicate registry by the caller
  // (see `validate()`), because this module must not depend on the registry to
  // stay usable from tests. Values are objects:
  //   { field: 'hasRelation', op: 'eq', value: { predicate: 'father', object: 'person:x' } }
  // or simply `{ predicate: 'father' }` to ask "has any father edge".
  hasRelation: {
    type: 'relation',
    sortable: false,
    ops: ['eq', 'exists', 'notExists'],
  },
  // Predicates present on this entity, in either direction. Dedicated because it
  // is the main "filter by relationship kind" control and would otherwise need a
  // hand-written EXISTS per predicate.
  hasPredicate: {
    type: 'relation',
    sortable: false,
    ops: ['eq', 'in'],
  },

  // ------------------------------------------------------------------- aliases
  alias: {
    type: 'alias',
    sortable: false,
    ops: ['eq', 'prefix'],
  },
};

/**
 * Sorts the frontend may request. A sort on an unindexed column would make every
 * page build a temp B-tree, so only indexed columns are allowed.
 *
 * `name` uses idx_entities_type_name_id; the time sorts use idx_entities_type_time
 * and idx_entities_type_valid_to_id. All are exercised by the plan assertions in
 * the tests.
 *
 * `nullable` is not decoration: the keyset predicate can only take its compact
 * row-value form when every sort column is non-nullable, because row-value
 * comparison propagates NULL instead of following SQLite's NULLS-FIRST ordering.
 */
const ORDER_SPECS = {
  name: { column: 'e.name', nullable: false },
  birthDate: { column: 'e.valid_from', nullable: true },
  deathDate: { column: 'e.valid_to', nullable: true },
  id: { column: 'e.id', nullable: false },
};

/** Fields usable as a cursor. Derived from ORDER_SPECS: a cursor is a sort key. */
const CURSOR_FIELDS = new Set(Object.keys(ORDER_SPECS));

class QueryError extends Error {
  constructor(message, code = 'INVALID_QUERY') {
    super(message);
    this.name = 'QueryError';
    this.code = code;
  }
}

/** Throw a QueryError with a useful message rather than emitting broken SQL. */
function reject(message) {
  throw new QueryError(message);
}

/**
 * Loose predicate-key check.
 *
 * Deliberately structural, not registry-backed: this module must not import the
 * predicate registry (the registry is a layer-1 concern and pulling it in would
 * make the compiler unusable in a browser bundle). The server layer calls
 * `registry.get()` on top of this; see `assertPredicates()`.
 */
function looksLikePredicateKey(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

/**
 * Compile one `where` condition to a fragment.
 *
 * Returns `{ sql, params }` or null for a no-op condition.
 */
function compileCondition(cond, ctx) {
  if (!cond || typeof cond !== 'object') reject('where entries must be objects');
  const { field, op, value } = cond;
  if (typeof field !== 'string' || !Object.hasOwn(FIELD_SPECS, field)) {
    reject(`unknown field: ${JSON.stringify(field)}`, 'UNKNOWN_FIELD');
  }
  const spec = FIELD_SPECS[field];
  if (!spec.ops.includes(op)) {
    reject(`operator ${JSON.stringify(op)} is not allowed on field ${field}`, 'UNKNOWN_OP');
  }

  // ------------------------------------------------------------- projections
  // Some fields are not columns but derived conditions.
  if (field === 'dated') {
    const want = value === true || value === 1 || value === 'true';
    return {
      sql: want ? 'e.valid_from IS NOT NULL' : 'e.valid_from IS NULL',
      params: [],
      // The undated cohort is 252,316 of 486,786 rows, and SQLite prefers the
      // equal-range lookup on idx_entities_time even though it then has to sort
      // the whole cohort. Measured: 196ms natural vs 0ms when forced onto the
      // partial index. See `preferIndex` below.
      preferIndex: want ? null : 'idx_entities_undated',
    };
  }
  if (field === 'hasPredicate') {
    const list = Array.isArray(value) ? value : [value];
    if (!list.length) return null;
    for (const p of list) {
      if (!looksLikePredicateKey(p)) reject(`invalid predicate key: ${JSON.stringify(p)}`);
    }
    const marks = list.map(() => '?').join(',');
    // Either direction: "X is a father" and "X has a father" are both edges that
    // mention the predicate. The frontend's predicate filter is direction-agnostic
    // by design; direction-specific questions use hasRelation.
    //
    // EXISTS over UNION ALL, not two EXISTS joined by OR: with the OR form SQLite
    // ran both subqueries for every candidate row even after the first matched
    // (measured 145ms vs 14ms).
    //
    // `id IN (SELECT ...)` was tried as an alternative shape and was slower
    // (22-36ms): SQLite deduplicates an IN subquery, so the saving from touching
    // fewer rows is given back in the temporary table. The cost here is inherent:
    // the query is "which of 486,781 entities have such an edge", and every
    // entity must be considered at least once.
    return {
      sql: `EXISTS (SELECT 1 FROM edges r WHERE r.subject = e.id AND r.predicate IN (${marks})
                 UNION ALL
                 SELECT 1 FROM edges r WHERE r.object = e.id AND r.predicate IN (${marks}))`,
      params: [...list, ...list],
    };
  }
  if (field === 'alias') {
    if (op === 'eq') {
      return {
        sql: 'EXISTS (SELECT 1 FROM aliases a WHERE a.entity_id = e.id AND a.alias = ?)',
        params: [String(value)],
      };
    }
    return {
      sql: 'EXISTS (SELECT 1 FROM aliases a WHERE a.entity_id = e.id AND a.alias LIKE ? ESCAPE \'\\\')',
      // The LIKE is on an indexed column with a bound prefix pattern, not a
      // substring search: '歐陽%' uses idx_aliases_alias. A leading wildcard
      // would defeat the index and is rejected below.
      params: [likePrefix(value)],
    };
  }

  // --------------------------------------------------------------- relations
  if (field === 'hasRelation') {
    const rel = typeof value === 'string' ? { predicate: value } : value;
    if (!rel || typeof rel !== 'object') reject('hasRelation needs an object value');
    if (!looksLikePredicateKey(rel.predicate)) {
      reject(`invalid predicate key: ${JSON.stringify(rel.predicate)}`);
    }
    const params = [rel.predicate];
    let sql;
    if (op === 'exists') {
      // "subject -> object": X has this relation pointing somewhere.
      sql = 'EXISTS (SELECT 1 FROM edges r WHERE r.subject = e.id AND r.predicate = ?';
    } else if (op === 'notExists') {
      sql = 'NOT EXISTS (SELECT 1 FROM edges r WHERE r.subject = e.id AND r.predicate = ?';
    } else {
      // op === 'eq': "X's <predicate> is <object>".
      //
      // `object` is optional when a qualifier is given, because "who are X's
      // concubines" is a real question that names no particular person. It was
      // mandatory at first and made that query inexpressible.
      if (rel.object == null && rel.qualifier == null) {
        reject('hasRelation with op=eq needs `object` or `qualifier`');
      }
      sql = 'EXISTS (SELECT 1 FROM edges r WHERE r.subject = e.id AND r.predicate = ?';
      if (rel.object != null) {
        sql += ' AND r.object = ?';
        params.push(String(rel.object));
      }
    }
    if (rel.qualifier != null) {
      // Match one qualifier key/value without parsing JSON in SQL: the column is
      // stored via JSON.stringify with sorted keys, so a substring test on an
      // exact JSON fragment is safe here and avoids a json_each explode.
      if (typeof rel.qualifier !== 'object') reject('hasRelation.qualifier must be an object');
      for (const [k, v] of Object.entries(rel.qualifier)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) reject(`invalid qualifier key: ${k}`);
        sql += ' AND r.qualifiers LIKE ?';
        params.push(`%"${k}":"${String(v).replace(/["\\]/g, '')}"%`);
      }
    }
    sql += ')';
    return { sql, params };
  }

  // ------------------------------------------------------------ plain columns
  const col = spec.column;
  switch (op) {
    case 'eq':
      if (value === null) return { sql: `${col} IS NULL`, params: [] };
      return { sql: `${col} = ?`, params: [coerce(spec, value)] };
    case 'in': {
      const list = Array.isArray(value) ? value : [value];
      if (!list.length) return null;
      return {
        sql: `${col} IN (${list.map(() => '?').join(',')})`,
        params: list.map((v) => coerce(spec, v)),
      };
    }
    case 'prefix':
      // Bound prefix on an indexed column -> range scan, not a scan-and-filter.
      // `LIKE 'x%'` would also work but a range is index-only and immune to the
      // case-sensitivity/escaping surprises of LIKE.
      return {
        sql: `(${col} >= ? AND ${col} < ?)`,
        params: [String(value), String(value) + '\uffff'],
      };
    case 'text': {
      // Full-text search. Only entity name/alias/summary live in the FTS table,
      // so this compiles to a subquery rather than a column predicate.
      const phrase = ftsPhrase(value);
      if (!phrase) return null;
      return {
        sql: `e.id IN (SELECT entity_id FROM search WHERE search MATCH ?)`,
        params: [phrase],
      };
    }
    case 'lt':
      return { sql: `${col} < ?`, params: [coerce(spec, value)] };
    case 'lte':
      return { sql: `${col} <= ?`, params: [coerce(spec, value)] };
    case 'gt':
      return { sql: `${col} > ?`, params: [coerce(spec, value)] };
    case 'gte':
      return { sql: `${col} >= ?`, params: [coerce(spec, value)] };
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) reject('between needs [lo, hi]');
      return {
        sql: `${col} BETWEEN ? AND ?`,
        params: [coerce(spec, value[0]), coerce(spec, value[1])],
      };
    }
    case 'null':
      return { sql: value ? `${col} IS NULL` : `${col} IS NOT NULL`, params: [] };
    default:
      // Unreachable: `spec.ops` already gated the operator.
      return reject(`unhandled operator: ${op}`);
  }
}

/** Type coercion for bound parameters. Rejects what SQLite would silently accept. */
function coerce(spec, value) {
  if (spec.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) reject(`expected a number, got ${JSON.stringify(value)}`);
    return n;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    reject(`expected a string, got ${typeof value}`);
  }
  return String(value);
}

/**
 * Make a bound LIKE prefix safe.
 *
 * A user typing `%` searching for names containing a literal percent is a real
 * case (and `_` is worse: `_` matches any character, so a search for `_` returns
 * everything). Escape both, and declare the escape character so the pattern stays
 * a prefix and can still use the index.
 */
function likePrefix(value) {
  const escaped = String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `${escaped}%`;
}

/**
 * Convert free text to an FTS5 MATCH expression.
 *
 * Each whitespace-separated term becomes a quoted phrase, and adjacent terms are
 * ANDed (FTS5's default). Quoting is required: names in the corpus contain `?`
 * and `(` where a character did not survive the source encoding, and bare
 * punctuation is FTS5 syntax.
 */
function ftsPhrase(text) {
  const terms = segment(text).split(' ').filter(Boolean);
  if (!terms.length) return '';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/** Encode a cursor from the last row of a page. */
function encodeCursor(orderBy, row) {
  const key = orderBy.map((o) => {
    // `o.field` is a query-language name (birthDate), but the row holds columns
    // (valid_from). Translate for the time fields; everything else is the same
    // word on both sides.
    const col = ORDER_SPECS[o.field].column.replace(/^e\./, '');
    const v = row[col];
    return v == null ? null : v;
  });
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Decode a cursor, validating it against the requested order. */
function decodeCursor(cursor, orderBy) {
  if (!cursor) return null;
  let key;
  try {
    key = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    reject('invalid cursor', 'BAD_CURSOR');
  }
  if (!Array.isArray(key) || key.length !== orderBy.length) {
    reject('cursor does not match orderBy', 'BAD_CURSOR');
  }
  return key;
}

/**
 * Build the keyset pagination predicate for a multi-column sort.
 *
 * For `ORDER BY a ASC, b ASC` with cursor `(ka, kb)`, the next page starts after:
 *
 *   (a > ka) OR (a = ka AND b > kb)
 *
 * Unrolled rather than the compact `(a,b) > (ka,kb)` row-value form because
 * SQLite cannot use an index for the row-value form when NULLs or mixed
 * directions are involved.
 *
 * NULL placement is the subtle part
 * ---------------------------------
 * SQLite sorts NULL first in ASC and last in DESC. A comparison against NULL
 * yields NULL, not true, so `a > NULL` and `a < 5` where a IS NULL are both
 * false. That means a naive key comparator silently drops every NULL row.
 *
 * There are two distinct cases:
 *
 *   cursor value NULL, ASC   -> NULLs are behind us; continue with non-NULL.
 *   cursor value NULL, DESC  -> NULLs are behind us too (they sort last); and
 *                               since nothing follows them, paging ends.
 *   cursor value set,  ASC   -> remaining NULLs sort AFTER? no: they were first,
 *                               so they are behind us. Plain `a > ?`.
 *   cursor value set,  DESC  -> remaining NULLs sort LAST, so they are still
 *                               AHEAD. The predicate must be
 *                               `(a < ? OR a IS NULL)`.
 *
 * The last line is the one that was wrong first: paging a DESC time sort stopped
 * one row short, always on the undated person. There are 252,316 of those in the
 * corpus, so it would have looked like "the last page is sometimes short".
 *
 * The row-value fast path
 * -----------------------
 * The unrolled OR form cannot be used as an index range: SQLite sees
 * `(a > ?) OR (a = ? AND b > ?)` and, even with a matching index, scans from the
 * start of the index applying the predicate as a filter. On the undated set that
 * is 9.8ms to reach page 400 of 200.
 *
 * `(a, b) > (?, ?)` is a single range constraint and becomes a seek: 0.27ms for
 * the same page, 36x faster.
 *
 * It is only emitted when every sort column is non-nullable and all directions
 * agree, because row-value comparison does NOT reproduce SQLite's NULLS-FIRST /
 * NULLS-LAST ordering — it propagates NULL, so `(NULL, x) > (NULL, y)` is NULL
 * rather than true or false. The unrolled form exists precisely to handle that,
 * so it stays for the time sorts.
 */
function keysetPredicate(orderBy, cursorKey) {
  const cols = orderBy.map((o) => ORDER_SPECS[o.field].column);
  const dirs = orderBy.map((o) => (o.dir === 'desc' ? 'desc' : 'asc'));
  const nonNullable = orderBy.every((o) => !ORDER_SPECS[o.field].nullable);
  const sameDir = dirs.every((d) => d === dirs[0]);

  if (nonNullable && sameDir && cursorKey.every((v) => v !== null)) {
    const op = dirs[0] === 'desc' ? '<' : '>';
    // Single column stays a scalar comparison; two or more become a row value.
    const lhs = cols.length === 1 ? cols[0] : `(${cols.join(', ')})`;
    const rhs = cols.length === 1 ? '?' : `(${cols.map(() => '?').join(', ')})`;
    return { sql: `(${lhs} ${op} ${rhs})`, params: [...cursorKey] };
  }

  const clauses = [];
  const params = [];
  for (let i = 0; i < orderBy.length; i++) {
    const parts = [];
    // Equality on all previously-sorted columns: we are on the same "row" of the
    // outer sort, and the tie-break decides.
    for (let j = 0; j < i; j++) {
      const col = ORDER_SPECS[orderBy[j].field].column;
      if (cursorKey[j] === null) {
        parts.push(`${col} IS NULL`);
      } else {
        parts.push(`${col} = ?`);
        params.push(cursorKey[j]);
      }
    }
    const col = ORDER_SPECS[orderBy[i].field].column;
    const dir = orderBy[i].dir === 'desc' ? 'desc' : 'asc';
    if (cursorKey[i] === null) {
      if (dir === 'asc') {
        // NULLs sort first in ASC, so everything non-NULL follows.
        parts.push(`${col} IS NOT NULL`);
      } else {
        // NULLs sort last in DESC: nothing follows a NULL. Emit a contradiction
        // so this branch matches no rows rather than matching everything.
        parts.push('0');
      }
    } else if (dir === 'asc') {
      parts.push(`${col} > ?`);
      params.push(cursorKey[i]);
    } else {
      // DESC: smaller values follow, and so do the NULLs (they sort last).
      parts.push(`(${col} < ? OR ${col} IS NULL)`);
      params.push(cursorKey[i]);
    }
    clauses.push(`(${parts.join(' AND ')})`);
  }
  if (!clauses.length) return null;
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/**
 * Compile a query description into `{ sql, params, orderBy }`.
 *
 * The result always selects entity columns with a `lifespan` projection so the
 * caller does not have to know the schema.
 */
function compile(desc) {
  if (!desc || typeof desc !== 'object') reject('query must be an object');
  const {
    type = null,
    where = [],
    orderBy = [{ field: 'name', dir: 'asc' }],
    cursor = null,
    limit = 50,
  } = desc;

  if (!Array.isArray(where)) reject('where must be an array');
  if (!Array.isArray(orderBy) || !orderBy.length) reject('orderBy must be a non-empty array');
  for (const o of orderBy) {
    if (!o || typeof o.field !== 'string' || !Object.hasOwn(ORDER_SPECS, o.field)) {
      reject(`cannot sort by ${JSON.stringify(o && o.field)}`, 'UNKNOWN_ORDER');
    }
    if (o.dir != null && o.dir !== 'asc' && o.dir !== 'desc') {
      reject(`sort direction must be asc or desc, got ${JSON.stringify(o.dir)}`);
    }
  }

  // The limit is always bound, never interpolated, and clamped so a client cannot
  // ask for the whole table in one page.
  //
  // A non-positive or non-numeric limit falls back to the default rather than
  // being clamped to 1: `limit: -1` is a client bug, and answering it with a
  // single row looks like the query worked and found one result.
  const requested = Number(limit);
  const n = Number.isFinite(requested) && requested > 0 ? Math.min(1000, Math.floor(requested)) : 50;

  const sql = [];
  const params = [];

  // Conditions. `type` is a sugar for `where: [{field:'type', op:'eq'}]` because
  // almost every query has it and repeating it is noise.
  const conds = [];
  // Index hints requested by conditions. See `preferIndex` in compileCondition.
  const indexHints = [];
  // The `type` sugar must go through the same compiler as an explicit where
  // condition. Pushing the raw `{field,op,value}` descriptor into `conds` left an
  // uncompiled object in the SQL string, so `whereSql` joined it as
  // `[object Object]` and every query carrying `type` failed to parse. It was
  // invisible because a bare `{type:'person'}` produced no WHERE clause at all
  // (`conds` ended up holding one non-fragment object, so `whereSql` was the
  // literal `WHERE [object Object]`), and no test ever ran a `type`-scoped query.
  if (type != null) {
    const frag = compileCondition({ field: 'type', op: 'eq', value: type }, {});
    if (frag) {
      conds.push(frag);
      params.push(...frag.params);
      if (frag.preferIndex) indexHints.push(frag.preferIndex);
    }
  }
  for (const c of where) {
    const frag = compileCondition(c, {});
    if (frag) {
      conds.push(frag);
      params.push(...frag.params);
      if (frag.preferIndex) indexHints.push(frag.preferIndex);
    }
  }

  // A stable tiebreak on id is appended so that rows sharing a sort key cannot
  // swap places between pages.
  //
  // It is part of the EFFECTIVE order used for the cursor, not just the ORDER BY.
  // Omitting it from the cursor is the bug that silently loses rows: with
  // ORDER BY name, two people named 王氏 share a sort key, so a cursor holding
  // only the name cannot say "after the second one" — name > '王氏' skips both,
  // and the second never appears in any page. The order the cursor describes MUST
  // be the order the rows actually come in.
  // The tiebreak direction follows the leading sort direction rather than being
  // hardcoded ASC. `ORDER BY name DESC, id ASC` is a mixed-direction sort: no
  // index can satisfy it, and the keyset predicate cannot use its row-value form,
  // so it falls back to the unrolled OR and scans. Making it
  // `ORDER BY name DESC, id DESC` lets `idx_entities_type_name_id` be walked
  // backwards and keeps the compact predicate available. The tiebreak only has to
  // be stable and total — which direction it runs in is free to choose.
  const tiebreakDir = orderBy[0].dir === 'desc' ? 'desc' : 'asc';
  const effectiveOrder = orderBy.some((o) => o.field === 'id')
    ? orderBy
    : [...orderBy, { field: 'id', dir: tiebreakDir }];

  // Cursor. Applied as a condition, so it composes with the filters rather than
  // replacing them: page 2 of a filtered list is still filtered.
  const cursorKey = decodeCursor(cursor, effectiveOrder);
  if (cursorKey) {
    const k = keysetPredicate(effectiveOrder, cursorKey);
    if (k) {
      conds.push(k);
      params.push(...k.params);
    }
  }

  // Every element of `conds` must be a compiled fragment. Asserting it here turns
  // "a descriptor leaked into the SQL" from a parse error at query time (or, worse,
  // a `[object Object]` literal that happens to parse) into a loud failure at
  // compile time.
  for (const c of conds) {
    if (!c || typeof c.sql !== 'string') {
      reject(`internal: uncompiled condition fragment ${JSON.stringify(c)}`, 'INTERNAL');
    }
  }
  const whereSql = conds.length ? `WHERE ${conds.map((c) => c.sql).join(' AND ')}` : '';

  const orderSql = effectiveOrder
    .map((o) => `${ORDER_SPECS[o.field].column} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`)
    .join(', ');

  sql.push(`SELECT e.id, e.type, e.name, e.summary, e.valid_from, e.valid_to, e.folder`);
  // An index hint is emitted only when a condition asks for one AND no other
  // condition has already pinned a different index. Hints are hard bindings: if
  // the named index is dropped the query fails loudly rather than silently going
  // slow, which is the failure mode we want for a 200x difference.
  //
  // This is the one place the compiler names an index. It is justified because the
  // planner's choice is measurably wrong rather than merely suboptimal, and there
  // is no way to express "use the partial index" in SQLite's own terms. The test
  // suite asserts the index exists, so a schema change that removes it fails
  // immediately instead of at runtime.
  const hint = indexHints.length === 1 ? ` INDEXED BY ${indexHints[0]}` : '';
  sql.push(`FROM entities e${hint}`);
  if (whereSql) sql.push(whereSql);
  sql.push(`ORDER BY ${orderSql}`);
  sql.push('LIMIT ?');
  params.push(n + 1); // one extra row tells us whether there is a next page

  return { sql: sql.join('\n'), params, orderBy: effectiveOrder, limit: n };
}

/**
 * Run a query description against a database handle.
 *
 * Returns `{ rows, nextCursor, hasMore }`. `nextCursor` is null on the last page.
 * The extra row requested by `compile()` is consumed here, never returned.
 */
function run(db, desc) {
  const { sql, params, orderBy, limit } = compile(desc);
  const raw = db.prepare(sql).all(...params);
  const hasMore = raw.length > limit;
  const rows = hasMore ? raw.slice(0, limit) : raw;
  // The cursor is built from the RAW row, not the shaped one: the shaped object
  // exposes `lifespan.start`, but the sort keys are the underlying column names
  // (`birthDate` -> valid_from). Reading the sort key off the shaped row would
  // quietly encode undefined and break paging on every non-id sort.
  const nextCursor = hasMore ? encodeCursor(orderBy, rows[rows.length - 1]) : null;
  return {
    rows: rows.map(shapeRow),
    nextCursor,
    hasMore,
  };
}

/** Turn a flat row into the shape the frontend expects. */
function shapeRow(row) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    summary: row.summary || '',
    folder: row.folder,
    lifespan: {
      start: row.valid_from,
      end: row.valid_to,
    },
  };
}

module.exports = {
  FIELD_SPECS,
  ORDER_SPECS,
  CURSOR_FIELDS,
  QueryError,
  compile,
  run,
  encodeCursor,
  decodeCursor,
  ftsPhrase,
  likePrefix,
  keysetPredicate,
};
