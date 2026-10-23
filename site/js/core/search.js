/**
 * SearchEngine — fuzzy entity search that does not load the whole corpus.
 *
 * Two problems to solve at once:
 *  - quality: users type partial names (李, 白居, 张庆), so a fuzzy match over
 *    names and aliases is wanted, not exact lookup;
 *  - scale: the corpus targets ~660k persons. Loading or indexing all of them
 *    in the browser is not possible, so search must narrow first.
 *
 * Strategy
 *  1. Ask the DataStore which name-prefix bucket holds the query's first
 *     character (see scripts/build_index.js). That bucket is a few thousand rows.
 *  2. Ensure those rows are loaded, then run fuzzy matching over just them.
 *  3. Because a prefix bucket only contains names starting with that character,
 *     a query like "白的" (surname later in the string) would be missed, so
 *     queries that produce no hits fall back to a scan of what is already in
 *     memory — never to a corpus-wide download.
 *
 * Fuse.js is optional: if the CDN fails, the same candidate set is filtered by
 * substring, so search degrades in quality but never breaks.
 */
(function (global) {
  'use strict';

  function SearchEngine(dataStore, options) {
    if (!(this instanceof SearchEngine)) return new SearchEngine(dataStore, options);
    this.store = dataStore;
    this.options = options || {};
    // 可选的本地全量库客户端。没有它时（静态部署）只搜分片。
    this.api = this.options.api || null;
    this.FuseCtor = this.options.Fuse !== undefined ? this.options.Fuse : (global.Fuse || null);
    this._fuseByKey = {};
  }

  var TYPE_OF = [
    ['personList', 'person'],
    ['orgList', 'organization'],
    ['eventList', 'event'],
  ];

  function toItem(e, type) {
    var props = e.props || {};
    var propText = Object.keys(props)
      .map(function (k) { return props[k]; })
      .filter(function (v) { return typeof v === 'string'; })
      .join(' ');
    return {
      id: e.id,
      name: e.name || '',
      type: type,
      aliases: (e.aliases || []).join(' '),
      desc: (props['简介'] || props['描述'] || e.summary || '').slice(0, 80),
      searchText: [e.name].concat(e.aliases || [], propText).join(' '),
    };
  }

  /** Items from an explicit id set, or from everything currently loaded. */
  SearchEngine.prototype._items = function (ids) {
    var wanted = ids ? new Set(ids) : null;
    var store = this.store;
    var out = [];
    TYPE_OF.forEach(function (pair) {
      var list = store[pair[0]] || [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (wanted && !wanted.has(e.id)) continue;
        out.push(toItem(e, pair[1]));
      }
    });
    return out;
  };

  /**
   * Run a query and return matching entities.
   *
   * Returns a Promise because narrowing may need one bucket fetch. Call sites
   * that already awaited `SearchEngine.warm(query)` can keep using the sync
   * `searchNow`.
   */
  SearchEngine.prototype.search = async function (query, limit) {
    var q = String(query || '').trim();
    if (!q) return [];
    var n = limit || 20;

    // 本地全量库优先。
    //
    // 分片只有已发布集合（1900+ 阈值，3,641 人），而 CBDB 有 48.7 万。
    // 用户搜「安惇」时，分片路径只会返回无关结果——而本地运行
    // `npm run serve` 时数据库就在那里，没有理由不用。
    //
    // 走 FTS 而不是前缀桶：FTS 能匹配别名和摘要，前缀桶只能匹配首字。
    if (this.api && this.api.isAvailable()) {
      try {
        var res = await this.api.query({
          where: [{ field: 'name', op: 'text', value: q }],
          limit: n,
        });
        var rows = (res && res.rows) || [];
        if (rows.length) {
          return rows.map(function (r) {
            return { id: r.id, name: r.name, type: r.type, lifespan: r.lifespan };
          });
        }
        // API 返回空是真实答案（确实没这个人），不再回落分片：
        // 回落只会拿分片里那些「首字相同」的无关条目凑数，
        // 看起来像搜到了，实际是噪声。
        return [];
      } catch (e) {
        // API 挂了才回落。分片仍然能用，只是范围小。
        if (global.console) console.warn('API 检索失败，回落分片', e.message);
      }
    }

    var candidates = await this._candidates(q);
    var hits = this._match(q, candidates, n);
    if (hits.length) return hits;

    // Fallback: fuzzy over whatever is loaded. Bounded by the loaded set, so it
    // cannot accidentally pull the corpus down.
    var loaded = this._items(null);
    return this._match(q, loaded, n);
  };

  /** Synchronous variant over currently loaded entities. */
  SearchEngine.prototype.searchNow = function (query, limit) {
    var q = String(query || '').trim();
    if (!q) return [];
    return this._match(q, this._items(null), limit || 20);
  };

  /**
   * Candidate items for a query: the first-character bucket when the manifest
   * provides one, otherwise everything loaded.
   */
  SearchEngine.prototype._candidates = async function (q) {
    var store = this.store;
    var types = ['person', 'organization', 'event'];
    var bucketFiles = {};
    var sawManifest = false;

    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var file = store.bucketFor ? store.bucketFor(type, q) : null;
      if (file === null) continue; // no manifest for this type
      sawManifest = true;
      if (!file) continue; // character cannot start a name in this type
      bucketFiles[type] = file;
    }
    if (!sawManifest) return this._items(null);

    var self = this;
    var ids = new Set();
    await Promise.all(Object.keys(bucketFiles).map(async function (type) {
      var rows = await self.store.loadSearchBucket(type, bucketFiles[type]);
      rows.forEach(function (r) { ids.add(r.id); });
    }));
    if (!ids.size) return [];
    return this._items(ids);
  };

  /** Fuzzy (or substring) match over a fixed candidate list. */
  SearchEngine.prototype._match = function (q, items, n) {
    if (!items || !items.length) return [];
    if (!this.FuseCtor) return substringMatch(q, items, n);

    // Fuzzy indexes are built per candidate set and reused across keystrokes,
    // so typing 白居易 builds the 白 bucket's index once, not seven times. The
    // key is the candidate set's size plus first id: stable for a bucket, and
    // cheap to compute (bucket rows are sorted by name, never by query).
    var key = items.length + ':' + items[0].id;
    var fuse = this._fuseByKey[key];
    if (!fuse) {
      fuse = new this.FuseCtor(items, {
        keys: ['name', 'aliases', 'searchText'],
        threshold: 0.4,
        distance: 100,
        minMatchCharLength: 1,
      });
      this._fuseByKey = {};
      this._fuseByKey[key] = fuse;
    }
    return fuse.search(q, { limit: n }).map(function (r) { return r.item; });
  };

  /**
   * Drop cached fuzzy indexes. Called after the entity set changes (create /
   * edit / delete) so the next query rebuilds against fresh rows; the old code
   * did this by rebuilding eagerly on every save, which is wasted work when the
   * next query is against a different bucket anyway.
   */
  SearchEngine.prototype.invalidateCache = function () {
    this._fuseByKey = {};
  };

  SearchEngine.prototype.resolveEntities = function (ids) {
    var store = this.store;
    return (ids || []).map(function (id) {
      var e = store.getEntity(id);
      return e ? { id: id, name: e.name, type: store.getType(id) } : null;
    }).filter(Boolean);
  };

  function substringMatch(q, items, n) {
    var needle = q.toLowerCase();
    var out = [];
    for (var i = 0; i < items.length && out.length < n; i++) {
      var it = items[i];
      if ((it.name || '').toLowerCase().indexOf(needle) >= 0
        || (it.aliases || '').toLowerCase().indexOf(needle) >= 0
        || (it.searchText || '').toLowerCase().indexOf(needle) >= 0) {
        out.push(it);
      }
    }
    return out;
  }

  global.HMSearch = { SearchEngine: SearchEngine, toItem: toItem };
})(typeof window !== 'undefined' ? window : globalThis);
