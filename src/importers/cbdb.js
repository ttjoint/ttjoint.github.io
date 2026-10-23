'use strict';
/**
 * CBDB (China Biographical Database) importer.
 *
 * CBDB is the single largest source in this project: ~660k persons, ~560k kinship
 * relations, ~590k office appointments, ~460k addresses. The importer is therefore
 * *streaming and batched* — it never materialises the whole DB in memory, and it
 * emits one import batch per dynasty slice so progress is resumable and reviewable.
 *
 * The CBDB SQLite file is not tracked in Git; obtain it separately and pass its path.
 *
 * Mapping:
 *   BIOG_MAIN              → person nodes (name, aliases, birth/death, gender)
 *   KIN_DATA + KINSHIP_CODES → kinship edges using our predicate primitives
 *   POSTED_TO_OFFICE_DATA  → memberOf edges with role + time range
 *   ASSOC_DATA + ASSOC_CODES → social edges (teacher/student/friend/colleague…)
 *   BIOG_ADDR_DATA         → residedAt / bornAt edges (literal place names)
 */

const path = require('path');
const { julianToJdn, fuzzyRange, pointRange } = require('../time/julian');
const { makeEdge } = require('../core/graph');

/** CBDB uses negative/sentinel years; treat anything outside this as unknown. */
const YEAR_MIN = -3000;
const YEAR_MAX = 2100;

function validYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  if (n < YEAR_MIN || n > YEAR_MAX) return null;
  if (n === 0) return null; // CBDB uses 0 for "unknown" in year columns
  return Math.round(n);
}

/**
 * Build a TimeRange from CBDB year/month/day columns.
 * Missing endpoints are left null so "only death known" stays expressible.
 */
function rangeFromCbdb({ birthyear, by_month, by_day, deathyear, dy_month, dy_day } = {}) {
  const by = validYear(birthyear);
  const dy = validYear(deathyear);
  if (by == null && dy == null) return null;
  const start = by != null ? julianToJdn(by, by_month || 7, by_day || 1) : null;
  const end = dy != null ? julianToJdn(dy, dy_month || 7, dy_day || 1) : null;
  const mid = start != null && end != null ? Math.round((start + end) / 2) : (start ?? end);
  return {
    start,
    end,
    mid,
    uncertainty: 0,
    precision: birthyear && by_month ? 'month' : 'year',
    source: 'cbdb',
  };
}

/**
 * CBDB kinship codes → our predicate keys.
 * Codes verified against KIN_DATA c_kin_code frequency (
 * 75=父 91752, 180=子 91488, 126=弟 57122, 125=兄 57097, 134=丈夫 29367,
 * 62=祖父 29018, 243=孙 28436, 135=妻子 25370, 48=曾祖 20140, 255=曾孙 19689,
 * 111=母 18894, 76=岳父 7955, 181=女婿 7178, 176=女儿 5245 ...).
 * Anything unmapped falls back to `kin`, then to the Chinese label.
 */
// Kinship codes are NOT hard-coded here any more.
//
// The previous table had fabrications: code 63 (妻之祖父) was mapped to
// teacherOf, code 64 (伯叔祖) to studentOf, codes 165/166 (長兄/季弟) to
// friend, and code 300 to sibling even though CBDB defines no such code.
// It also covered only 25 of CBDB's 488 kinship codes.
//
// Mappings are now derived from KINSHIP_CODES' own structural notation
// (c_kinrel: F=父 M=母 S=子 D=女 B=兄弟 Z=姊妹 H=夫 W=妻 C=妾 A=姻親 …)
// at import time, so every predicate is traceable to CBDB data and the whole
// table is covered. See src/importers/cbdb_kinship.js.
const kinship = require('./cbdb_kinship');

/**
 * CBDB ASSOC codes are *paired*: each social act has a forward and reverse code
 * (e.g. 22="為Y之學生" paired with the "teacher of Y" code). Rather than
 * enumerating hundreds of codes, map on the Chinese description and keep the
 * direction encoded in the description itself.
 */
const ASSOC_LABEL_MAP = [
  [/之學生|為Y之學生|學生/, 'studentOf'],
  [/之老師|為Y之老師|師/, 'teacherOf'],
  [/^友$|為友|友好/, 'friend'],
  [/同僚|同事|同官/, 'colleague'],
  [/推薦|薦|舉/, 'recommendedBy'],
];

/** Legacy numeric map, kept for datasets that use the older code scheme. */
const ASSOC_MAP = {
  1: 'teacherOf', 2: 'teacherOf', 3: 'studentOf',
  10: 'colleague', 11: 'colleague', 12: 'colleague',
  20: 'friend', 21: 'friend',
  30: 'kin', 31: 'kin',
  40: 'friend', 41: 'friend',
  50: 'teacherOf', 51: 'studentOf',
  60: 'friend', 61: 'friend',
  70: 'kin', 71: 'kin',
  80: 'recommendedBy', 81: 'recommended',
  90: 'kin', 91: 'kin',
};

function assocPredicate(code, descChn) {
  const desc = String(descChn || '').trim();
  if (desc) {
    for (const [re, key] of ASSOC_LABEL_MAP) if (re.test(desc)) return key;
  }
  // 说不出的关系不建边。`kin` 兜底已删除（与 era/tags 同类的杂物箱）。
  return ASSOC_MAP[code] || null;
}

/**
 * Resolve a CBDB kinship code to one of our predicates.
 *
 * Delegates to src/importers/cbdb_kinship.js, which derives the mapping from
 * KINSHIP_CODES.c_kinrel. There is deliberately no Chinese-label fallback any
 * more: the old one guessed from strings (「弟」→youngerSibling, 「姊」→youngerSibling) and
 * produced wrong directions for exactly the labels it did not enumerate.
 *
 * @param {object} db      sql.js database, used to build the map once
 * @param {number} code    c_kin_code
 * @param {string} labelChn unused; kept so call sites keep working
 * @param {Map}    [cache] optional pre-built map from kinship.buildKinshipMap
 * @returns {string|null} predicate key, or null when the code is unknown
 */
function kinPredicate(db, code, labelChn, cache) {
  const map = cache || kinship.buildKinshipMap(db, readRows);
  const hit = map.get(code);
  if (hit && hit.key) return hit.key;
  // 未知码不建边。以前返回 `kin`，等于把「不知道」记成一条事实。
  return null;
}
/** Deterministic person id, identical to the project-wide scheme. */
function personId(personid) {
  return `cbdb:${personid}`;
}

/**
 * Read a whole table as objects using sql.js. Accepts an optional WHERE clause
 * and parameter binding so callers can slice by dynasty or year.
 */
function readRows(db, table, where = '', params = []) {
  const sql = `SELECT * FROM "${table}"${where ? ' WHERE ' + where : ''}`;
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function tableColumns(db, table) {
  try {
    return db.exec(`PRAGMA table_info("${table}")`)[0].values.map(v => v[1]);
  } catch {
    return [];
  }
}

function hasTable(db, table) {
  const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
  return !!(r[0] && r[0].values.length);
}

/**
 * Extract one person slice from CBDB.
 *
 * @param {object} db      sql.js Database
 * @param {object} opts
 * @param {number[]} opts.personIds  limit to these CBDB person ids
 * @param {string}   opts.where      raw SQL predicate on BIOG_MAIN
 * @param {number}   opts.limit
 * @param {boolean}  opts.withRelations include kinship/office/assoc edges
 * @returns {{persons: object[], edges: object[], stats: object}}
 */
function extractPersons(db, opts = {}) {
  const { personIds = null, where = '', limit = 0, withRelations = true } = opts;

  let sql = 'SELECT * FROM BIOG_MAIN';
  const clauses = [];
  if (where) clauses.push(where);
  if (personIds && personIds.length) clauses.push(`c_personid IN (${personIds.join(',')})`);
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  if (limit) sql += ` LIMIT ${limit}`;

  const stmt = db.prepare(sql);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  // c_personid = 0 is CBDB's "未詳" placeholder, not a real person.
  const real = rows.filter(r => r.c_personid && r.c_personid !== 0);
  const ids = new Set(real.map(r => r.c_personid));
  const stats = { persons: real.length, kin: 0, offices: 0, assoc: 0, addresses: 0, aliases: 0 };

  // --- alt names (字/号/别名) ---
  const altByPerson = new Map();
  if (hasTable(db, 'ALTNAME_DATA') && ids.size) {
    for (const a of readRows(db, 'ALTNAME_DATA')) {
      if (!ids.has(a.c_personid)) continue;
      const nm = String(a.c_altname_chn || '').trim();
      if (!nm) continue;
      if (!altByPerson.has(a.c_personid)) altByPerson.set(a.c_personid, []);
      altByPerson.get(a.c_personid).push(nm);
      stats.aliases++;
    }
  }

  // --- addresses ---
  const addrByPerson = new Map();
  if (hasTable(db, 'BIOG_ADDR_DATA') && ids.size) {
    const addrCodes = new Map();
    for (const c of readRows(db, 'ADDR_CODES')) addrCodes.set(c.c_addr_id, c.c_name_chn);
    for (const a of readRows(db, 'BIOG_ADDR_DATA')) {
      if (!ids.has(a.c_personid)) continue;
      const name = addrCodes.get(a.c_addr_id);
      if (!name) continue;
      if (!addrByPerson.has(a.c_personid)) addrByPerson.set(a.c_personid, []);
      addrByPerson.get(a.c_personid).push({ name, typeCode: a.c_addr_type });
      stats.addresses++;
    }
  }

  const persons = real.map(r => {
    const id = personId(r.c_personid);
    const life = rangeFromCbdb({
      birthyear: r.c_birthyear, by_month: r.c_by_month, by_day: r.c_by_day,
      deathyear: r.c_deathyear, dy_month: r.c_dy_month, dy_day: r.c_dy_day,
    });
    const props = {};
    if (r.c_birthyear) props['出生年月'] = `${r.c_birthyear}年${r.c_by_month ? r.c_by_month + '月' : ''}`;
    if (r.c_deathyear) props['逝世时间'] = `${r.c_deathyear}年${r.c_dy_month ? r.c_dy_month + '月' : ''}`;
    if (r.c_female === 1) props['性别'] = '女';
    else if (r.c_female === 0) props['性别'] = '男';
    if (r.c_notes) props['简介'] = String(r.c_notes);

    const addrs = addrByPerson.get(r.c_personid) || [];
    const born = addrs.find(a => a.typeCode === 1);
    const resident = addrs.find(a => a.typeCode === 2);
    if (born) props['籍贯'] = born.name;
    else if (resident) props['籍贯'] = resident.name;

    return {
      id,
      type: 'person',
      name: String(r.c_name_chn || r.c_name || '').trim() || personId(r.c_personid),
      aliases: [...new Set(altByPerson.get(r.c_personid) || [])].slice(0, 8),
      props,
      lifespan: life,
      external: { cbdbPersonId: r.c_personid, dynasty: r.c_dy || null },
      sources: [{ name: 'CBDB', url: 'https://cbdb.fas.harvard.edu/', accessedAt: new Date().toISOString() }],
    };
  });

  const edges = [];
  if (withRelations && ids.size) {
    edges.push(...extractKinEdges(db, ids, stats));
    edges.push(...extractOfficeEdges(db, ids, stats));
    edges.push(...extractAssocEdges(db, ids, stats));
  }
  return { persons, edges, stats };
}

function extractKinEdges(db, ids, stats) {
  if (!hasTable(db, 'KIN_DATA')) return [];
  // Build the code -> predicate map once per extraction, straight from
  // KINSHIP_CODES, so all 488 codes are covered and every predicate is
  // traceable to CBDB's own c_kinrel notation.
  const kinMap = hasTable(db, 'KINSHIP_CODES')
    ? kinship.buildKinshipMap(db, readRows)
    : new Map();

  if (!stats.kinshipCoverage) {
    stats.kinshipCoverage = kinship.kinshipCoverage(kinMap);
    const problems = kinship.assertNoDirectionInversion(kinMap);
    if (problems.length) {
      // A parent mapped to a child predicate is the exact bug the old hand
      // tables shipped; fail loudly rather than write a reversed tree.
      throw new Error('CBDB kinship mapping inverts direction: ' + problems.join('; '));
    }
  }

  const edges = [];
  // 边级出处需要书名表。KIN_DATA 的 c_source 指向 TEXT_CODES。
  const titles = require('./cbdb_provenance').buildTextTitles(readRows, db);
  const { provenanceFromKinRow } = require('./cbdb_provenance');
  for (const k of readRows(db, 'KIN_DATA')) {
    if (!ids.has(k.c_personid) || !ids.has(k.c_kin_id)) continue;
    const meta = kinMap.get(k.c_kin_code) || {};
    // 说不出具体关系的不建边（`kin` 兜底已删除）。
    if (!meta.key) continue;
    edges.push(makeEdge({
      key: meta.key,
      subject: personId(k.c_personid),
      object: personId(k.c_kin_id),
      // Keep CBDB's own label plus the derived generational path, so an
      // imported edge can always be explained ("父之父" for code 48).
      note: [meta.chainLabel, meta.chain && meta.chain.length > 1 ? meta.chain.join('') : '']
        .filter(Boolean).join(' / '),
      sourceUrl: 'https://cbdb.fas.harvard.edu/',
      // 这条断言出自 KIN_DATA 的哪一行。
      provenance: provenanceFromKinRow(k, { titles, kinLabel: meta.chainLabel || '' }),
    }));
    stats.kin++;
    if (meta.resolved === false) stats.kinUnresolved = (stats.kinUnresolved || 0) + 1;
  }
  return edges;
}

function extractOfficeEdges(db, ids, stats) {
  if (!hasTable(db, 'POSTED_TO_OFFICE_DATA')) return [];
  const offices = new Map();
  if (hasTable(db, 'OFFICE_CODES')) {
    for (const o of readRows(db, 'OFFICE_CODES')) offices.set(o.c_office_id, o.c_office_chn);
  }
  const edges = [];
  for (const p of readRows(db, 'POSTED_TO_OFFICE_DATA')) {
    if (!ids.has(p.c_personid)) continue;
    const range = rangeFromCbdb({ birthyear: p.c_firstyear, deathyear: p.c_lastyear });
    const role = offices.get(p.c_office_id) || p.c_notes || '';
    if (!role) continue;
    edges.push(makeEdge({
      key: 'memberOf',
      subject: personId(p.c_personid),
      object: role,
      literal: true,
      role,
      range,
      sourceUrl: 'https://cbdb.fas.harvard.edu/',
    }));
    stats.offices++;
  }
  return edges;
}

function extractAssocEdges(db, ids, stats) {
  if (!hasTable(db, 'ASSOC_DATA')) return [];
  const descs = new Map();
  if (hasTable(db, 'ASSOC_CODES')) {
    for (const c of readRows(db, 'ASSOC_CODES')) {
      descs.set(c.c_assoc_code, c.c_assoc_desc_chn || c.c_assoc_desc || '');
    }
  }
  const edges = [];
  for (const a of readRows(db, 'ASSOC_DATA')) {
    if (!ids.has(a.c_personid) || !ids.has(a.c_assoc_id)) continue;
    const key = assocPredicate(a.c_assoc_code, descs.get(a.c_assoc_code));
    edges.push(makeEdge({
      key,
      subject: personId(a.c_personid),
      object: personId(a.c_assoc_id),
      note: descs.get(a.c_assoc_code) || '',
      sourceUrl: 'https://cbdb.fas.harvard.edu/',
    }));
    stats.assoc++;
  }
  return edges;
}

/** List dynasty buckets so an import can be sliced into reviewable batches. */
function listDynasties(db) {
  if (!hasTable(db, 'DYNASTIES')) return [];
  const counts = new Map();
  for (const r of readRows(db, 'BIOG_MAIN')) {
    const dy = r.c_dy;
    if (dy == null) continue;
    counts.set(dy, (counts.get(dy) || 0) + 1);
  }
  const names = new Map();
  for (const d of readRows(db, 'DYNASTIES')) names.set(d.c_dy, d.c_dynasty_chn);
  return [...counts.entries()]
    .map(([dy, count]) => ({ dynasty: dy, name: names.get(dy) || String(dy), count }))
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  YEAR_MIN,
  YEAR_MAX,
  validYear,
  rangeFromCbdb,
  kinship,
  ASSOC_MAP,
  assocPredicate,
  kinPredicate,
  personId,
  readRows,
  tableColumns,
  hasTable,
  extractPersons,
  listDynasties,
};
