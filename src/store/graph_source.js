'use strict';
/**
 * Storage layer.
 *
 * Two physical stores, one interface:
 *
 *   GraphSource  — loads canonical JSON (data/<type>/index.json + entity shards)
 *                  into a GraphStore. Used by the static site and by tooling.
 *   (future) SQLiteSource — the admin database; implements the same read API so
 *                  the UI code does not care where the data came from.
 *
 * The canonical on-disk format stays human-diffable JSON so Git history remains
 * meaningful. The graph index is derived, never authoritative.
 */

const fs = require('fs');
const path = require('path');
const { GraphStore, makeEdge } = require('../core/graph');
const { PredicateRegistry } = require('../predicates/registry');
const { pointRange, parseYearMonth, parseFuzzy, parseOpenRange, fuzzyRange, lifespanRange, PRECISION } = require('../time/julian');

const ENTITY_FOLDERS = require('./entity_types').FOLDERS;

function dataRoot(rootDir) {
  return path.join(rootDir || path.join(__dirname, '..', '..'), 'data');
}

/**
 * Load project-specific predicate extensions from data/predicates/registry.json.
 * Missing or malformed files are non-fatal: the builtin registry stays usable and
 * the problem is reported so it cannot pass silently.
 */
function loadPredicateExtensions(rootDir) {
  const file = path.join(dataRoot(rootDir), 'predicates', 'registry.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.predicates;
    if (!Array.isArray(list)) {
      console.error(`predicate registry ${file}: expected a "predicates" array`);
      return [];
    }
    return list.filter(p => p && p.key);
  } catch (err) {
    console.error(`predicate registry ${file}: ${err.message}`);
    return [];
  }
}

/** Build the registry used across the app: builtins first, extensions second. */
function createRegistry(rootDir) {
  const { BUILTIN } = require('../predicates/registry');
  return new PredicateRegistry([...BUILTIN, ...loadPredicateExtensions(rootDir)]);
}

function loadEntityFiles(rootDir) {
  const base = dataRoot(rootDir);
  const out = [];
  for (const [type, folder] of Object.entries(ENTITY_FOLDERS)) {
    const dir = path.join(base, folder, 'entities');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!e.id) continue;
        out.push(e);
      } catch (err) {
        console.error(`skip unreadable shard ${folder}/${f}: ${err.message}`);
      }
    }
  }
  return out;
}

/** Parse a stored date prop into a TimeRange, tolerating fuzzy text. */
function rangeFromProp(value) {
  if (!value) return null;
  const s = String(value);
  const fuzzy = parseFuzzy(s);
  if (fuzzy) return fuzzyRange(fuzzy.year, fuzzy.radius);
  const parsed = parseYearMonth(s);
  if (!parsed) return null;
  return pointRange(parsed);
}

/**
 * Build the lifespan range for a person from 出生年月 / 逝世时间.
 *
 * `生卒` is the fallback: CBDB's `c_index_year` is sometimes the only date a person
 * has, and it is an activity year, not a birth. It was previously written into a
 * prose field that nothing read, which is why **every person in the corpus had
 * `lifespan === null`** and the timeline matched nothing. It is a single endpoint,
 * so it becomes a start-only range: claiming it as a death year would be equally
 * wrong.
 */
function lifespanFromProps(props = {}) {
  const birth = props['出生年月'] || props['出生日期'];
  const death = props['逝世时间'] || props['逝世日期'];
  if (!birth && !death) {
    // Only an activity year is known. Keep it distinguishable from a birth so a
    // query for "born 1220" does not silently include "active 1220".
    const indexYear = props['生卒'];
    if (!indexYear) return null;
    const parsed = parseYearMonth(String(indexYear));
    return parsed ? pointRange(parsed) : null;
  }
  // 带 ± 的模糊日期（CBDB 的 `around` 精度，如「约 1104年 ± 30」）必须走
  // `birthFuzzy`/`deathFuzzy`，否则 `lifespanRange` 只会调 `parseYearMonth`，
  // 而后者对「约」前缀无能为力，整个区间就变成 null——时间线与日期查询静默失配。
  const birthFuzzy = birth ? parseFuzzy(birth) : null;
  const deathFuzzy = death ? parseFuzzy(death) : null;
  if (birthFuzzy || deathFuzzy) {
    return lifespanRange({ birth, death, birthFuzzy, deathFuzzy });
  }
  // 「之前 / 之后」是开口区间：只知一端。
  // 注意两端语义：start 来自出生，end 来自死亡。若出生写作「1104年之前」，
  // 它给出的是出生的**上界**，不能直接当作寿命的 start（那是下界）——
  // 不能声称此人出生于 1104 年或之后。这类情况下宁可保留开口，用 mid 表达位置。
  const bOpen = birth ? parseOpenRange(birth) : null;
  const dOpen = death ? parseOpenRange(death) : null;
  if (bOpen || dOpen) {
    // 出生给出下界（start）、死亡给出上界（end）才是完整区间。
    // 若出生是「之后」（下界已知）或死亡是「之前」（上界已知），也能直接用作 start/end。
    // 反之（出生「之前」、死亡「之后」）只给了一个约束方向，不能当作寿命边界，
    // 只能当作定位锚点。
    const start = (bOpen && bOpen.start != null) ? bOpen.start : null;
    const end = (dOpen && dOpen.end != null) ? dOpen.end : null;
    const mid = (bOpen || dOpen).mid;
    // 单独标记锚点方向，供 formatRange 区分「之前」与「之后」。
    let openDir = null;
    if (start == null && end == null) {
      if (bOpen && bOpen.end != null) openDir = 'before';
      else if (dOpen && dOpen.start != null) openDir = 'after';
    }
    return { start, end, mid, uncertainty: 0, precision: PRECISION.UNKNOWN, source: 'open', openDir };
  }
  return lifespanRange({ birth, death });
}

/**
 * Load canonical data into a GraphStore.
 * @param {object} opts
 * @param {string} opts.rootDir project root (defaults to repo root)
 * @param {PathLike[]} opts.only restrict to specific folders (unused for now)
 */
function loadGraph(opts = {}) {
  const registry = opts.registry || createRegistry(opts.rootDir);
  const store = new GraphStore({ registry });
  const entities = opts.entities || loadEntityFiles(opts.rootDir);

  for (const e of entities) {
    const props = e.props || {};
    const node = {
      id: e.id,
      type: e.type,
      name: e.name || e.legacyId || e.id,
      aliases: e.aliases || [],
      summary: (props['简介'] || props['描述'] || e.summary || '').slice(0, 400),
      props,
      external: e.external || null,
      lifespan: e.type === 'person' ? lifespanFromProps(props) : rangeFromProp(props['存在时间'] || props['成立时间']),
      createdAt: e.createdAt || null,
      // Evidence carries its own attributes; keep them reachable from the node.
      ...(e.type === 'evidence'
        ? {
          carrier: e.carrier || null,
          medium: e.medium || null,
          documentedAt: e.documentedAt || null,
          url: e.url || '',
          reliability: e.reliability == null ? null : e.reliability,
          unresolved: !!e.unresolved,
        }
        : {}),
    };
    store.addNode(node);
  }

  // Name lookup is needed before any edge is built (positions name their org,
  // relations name their target), so index once here.
  const nameIndex = new NameIndex([...store.nodes.values()]);
  // `sources` may hold inline objects (legacy) or evidence ids (post-migration),
  // so go through the compat layer rather than indexing sources[0].url — that
  // expression is undefined for the new shape and the URL silently vanished.
  const { preferredUrl } = require('./sources');
  const evidenceById = new Map(entities.filter((x) => x.type === 'evidence').map((x) => [x.id, x]));
  for (const e of entities) {
    const sourceUrl = preferredUrl(e, (id) => evidenceById.get(id));
    addEntityEdges(store, e, sourceUrl, nameIndex);
  }

  return store;
}

/**
 * O(1) lookup of an entity id by its (or an alias) surface form.
 *
 * Building edges used to rescan every node for every position and every
 * relation, which is O(nodes × edges) — fine for 5k records, fatal at the
 * 600k scale the project targets. One index built after node creation keeps
 * edge construction linear.
 */
class NameIndex {
  constructor(nodes = []) {
    this.byName = new Map();
    this.ambiguous = new Set();
    for (const n of nodes) this.add(n);
  }

  add(node) {
    if (!node || !node.name) return;
    const keys = [node.name, ...(node.aliases || [])];
    for (const k of keys) {
      if (!k) continue;
      // Names are no longer unique: nine CBDB entities are called 韓氏. This index
      // resolves *labels* (an organization tag in a claim, a position's employer),
      // not identities, so a collision means the label is genuinely ambiguous.
      //
      // Silently keeping the first writer was tolerable when ids were name-derived
      // (there could only ever be one). Now it would attach a claim to whichever
      // 韓氏 happened to sort first, and nothing would report it. So: remember the
      // collision and refuse to resolve it.
      if (this.byName.has(k) && this.byName.get(k) !== node.id) {
        this.ambiguous.add(k);
      } else {
        this.byName.set(k, node.id);
      }
    }
  }

  /** True when `label` matches more than one entity. */
  isAmbiguous(label) {
    return this.ambiguous.has(label);
  }

  /** Optional type restriction (e.g. only organizations). */
  get(label, { type = null, nodes = null } = {}) {
    if (!label) return null;
    // A label that matches several entities cannot identify one of them. Returning
    // an arbitrary pick would make the caller's edge point at the wrong record.
    if (this.ambiguous.has(label)) return null;
    const id = this.byName.get(label);
    if (!id) return null;
    if (!type || !nodes) return id;
    const n = nodes.get(id);
    return n && n.type === type ? id : null;
  }
}

const ATTR_PREDICATES = {
  性别: 'gender',
  民族: 'ethnicity',
  学历: 'education',
  籍贯: 'residedAt',
  出生年月: 'birthDate',
  逝世时间: 'deathDate',
  存在时间: 'existedDuring',
  成立时间: 'foundedOn',
};

/**
 * Emit edges for one entity, upgrading scalar attributes to predicates so the
 * graph is the single indexing surface for both relations and facts.
 */
function addEntityEdges(store, e, sourceUrl, nameIndex = null) {
  const props = e.props || {};
  const claims = e.claims || {};

  // Evidence nodes have their own shape (carrier/document, not props/claims).
  // Handling them here rather than in a separate pass keeps one place that knows
  // "how does an entity project into the graph".
  if (e.type === 'evidence') {
    addEvidenceEdges(store, e);
    return;
  }

  for (const [prop, key] of Object.entries(ATTR_PREDICATES)) {
    const v = props[prop];
    if (!v) continue;
    if (key === 'residedAt' || key === 'bornAt') {
      store.addEdge(makeEdge({ key, subject: e.id, object: String(v), literal: true, sourceUrl }));
      continue;
    }
    store.addEdge(makeEdge({ key, subject: e.id, object: String(v), literal: true, sourceUrl }));
  }

  const positions = [...(claims.currentPositions || []), ...(claims.career || [])];
  for (const c of positions) {
    if (!c || (!c.role && !c.organization)) continue;
    const orgId = nameIndex
      ? nameIndex.get(c.organization, { type: 'organization', nodes: store.nodes })
      : resolveOrgId(store, c.organization);
    const r = c.start || c.end ? lifespanRange({ birth: c.start, death: c.end }) : null;
    if (orgId) {
      store.addEdge(makeEdge({ key: 'memberOf', subject: e.id, object: orgId, role: c.role || '', range: r, sourceUrl: c.sourceUrl || sourceUrl }));
    } else {
      store.addEdge(makeEdge({ key: 'memberOf', subject: e.id, object: c.role || c.organization, literal: true, role: c.role || '', range: r, sourceUrl: c.sourceUrl || sourceUrl }));
    }
  }

  for (const [rel, value] of Object.entries(e.relations || {})) {
    const key = store.registry.resolve(rel);
    if (!key) continue;
    const list = Array.isArray(value) ? value : [value];
    for (const v of list) {
      if (!v) continue;
      const target = typeof v === 'string' ? v : v.id || v.name;
      if (!target) continue;
      const targetNodeId = nameIndex
        ? nameIndex.get(target)
        : (() => { const n = resolveByName(store, target); return n ? n.id : null; })();
      const objectId = targetNodeId || target;
      store.addEdge(makeEdge({
        key,
        subject: e.id,
        object: objectId,
        literal: !targetNodeId,
        role: (v && v.role) || '',
        range: v && (v.start || v.end) ? lifespanRange({ birth: v.start, death: v.end }) : null,
      }));
    }
  }
}

/**
 * Project an evidence node into the graph.
 *
 * Two directions matter:
 *
 *   evidence --carriedBy--> thing        the newspaper/book that carried it
 *   evidence --documents--> subject      the entities the record is about
 *
 * The `documents` edges are built from `subjects` (entity ids) when present. A
 * carrier that does not resolve to an existing node is skipped rather than
 * emitted as a literal: an evidence node whose carrier is unknown is a data gap
 * recorded in its `unresolved` flag, not an assertion about a string.
 *
 * @param {object} store
 * @param {object} e  an evidence node
 */
function addEvidenceEdges(store, e) {
  if (e.carrier && store.nodes.has(e.carrier)) {
    store.addEdge(makeEdge({
      key: 'carriedBy',
      subject: e.id,
      object: e.carrier,
      range: e.documentedAt || null,
      sourceUrl: e.url || '',
      createdAt: e.accessedAt || undefined,
    }));
  }
  for (const id of e.subjects || []) {
    if (!id || !store.nodes.has(id)) continue;
    store.addEdge(makeEdge({
      key: 'documents',
      subject: e.id,
      object: id,
      range: e.documentedAt || null,
      sourceUrl: e.url || '',
      createdAt: e.accessedAt || undefined,
    }));
  }
}

/** Resolve an organization label to a node id when one matches. */
function resolveOrgId(store, label) {
  if (!label) return null;
  for (const n of store.nodes.values()) {
    if (n.type !== 'organization') continue;
    if (n.name === label) return n.id;
    if ((n.aliases || []).includes(label)) return n.id;
  }
  return null;
}

/** Linear fallback when no NameIndex is available (small fixtures, tests). */
function resolveByName(store, label) {
  if (!label) return null;
  for (const n of store.nodes.values()) {
    if (n.name === label || (n.aliases || []).includes(label)) return n;
  }
  return null;
}

module.exports = {
  ENTITY_FOLDERS,
  dataRoot,
  NameIndex,
  loadEntityFiles,
  loadGraph,
  loadPredicateExtensions,
  createRegistry,
  rangeFromProp,
  lifespanFromProps,
  ATTR_PREDICATES,
};
