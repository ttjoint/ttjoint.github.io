'use strict';
/**
 * Graph core: nodes, edges, and the queryable store.
 *
 * Design goals
 *  - Entities are nodes with stable ids (`person:<20 hex>`).
 *  - Everything relational is an edge, including attributes such as 性别/出生地,
 *    so a single index can answer "all edges of predicate X" and
 *    "all edges touching node Y".
 *  - Every edge carries a TimeRange (Julian Day based) plus an ingestion
 *    timestamp, so the UI can filter by era and provenance can be audited.
 *  - Negated and inverse forms are stored explicitly (see predicates/registry),
 *    keeping query code branch-free.
 */

const {
  PredicateRegistry, modifier, isNegated, baseKey, splitModifiers, MODIFIER,
} = require('../predicates/registry');

const { ALL_TYPES: NODE_TYPES } = require('../store/entity_types');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Does an edge belong to the requested predicate view?
 *
 * - `father`          matches `father`, `father/inverse` (never `father/negate`)
 * - `father/negate`   matches exactly the negated form
 */
function matchPredicate(list, predicate, includeNegated) {
  const wanted = splitModifiers(predicate);
  const wantsNegate = wanted.mods.includes(MODIFIER.NEGATE);
  const base = wanted.base;
  return list.filter(e => {
    if (baseKey(e.key) !== base) return false;
    const negated = isNegated(e.key);
    if (negated) return wantsNegate || includeNegated;
    // A request for the negated form only returns negated edges.
    return !wantsNegate;
  });
}

/**
 * An edge:
 * {
 *   id, key          predicate key, may carry /inverse or /negate modifiers
 *   subject, object  node ids, or a literal string when object is a scalar
 *   literal          true when `object` is not a node id
 *   role             optional qualifier (官职/头衔)
 *   range            TimeRange | null   (validity of the assertion)
 *   note, sourceUrl, confidence
 *   provenance       [ { rawRef, locator, quote, reason, commitId } ] 这条断言出自哪里
 *   createdAt        ingestion time (never changes)
 * }
 *
 * `provenance` 挂在**边的每次实例**上，不是挂在谓词定义上。
 * 「张三是李四的父亲」这条断言出自 KIN_DATA 的某一行，而「王五是赵六的父亲」
 * 出自另一行——同一种谓词，两处出处。把它记在谓词表上等于说
 * 「所有父亲关系都出自同一份文献」，那是错的（§6.1）。
 */
function makeEdge({ key, subject, object, literal = false, role = '', range = null, note = '', sourceUrl = '', confidence = 1, provenance = null, createdAt }) {
  if (!key) throw Error('edge requires a predicate key');
  if (!subject) throw Error('edge requires a subject');
  if (object == null || object === '') throw Error('edge requires an object');
  // The id must distinguish parallel edges: a person holds several posts, several
  // literal-valued assertions share the same predicate, etc. Include the object
  // value (also for literals) and the role/qualifier in the digest.
  const qualifier = role || '';
  const span = range ? (range.mid ?? range.start ?? 0) : 0;
  const id = `edge:${subject}|${key}|${literal ? 'lit:' : ''}${object}|${qualifier}|${span}`;
  return {
    id,
    key,
    subject,
    object,
    literal,
    role: role || '',
    range: range || null,
    note: note || '',
    sourceUrl: sourceUrl || '',
    confidence: Number.isFinite(confidence) ? confidence : 1,
    provenance: Array.isArray(provenance) && provenance.length ? provenance : null,
    createdAt: createdAt || nowIso(),
  };
}

class GraphStore {
  constructor({ registry } = {}) {
    this.registry = registry || new PredicateRegistry();
    this.nodes = new Map();          // id -> node
    this.outEdges = new Map();       // id -> [edge]
    this.inEdges = new Map();        // id -> [edge]
    this.byPredicate = new Map();    // baseKey -> [edge]
    this.byRawKey = new Map();       // raw key -> [edge]
    this._edgeSeen = new Set();
    this.stats = { nodes: 0, edges: 0, skippedDuplicateEdges: 0 };
  }

  addNode(node) {
    if (!node || !node.id) throw Error('node requires an id');
    if (!NODE_TYPES.includes(node.type)) throw Error(`unknown node type: ${node.type}`);
    this.nodes.set(node.id, node);
    if (!this.outEdges.has(node.id)) this.outEdges.set(node.id, []);
    if (!this.inEdges.has(node.id)) this.inEdges.set(node.id, []);
    this.stats.nodes = this.nodes.size;
    return node;
  }

  hasNode(id) {
    return this.nodes.has(id);
  }

  addEdge(edge) {
    if (this._edgeSeen.has(edge.id)) {
      this.stats.skippedDuplicateEdges++;
      return null;
    }
    this._edgeSeen.add(edge.id);
    for (const end of [edge.subject, edge.literal ? null : edge.object]) {
      if (end && !this.nodes.has(end)) this.addNode({ id: end, type: 'person', name: end, stub: true });
    }
    if (!this.outEdges.has(edge.subject)) this.outEdges.set(edge.subject, []);
    this.outEdges.get(edge.subject).push(edge);
    if (!edge.literal) {
      if (!this.inEdges.has(edge.object)) this.inEdges.set(edge.object, []);
      this.inEdges.get(edge.object).push(edge);
    }
    const b = baseKey(edge.key);
    if (!this.byPredicate.has(b)) this.byPredicate.set(b, []);
    this.byPredicate.get(b).push(edge);
    if (!this.byRawKey.has(edge.key)) this.byRawKey.set(edge.key, []);
    this.byRawKey.get(edge.key).push(edge);
    this.stats.edges++;
    return edge;
  }

  node(id) {
    return this.nodes.get(id) || null;
  }

  /**
   * All edges leaving a node, optionally filtered by predicate.
   *
   * Matching is by **base** predicate, so `father` also matches `father/inverse`,
   * but *not* `father/negate`: a negated assertion says the relation is false and
   * must never leak into a positive relation listing. Ask for it explicitly with
   * `{ includeNegated: true }` or by passing the literal key `father/negate`.
   */
  outgoings(id, predicate = null, { includeNegated = false } = {}) {
    const list = this.outEdges.get(id) || [];
    if (!predicate) return includeNegated ? list : list.filter(e => !isNegated(e.key));
    return matchPredicate(list, predicate, includeNegated);
  }

  /** All edges pointing at a node (same negate rules as `outgoings`). */
  incomings(id, predicate = null, { includeNegated = false } = {}) {
    const list = this.inEdges.get(id) || [];
    if (!predicate) return includeNegated ? list : list.filter(e => !isNegated(e.key));
    return matchPredicate(list, predicate, includeNegated);
  }

  /**
   * Edges with a given predicate, in either direction.
   * Passing 'father' also returns 'childOfFather' edges, because the registry
   * declares them as inverses of one another and callers almost always want the
   * whole family of assertions rather than one storage orientation.
   */
  edgesByPredicate(predicate, { includeNegated = false } = {}) {
    const base = baseKey(predicate);
    const keep = list => (includeNegated ? list : list.filter(e => !isNegated(e.key)));
    const direct = keep(this.byPredicate.get(base) || []);
    const inv = this.registry.inverseKey(base);
    if (!inv || inv === base) return direct;
    const inverseList = keep(this.byPredicate.get(inv) || []);
    if (!inverseList.length) return direct;
    // Deduplicate defensively: a symmetric predicate can appear on both sides.
    const seen = new Set(direct.map(e => e.id));
    return direct.concat(inverseList.filter(e => !seen.has(e.id)));
  }

  /**
   * Neighbours of a node as { key, label, node, direction, role, range }.
   * Applies an optional time window so the UI can page through eras.
   */
  neighbours(id, { predicate = null, lo = null, hi = null, includeNegated = false } = {}) {
    const out = [];
    const push = (e, direction) => {
      if (!includeNegated && isNegated(e.key)) return;
      if (lo != null && hi != null && e.range) {
        const s = e.range.start ?? e.range.mid;
        const t = e.range.end ?? e.range.mid;
        if (s != null && t != null && (s > hi || t < lo)) return;
      }
      const otherId = direction === 'out' ? e.object : e.subject;
      // Literal-valued assertions (性别/学历/职位名) are part of the neighbourhood too;
      // they surface as pseudo-nodes so the UI can render and filter them uniformly.
      if (e.literal) {
        out.push({
          key: e.key,
          label: this.registry.label(baseKey(e.key)),
          node: { id: null, type: 'literal', name: e.object },
          direction,
          role: e.role,
          range: e.range,
          literal: true,
        });
        return;
      }
      out.push({
        key: e.key,
        label: this.registry.label(baseKey(e.key)),
        node: this.nodes.get(otherId) || { id: otherId, type: 'unknown', name: otherId },
        direction,
        role: e.role,
        range: e.range,
      });
    };
    for (const e of this.outgoings(id, predicate, { includeNegated })) push(e, 'out');
    for (const e of this.incomings(id, predicate, { includeNegated })) push(e, 'in');
    return out;
  }

  /** Undirected neighbourhood as BFS, for graph visualisation. */
  subgraph(seedIds, { depth = 1, maxNodes = 200, lo = null, hi = null } = {}) {
    const seeds = Array.isArray(seedIds) ? seedIds : [seedIds];
    const keep = new Set();
    const edges = [];
    const queue = seeds.map(id => ({ id, d: 0 }));
    while (queue.length && keep.size < maxNodes) {
      const { id, d } = queue.shift();
      if (keep.has(id)) continue;
      keep.add(id);
      if (d >= depth) continue;
      for (const e of [...this.outgoings(id), ...this.incomings(id)]) {
        if (isNegated(e.key)) continue;
        if (lo != null && hi != null && e.range) {
          const s = e.range.start ?? e.range.mid;
          const t = e.range.end ?? e.range.mid;
          if (s != null && t != null && (s > hi || t < lo)) continue;
        }
        edges.push(e);
        if (!e.literal) {
          for (const end of [e.subject, e.object]) {
            if (!keep.has(end)) queue.push({ id: end, d: d + 1 });
          }
        }
      }
    }
    const nodes = [...keep].map(id => this.nodes.get(id)).filter(Boolean);
    const nodeIds = new Set(nodes.map(n => n.id));
    return {
      nodes,
      edges: edges.filter(e => nodeIds.has(e.subject) && (e.literal || nodeIds.has(e.object))),
    };
  }

  /** Aggregated statistics used by the UI overview panel. */
  summary() {
    const byPredicate = {};
    for (const [k, list] of this.byPredicate) byPredicate[k] = list.length;
    const byType = {};
    for (const n of this.nodes.values()) byType[n.type] = (byType[n.type] || 0) + 1;
    return {
      nodes: this.nodes.size,
      edges: this.stats.edges,
      skippedDuplicateEdges: this.stats.skippedDuplicateEdges,
      byType,
      byPredicate,
      predicates: this.registry.list().length,
    };
  }
}

/**
 * Convert a legacy entity (props/claims/relations shape) into graph nodes+edges.
 * Keeps every pre-existing hook working while the new model takes over.
 */
function edgesFromLegacyEntity(entity, { sourceUrl = '' } = {}) {
  const edges = [];
  const props = entity.props || {};
  const claims = entity.claims || {};

  // Scalar attributes become literal edges so they are searchable like relations.
  const ATTR_MAP = {
    性别: 'gender',
    籍贯: 'residedAt',
    民族: 'ethnicity',
    学历: 'education',
    出生年月: 'birthDate',
  };
  for (const [prop, key] of Object.entries(ATTR_MAP)) {
    const v = props[prop];
    if (!v) continue;
    edges.push(makeEdge({ key, subject: entity.id, object: String(v), literal: true, sourceUrl }));
  }

  for (const c of claims.currentPositions || []) {
    if (!c || !c.role) continue;
    edges.push(makeEdge({ key: 'memberOf', subject: entity.id, object: c.organization || c.role, literal: !c.organization, role: c.role, sourceUrl: c.sourceUrl || sourceUrl }));
  }
  for (const c of claims.career || []) {
    if (!c || !c.role) continue;
    edges.push(makeEdge({ key: 'memberOf', subject: entity.id, object: c.organization || c.role, literal: !c.organization, role: c.role, sourceUrl: c.sourceUrl || sourceUrl }));
  }

  for (const [rel, value] of Object.entries(entity.relations || {})) {
    const key = (entity._registry && entity._registry.resolve(rel)) || null;
    if (!key) continue;
    const list = Array.isArray(value) ? value : [value];
    for (const v of list) {
      if (!v) continue;
      const targetId = typeof v === 'string' ? v : (v.id || v.name);
      if (!targetId) continue;
      edges.push(makeEdge({ key, subject: entity.id, object: targetId, literal: false, role: (v && v.role) || '' }));
    }
  }
  return edges;
}

module.exports = {
  NODE_TYPES,
  makeEdge,
  GraphStore,
  edgesFromLegacyEntity,
  nowIso,
  MODIFIER,
};
