/**
 * RelationManager — maps the stored `entity.relations` shape onto predicate
 * primitives, and keeps inverse assertions in sync.
 *
 * Storage shape (unchanged, so existing data keeps working):
 *
 *   relations: {
 *     "父亲":                    ["person:...", ...]        // simple
 *     "所属组织":                [{ target, role, start, end }]  // with qualifiers
 *     "父亲/inverse":            [...]                       // explicit inverse
 *     "所属组织/negate":         [...]                       // explicitly false
 *   }
 *
 * The *word* is resolved through the predicate registry, so 父亲 / 爸爸 / 父 all
 * land on the `father` primitive, and 儿子 / 女儿 stay distinct primitives that
 * carry a gender constraint instead of being free text.
 */
(function (global) {
  'use strict';

  var P = global.HMPredicates;

  function RelationManager(dataStore, options) {
    if (!(this instanceof RelationManager)) return new RelationManager(dataStore, options);
    this.store = dataStore;
    this.predicates = (options && options.predicates) || P;
    this.isLocalMode = !!(options && options.isLocalMode);
  }

  /**
   * The inverse orientation of a relation word, or null when the predicate
   * declares none (attributes such as 性别 have no inverse).
   */
  /**
   * Inverse orientation of a relation word, or null when the predicate has no
   * inverse (attributes such as 性别).
   *
   * Stored keys are often the Chinese surface form ('父亲'), not the primitive
   * key, so resolve first and only then swap the base.
   */
  RelationManager.prototype.inverseKey = function (relKey) {
    var canonical = this.canonicalKey(relKey);
    if (!canonical) return null;
    var parts = this.predicates.splitModifiers(canonical);
    var target = this.predicates.inverseOf(parts.base);
    if (!target) return null;
    return [target].concat(parts.mods).join('/');
  };

  /** Normalise a stored relation word to its canonical key, or null. */
  RelationManager.prototype.canonicalKey = function (relKey) {
    if (relKey == null || relKey === '') return null;
    var parts = this.predicates.splitModifiers(relKey);
    // Already a primitive key (father, memberOf) or a synonym (父亲, 任职).
    var base = this.predicates.PREDICATES[parts.base]
      ? parts.base
      : this.predicates.resolve(parts.base);
    if (!base) return null;
    return [base].concat(parts.mods).join('/');
  };

  /**
   * Group an entity's relations for display:
   *   [{ key, label, negated, inversed, def, rows: [{ target, name, type, role, start, end, range }] }]
   *
   * Unknown words are dropped from display but reported in `unresolved`, so a
   * typo in the data is visible instead of silently rendering nothing.
   */
  RelationManager.prototype.group = function (entity) {
    var out = [];
    var unresolved = [];
    var rels = (entity && entity.relations) || {};
    var self = this;
    Object.keys(rels).forEach(function (rawKey) {
      var list = rels[rawKey];
      if (!list || !list.length) return;
      var canonical = self.canonicalKey(rawKey);
      if (!canonical) { unresolved.push(rawKey); return; }
      var def = self.predicates.def(canonical);
      if (!def) { unresolved.push(rawKey); return; }
      var rows = list.map(function (r) {
        var tid = typeof r === 'string' ? r : r.target;
        var node = self.store ? self.store.getEntity(tid) : null;
        return {
          target: tid,
          name: node ? node.name : tid,
          type: node ? self.store.getType(tid) : 'unknown',
          role: (r && r.role) || '',
          start: (r && r.start) || null,
          end: (r && r.end) || null,
          range: (r && r.range) || null,
        };
      });
      out.push({
        key: canonical,
        rawKey: rawKey,
        label: self.predicates.label(canonical),
        icon: def.icon || '•',
        hasRole: (def.qualifiers || []).indexOf('role') >= 0,
        hasDate: (def.qualifiers || []).indexOf('date') >= 0,
        negated: self.predicates.isNegated(canonical),
        inversed: self.predicates.isInversed(canonical),
        objectGender: def.objectGender || null,
        rows: rows,
      });
    });
    return { groups: out, unresolved: unresolved };
  };

  /**
   * Rows whose predicate is gender constrained, filtered by a gender query.
   * Searching 儿子 runs through here, so only male children match.
   */
  RelationManager.prototype.searchByGender = function (entities, predicateWord, gender) {
    var self = this;
    var key = this.predicates.resolve(predicateWord);
    if (!key) return [];
    var results = [];
    (entities || []).forEach(function (entity) {
      var grouped = self.group(entity);
      grouped.groups.forEach(function (g) {
        if (g.key !== key && self.predicates.baseKey(g.key) !== key) return;
        if (!self.predicates.matchesGender(g.key, gender)) return;
        g.rows.forEach(function (row) { results.push({ entity: entity, group: g, row: row }); });
      });
    });
    return results;
  };

  /*
   * 这里曾有 _addInverse / _removeInverse / syncInverseRelations /
   * cleanupReferences —— 编辑实体时自动在对方实体上补/删反向关系，
   * 并写进 localStorage 覆盖层。
   *
   * 已删除。它们是前端写路径的一部分：改了 A 的关系就顺手改 B，
   * 两处都没有 provenance。而反向关系本来就该在**查询时**由谓词的
   * `inverse` 推导（见 predicates.js 的 `/反` 修饰符），不该在存储层
   * 冗余一份——文档 §8.3 实测过 5,216 对纯冗余的反向边。
   *
   * 上面保留的都是只读方法：inverseKey / canonicalKey / group / searchByGender。
   */

  global.HMRelations = { RelationManager: RelationManager };
})(typeof window !== 'undefined' ? window : globalThis);
