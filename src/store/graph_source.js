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
const { pointRange, parseYearMonth, fuzzyRange, lifespanRange } = require('../time/julian');

const ENTITY_FOLDERS = { person: 'persons', organization: 'organizations', event: 'events' };

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
  // "约公元前1200年±50年" / "-1200±50"
  const fuzzy = s.match(/(?:约)?\s*(-?\d{1,5})\s*(?:年)?\s*(?:±|\+\/-)\s*(\d{1,4})/);
  if (fuzzy) return fuzzyRange(parseInt(fuzzy[1], 10), parseInt(fuzzy[2], 10));
  const parsed = parseYearMonth(s);
  if (!parsed) return null;
  return pointRange(parsed);
}

/** Build the lifespan range for a person from 出生年月 / 逝世时间. */
function lifespanFromProps(props = {}) {
  const birth = props['出生年月'] || props['出生日期'];
  const death = props['逝世时间'] || props['逝世日期'];
  if (!birth && !death) return null;
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
      tags: e.tags || [],
      summary: (props['简介'] || props['描述'] || e.summary || '').slice(0, 400),
      props,
      external: e.external || null,
      lifespan: e.type === 'person' ? lifespanFromProps(props) : rangeFromProp(props['存在时间'] || props['成立时间']),
      createdAt: e.createdAt || null,
    };
    store.addNode(node);
  }

  for (const e of entities) {
    const sourceUrl = (e.sources && e.sources[0] && e.sources[0].url) || (e.external && e.external.cpcUrl) || '';
    addEntityEdges(store, e, sourceUrl);
  }

  return store;
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
function addEntityEdges(store, e, sourceUrl) {
  const props = e.props || {};
  const claims = e.claims || {};

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
    const orgId = resolveOrgId(store, c.organization);
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
      const targetNode = [...store.nodes.values()].find(n => n.name === target) || null;
      const objectId = targetNode ? targetNode.id : target;
      store.addEdge(makeEdge({
        key,
        subject: e.id,
        object: objectId,
        literal: !targetNode,
        role: (v && v.role) || '',
        range: v && (v.start || v.end) ? lifespanRange({ birth: v.start, death: v.end }) : null,
      }));
    }
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

module.exports = {
  ENTITY_FOLDERS,
  dataRoot,
  loadEntityFiles,
  loadGraph,
  loadPredicateExtensions,
  createRegistry,
  rangeFromProp,
  lifespanFromProps,
  ATTR_PREDICATES,
};
