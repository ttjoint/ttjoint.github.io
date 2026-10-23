/**
 * DataStore — browser-side entity cache and canonical index access.
 *
 * Responsibilities
 *  - load data/{persons,organizations,events}/manifest.json, then only the pages
 *    and search buckets a view actually needs (see scripts/build_index.js)
 *  - lazily load entity detail shards on demand
 *  - overlay localStorage edits when running in local (editable) mode
 *  - resolve 【id】 / 【id|type】 references used inside props
 *
 * It owns no Vue state and no DOM access, so it is unit-testable in Node with a
 * fake fetch. Relation handling lives in `relations.js`, which talks to the
 * predicate primitives in `predicates.js`.
 */
(function (global) {
  'use strict';

  var FOLDERS = {
    person: 'persons', thing: 'things', organization: 'organizations',
    event: 'events', evidence: 'evidence'
  };
  var STORAGE_KEYS = {
    person: 'hm_persons', thing: 'hm_things', organization: 'hm_organizations',
    event: 'hm_events', evidence: 'hm_evidence'
  };
  /** Kept in the same order as FOLDERS so the two cannot drift. */
  var TYPES = Object.keys(FOLDERS);
  /** How many index pages to pull on startup before a view asks for more. */
  var BOOTSTRAP_PAGES = 1;

  var TYPE_ALIASES = {
    person: 'person', '人物': 'person', '人': 'person',
    thing: 'thing', '非人实体': 'thing', '实物': 'thing', '物品': 'thing',
    organization: 'organization', '组织': 'organization', '政权': 'organization', org: 'organization',
    '国家': 'organization', '朝代': 'organization',
    event: 'event', '事件': 'event', '事': 'event',
    evidence: 'evidence', '证据': 'evidence', '记载': 'evidence', '出处': 'evidence',
  };

  function DataStore(options) {
    // Prefix-friendly ctor: `DataStore(opts)` works with or without `new`,
    // and never re-enters when called from another realm (tests use a vm).
    if (!(this instanceof DataStore)) return new DataStore(options);
    this.options = options || {};
    this.isLocalMode = !!this.options.isLocalMode;
    this.fetchJson = this.options.fetchJson || function (url) {
      return fetch(url).then(function (r) { return r.json(); });
    };
    this.storage = this.options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    // One map per type, keyed by the folder name so FOLDERS drives everything.
    for (var ti = 0; ti < TYPES.length; ti++) this[FOLDERS[TYPES[ti]]] = {};
    this.personList = [];
    this.orgList = [];
    this.eventList = [];
    this.loaded = false;
  }

  DataStore.prototype._read = function (key) {
    if (!this.storage) return {};
    try { return JSON.parse(this.storage.getItem(key) || '{}'); } catch (e) { return {}; }
  };

  DataStore.prototype._write = function (key, data) {
    if (!this.storage) return;
    this.storage.setItem(key, JSON.stringify(data));
  };

  /**
   * Load manifests and the first index page of each type.
   *
   * The corpus is paged (scripts/build_index.js) because a single index file
   * does not scale past ~10k entities. Startup therefore touches:
   *   data/<type>/manifest.json           counts + page list + search buckets
   *   data/<type>/index/page-000.json     the first page of rows
   * and nothing else. `loadAllPages()` / `loadPage(n)` pull more on demand.
   *
   * If a manifest is missing (old checkout, or `data/` not rebuilt) it falls
   * back to the legacy single index.json so the site still opens.
   */
  DataStore.prototype.init = async function () {
    if (this.loaded) return this;
    var self = this;
    var load = function (url, fallback) {
      return self.fetchJson(url).catch(function () { return fallback; });
    };

    this.manifests = {};
    this.pageCache = {};
    this._pagePromises = {};
    this._bucketCache = {};

    await Promise.all(TYPES.map(async function (type) {
      var folder = FOLDERS[type];
      var manifest = await load('data/' + folder + '/manifest.json', null);
      if (manifest && manifest.pages) {
        self.manifests[type] = manifest;
        var first = manifest.pages.slice(0, BOOTSTRAP_PAGES);
        var pages = await Promise.all(first.map(function (p) {
          return load('data/' + folder + '/' + p.file, []);
        }));
        pages.forEach(function (rows) { self._addRows(type, rows); });
        self.pageCache[type] = BOOTSTRAP_PAGES;
      } else {
        // Legacy fallback: one flat index, no paging metadata.
        var legacy = await load('data/' + folder + '/index.json', []);
        // index.json is a {_truncated, _count, rows} wrapper; older builds
        // wrote a bare array. Handle both.
        var rows = Array.isArray(legacy) ? legacy : (legacy && legacy.rows) || [];
        self.manifests[type] = null;
        self._addRows(type, rows || []);
        self.pageCache[type] = Infinity;
      }
    }));

    if (this.isLocalMode) {
      // Local edits win over the published index, so unsaved-to-disk work is
      // never silently overwritten by a page reload.
      for (var li = 0; li < TYPES.length; li++) {
        var lt = TYPES[li];
        var local = this._read(STORAGE_KEYS[lt]);
        var bucket = this[FOLDERS[lt]];
        for (var lk in local) {
          if (Object.prototype.hasOwnProperty.call(local, lk)) bucket[lk] = local[lk];
        }
      }
    }

    this._refreshLists();
    this.loaded = true;
    return this;
  };

  /** Insert index rows into the type's map without clobbering loaded details. */
  DataStore.prototype._addRows = function (type, rows) {
    var map = this[FOLDERS[type]];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.id) continue;
      if (!map[row.id]) map[row.id] = row;
    }
  };

  /** Load index page `n` for a type (idempotent). */
  DataStore.prototype.loadPage = async function (type, n) {
    var manifest = this.manifests && this.manifests[type];
    if (!manifest || !manifest.pages[n]) return [];
    var key = type + ':' + n;
    if (this._pagePromises[key]) return this._pagePromises[key];
    var self = this;
    var folder = FOLDERS[type];
    this._pagePromises[key] = this.fetchJson('data/' + folder + '/' + manifest.pages[n].file)
      .then(function (rows) {
        self._addRows(type, rows || []);
        self._refreshLists();
        return rows || [];
      })
      .catch(function () { return []; });
    return this._pagePromises[key];
  };

  /** Load every remaining page; for views that genuinely need the whole set. */
  DataStore.prototype.loadAllPages = async function (type) {
    var manifest = this.manifests && this.manifests[type];
    if (!manifest) return;
    var jobs = [];
    for (var i = 0; i < manifest.pages.length; i++) jobs.push(this.loadPage(type, i));
    await Promise.all(jobs);
  };

  /**
   * Which search bucket holds entities whose name starts with `query`'s first
   * character. Returns a bucket file name, '' when the character has no bucket
   * (so the query cannot match by name prefix), or null when the manifest has
   * no search map at all and the caller must scan everything.
   */
  DataStore.prototype.bucketFor = function (type, query) {
    var manifest = this.manifests && this.manifests[type];
    if (!manifest || !manifest.search || !manifest.search.charToFile) return null;
    var ch = Array.from(String(query || '').trim())[0];
    if (!ch) return null;
    return manifest.search.charToFile[ch] || '';
  };

  /** Fetch a search bucket and return its rows (cached). */
  DataStore.prototype.loadSearchBucket = async function (type, file) {
    var cache = this._bucketCache;
    var key = type + ':' + file;
    if (cache[key]) return cache[key];
    var folder = FOLDERS[type];
    var self = this;
    // `manifest.search.charToFile` entries are paths relative to the type folder
    // (`search/bucket-000.json`). Early manifests stored the bare file name, which
    // this joined into `data/persons/bucket-000.json` — a 404 that `.catch` turned
    // into `[]`, hiding the problem. Accept both shapes so a stale published tree
    // still searches instead of silently returning nothing.
    var rel = String(file || '');
    if (rel && rel.indexOf('/') === -1) rel = 'search/' + rel;
    cache[key] = this.fetchJson('data/' + folder + '/' + rel)
      .then(function (rows) {
        self._addRows(type, rows || []);
        // `_refreshLists()` is NOT optional here, and leaving it out silently broke
        // search rather than the bucket load. `_items()` walks `personList` /
        // `orgList` / `eventList`, which are snapshots rebuilt only by this call;
        // the rows did land in the `persons` map, so nothing looked wrong at the
        // cache level — but only the first page (BOOTSTRAP_PAGES) was reflected in
        // the lists, so fetched people were invisible to matching.
        self._refreshLists();
        return rows || [];
      })
      .catch(function () { return []; });
    return cache[key];
  };

  DataStore.prototype._refreshLists = function () {
    this.personList = Object.keys(this.persons).map(function (k) { return this.persons[k]; }, this);
    this.orgList = Object.keys(this.organizations).map(function (k) { return this.organizations[k]; }, this);
    this.eventList = Object.keys(this.events).map(function (k) { return this.events[k]; }, this);
    // `thingList` / `evidenceList` are new; existing views keep their old names.
    this.thingList = Object.keys(this.things).map(function (k) { return this.things[k]; }, this);
    this.evidenceList = Object.keys(this.evidence).map(function (k) { return this.evidence[k]; }, this);
  };

  /**
   * Fetch an entity's full record.
   *
   * Only the first index page is preloaded, so for most of the corpus there is
   * no row to read `detail` from. The shard path is a pure function of the id
   * (`entities/<encodeURIComponent(id)>.json`, see build_index.js), so it can be
   * derived instead of looked up.
   *
   * This used to bail out when `getEntity` returned null, and the caller then
   * fabricated an empty `{name: id}` stub and saved it — which both showed the
   * raw id as the name and, worse, persisted the stub over the real record.
   */
  DataStore.prototype.loadEntity = function (id) {
    var existing = this.getEntity(id);
    if (existing && existing._full) return Promise.resolve(existing);

    var type = this.getType(id);
    // getType returns the string 'unknown', not null, for an id it has not
    // loaded — so `if (!type)` never fires. Fall back to the id's own prefix.
    if (!type || type === 'unknown' || !FOLDERS[type]) {
      type = id.indexOf(':') > 0 ? id.slice(0, id.indexOf(':')) : null;
    }
    var folder = type ? FOLDERS[type] : null;
    if (!folder) return Promise.resolve(existing || null);

    var rel = existing && existing.detail
      ? existing.detail
      : 'entities/' + encodeURIComponent(id) + '.json';

    var self = this;
    return this.fetchJson('data/' + folder + '/' + rel)
      .then(function (detail) {
        detail._full = true;
        self[folder][id] = detail;
        self._refreshLists();
        return detail;
      })
      .catch(function (e) {
        if (global.console) console.warn('详情加载失败', id, e);
        return existing || null;
      });
  };

  DataStore.prototype.getEntity = function (id) {
    // Loop over every type instead of a hardcoded `persons || organizations ||
    // events` chain: the chain silently returned null for a fifth type, which
    // would show up as "entity not found" rather than as a bug.
    for (var i = 0; i < TYPES.length; i++) {
      var hit = this[FOLDERS[TYPES[i]]][id];
      if (hit) return hit;
    }
    return null;
  };

  DataStore.prototype.getType = function (id) {
    for (var i = 0; i < TYPES.length; i++) {
      if (this[FOLDERS[TYPES[i]]][id]) return TYPES[i];
    }
    return 'unknown';
  };

  DataStore.prototype.resolveName = function (id) {
    var e = this.getEntity(id);
    return e ? e.name : id;
  };

  DataStore.prototype.resolveType = function (id) { return this.getType(id); };

  DataStore.prototype.getProp = function (entity, key) {
    if (!entity || !entity.props) return '';
    return entity.props[key] || '';
  };

  /**
   * Matches a bare entity id: `person:cbdb-1`, `organization:local-000012`, …
   *
   * Kept in sync with the same shape test in `scripts/check_references.js`, which
   * validates the data side. The two must agree: the checker rejects a dangling
   * id-shaped prop reference at build time, and this decides at render time whether
   * a 【】 span is a reference at all. Divergence between them is what produced the
   * bug described below.
   */
  var REF_ID_RE = /^(person|organization|event|thing|evidence):[A-Za-z0-9._-]+$/;

  /**
   * Parse a 【id】 or 【id|type】 reference. Returns null for plain text so
   * callers can treat props uniformly as "text possibly containing refs".
   *
   * The shape check is load-bearing, not defensive. CBDB writes `史料注记` using
   * 【】 as an ordinary Chinese quotation bracket — `【參考《清代人物生卒年表》#21525.】`.
   * Without the check that text was treated as a reference to an entity named
   * `參考《清代人物生卒年表》#21525`, rendered as a clickable tag, and every click
   * landed on /person/<the book title> and rendered “未找到该实体”. Measured over
   * the published tree: all 2,655 【】 spans inside props are citations of this
   * form, none of them is a reference — so the check rejects only false links.
   *
   * Existence is deliberately NOT required. `getEntity` reads the in-memory cache
   * only, and detail shards load on demand, so a legitimate reference to an entity
   * whose shard has not been fetched yet would be demoted to plain text. Dangling
   * id-shaped references are a data problem, caught by check_references.js, not a
   * rendering problem.
   */
  /**
   * Parse a bare `person:cbdb-123` style id that appears outside 【】.
   *
   * Props are hand-written and importers are inconsistent: some put a reference
   * in 【】, some leave the raw id as a bare word in a sentence. The user-facing
   * rule is that any concrete entity id should be clickable, so both forms resolve
   * through the same REF_ID_RE shape gate. The gate is what keeps this safe: an
   * id has a mandatory `type:` prefix, so ordinary prose cannot match it.
   */
  DataStore.prototype.resolveBareId = function (text) {
    var s = String(text == null ? '' : text).trim();
    // Trailing punctuation is part of the sentence, not the id.
    s = s.replace(/[，。；、：！？…\),\]】」』,.!?;:]+$/, '');
    if (!REF_ID_RE.test(s)) return null;
    return this.resolveId(s);
  };

  /** Shared body for resolveRef / resolveBareId once a bare id is in hand. */
  DataStore.prototype.resolveId = function (id, explicitType) {
    var entity = this.getEntity(id);
    // When the target is not loaded yet, take the type from the id prefix instead
    // of falling back to 'unknown'. The prefix is authoritative — ids are
    // `<type>:<slug>` — and 'unknown' routed such references through
    // typeRoute('unknown', …), which defaults to the person route and produced a
    // wrong page for any non-person target.
    var prefixType = TYPE_ALIASES[id.substring(0, id.indexOf(':'))] || null;
    var type = entity ? this.getType(id) : (explicitType || prefixType || 'unknown');
    // `missing` says the id is well-formed but the record is not loaded — in the
    // published slice that means the target fell outside the date window, not that
    // the reference is wrong. Callers use it to render「未收录」 instead of a dead
    // link to a page that will render empty.
    return {
      id: id,
      name: entity ? entity.name : id,
      type: type,
      explicitType: explicitType || null,
      missing: !entity,
    };
  };

  DataStore.prototype.resolveRef = function (value) {
    if (!value) return null;
    var m = String(value).match(/^【(.+?)】$/);
    if (!m) return null;
    var inner = m[1];
    var pipeIdx = inner.lastIndexOf('|');
    var id = (pipeIdx !== -1 ? inner.substring(0, pipeIdx) : inner).trim();
    if (!REF_ID_RE.test(id)) return null;
    var explicitType = null;
    if (pipeIdx !== -1) {
      explicitType = TYPE_ALIASES[inner.substring(pipeIdx + 1).trim()] || null;
    }
    return this.resolveId(id, explicitType);
  };

  /*
   * 这里曾有 saveEntity / deleteEntity，把实体写进 localStorage 覆盖层。
   *
   * 已删除。原因不是「权限」，是一致性：前端写进去的数据没有 provenance、
   * 没有 commitId，刷新别人的视角也看不到。一旦允许，库里就会混进
   * 无法溯源的条目——正是清理 tags/era/kin 要消灭的东西。
   *
   * 写路径只在第 0 层（raw/）：改动附文献依据落盘 → transformer 重跑
   * → 重新 build。见 docs/architecture/前端页面架构调整方案.md §2.2。
   */

  DataStore.prototype.getAllEntities = function () {
    return this.personList.map(function (p) { return { id: p.id, name: p.name, type: 'person', entity: p }; })
      .concat(this.orgList.map(function (o) { return { id: o.id, name: o.name, type: 'organization', entity: o }; }))
      .concat(this.eventList.map(function (e) { return { id: e.id, name: e.name, type: 'event', entity: e }; }));
  };

  DataStore.prototype.exportAll = function () {
    return JSON.stringify({
      persons: this.personList,
      organizations: this.orgList,
      events: this.eventList,
    }, null, 2);
  };

  global.HMDataStore = {
    DataStore: DataStore, FOLDERS: FOLDERS, STORAGE_KEYS: STORAGE_KEYS,
    TYPES: TYPES, BOOTSTRAP_PAGES: BOOTSTRAP_PAGES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
