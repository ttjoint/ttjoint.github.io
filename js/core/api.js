/**
 * ApiClient — browser-side access to the SQLite index over HTTP.
 *
 * Why this exists alongside DataStore
 * -----------------------------------
 * DataStore reads the pre-built JSON shards. That works for "show me this one
 * entity" and "list the first page", because build_index.js already wrote those
 * files. It cannot answer:
 *
 *   - a five-generation family tree (needs recursion over 51k edges)
 *   - "everyone who died between 1100 and 1150" (needs the time index)
 *   - a full-text search over 486k names (needs FTS5)
 *   - anything with a cursor that is not "the first N by name"
 *
 * Those go to the API. The two are not alternatives: DataStore stays the fast path
 * for what it already has cached, the API covers the rest. `isAvailable()` gates
 * every call, so a static deploy with no backend still works — it just falls back
 * to the shard data and loses the recursive and ranged queries.
 *
 * Shape of the contract
 * ---------------------
 * The query descriptor passed here is exactly what `src/store/query_lang.js`
 * accepts. This module deliberately does not wrap it in a friendlier DSL: two
 * vocabularies in the same project is how the browser and Node predicate tables
 * drifted apart before. One descriptor, compiled on the server.
 */
(function (global) {
  'use strict';

  /**
   * @param {object} opts
   * @param {string} [opts.base]   API origin; default: same origin
   * @param {function} [opts.fetchImpl] injectable for tests
   */
  function ApiClient(opts) {
    if (!(this instanceof ApiClient)) return new ApiClient(opts);
    opts = opts || {};
    this.base = opts.base || '';
    this.fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    // Three states, not two: 'unknown' before the first probe, then 'up' or 'down'.
    // Collapsing unknown into down would make the first render always fall back
    // to shards even when the API is there, and it would never recover.
    this.status = 'unknown';
    this.schema = null;
    this._probe = null;
  }

  ApiClient.prototype._url = function (path) {
    return this.base + path;
  };

  ApiClient.prototype._get = function (path, params) {
    if (!this.fetchImpl) return Promise.reject(new Error('fetch unavailable'));
    var qs = '';
    if (params) {
      var parts = [];
      var keys = Object.keys(params);
      for (var i = 0; i < keys.length; i++) {
        var v = params[keys[i]];
        if (v === undefined || v === null) continue;
        parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(v));
      }
      if (parts.length) qs = '?' + parts.join('&');
    }
    return this.fetchImpl(this._url(path) + qs).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          var err = new Error(body.error || ('HTTP ' + r.status));
          err.status = r.status;
          err.code = body.code;
          throw err;
        });
      }
      return r.json();
    });
  };

  /**
   * Probe once and remember the answer.
   *
   * Called from init() before the first render. A failure is not an error the user
   * needs to see: a static deployment has no API by design, so this downgrades
   * silently and the views use DataStore.
   */
  ApiClient.prototype.probe = function () {
    if (this._probe) return this._probe;
    var self = this;
    this._probe = this._get('/api/health')
      .then(function (h) {
        self.status = 'up';
        self.health = h;
        return true;
      })
      .catch(function () {
        self.status = 'down';
        return false;
      });
    return this._probe;
  };

  ApiClient.prototype.isAvailable = function () {
    return this.status === 'up';
  };

  /**
   * Which capabilities can this deployment support?
   *
   * Views ask this instead of checking `isAvailable()` and then guessing, so the
   * list of what needs a backend lives in one place.
   */
  ApiClient.prototype.capabilities = function () {
    var up = this.isAvailable();
    return {
      search: true,          // shards have search buckets
      list: true,            // shards have paged indexes
      entity: true,          // shards have detail files
      tree: up,              // needs recursion
      timelineRange: up,     // needs the time index
      fullText: up,          // needs FTS5
      cursorPaging: up,      // shards page by index number, not by cursor
      predicates: up,        // needs the edge table
    };
  };

  /** Compile-and-run a descriptor. Returns `{ rows, nextCursor, hasMore }`. */
  /**
   * 任意 GET 端点。给新增端点（/api/predicates 等）用，避免每加一个
   * 端点就在客户端上再长一个专用方法——那些方法除了拼路径什么也不做。
   */
  ApiClient.prototype.get = function (path, params) {
    return this._get(path, params);
  };

  ApiClient.prototype.query = function (desc) {
    if (!this.isAvailable()) return Promise.reject(new Error('api unavailable'));
    return this._get('/api/query', serializeDescriptor(desc));
  };

  /** One entity with both edge directions, aliases and provenance. */
  ApiClient.prototype.entity = function (id) {
    if (!this.isAvailable()) return Promise.reject(new Error('api unavailable'));
    return this._get('/api/entity/' + encodeURIComponent(id).replace(/%3A/g, ':'));
  };

  /**
   * A family tree in one direction.
   * `dir` is 'up' (ancestors) or 'down' (descendants); the server clamps depth.
   */
  ApiClient.prototype.tree = function (id, opts) {
    if (!this.isAvailable()) return Promise.reject(new Error('api unavailable'));
    opts = opts || {};
    return this._get('/api/tree/' + encodeURIComponent(id).replace(/%3A/g, ':'), {
      dir: opts.dir || 'down',
      depth: opts.depth,
      predicate: opts.predicate,
    });
  };

  /** Entities whose lifespan overlaps a Julian-day window. */
  ApiClient.prototype.timeline = function (from, to, opts) {
    if (!this.isAvailable()) return Promise.reject(new Error('api unavailable'));
    opts = opts || {};
    return this._get('/api/timeline', {
      from: from,
      to: to,
      limit: opts.limit,
      cursor: opts.cursor,
    });
  };

  /**
   * Flatten a descriptor into query-string parameters.
   *
   * `where` entries repeat, which is why this cannot be a simple object: the
   * server ANDs repeated conditions, and JSON in a URL would defeat HTTP caching.
   * Format is `field:op:value`, matching `descriptorFromQuery` on the server.
   */
  function serializeDescriptor(desc) {
    var out = {};
    if (desc.type) out.type = desc.type;
    if (desc.limit != null) out.limit = desc.limit;
    if (desc.cursor) out.cursor = desc.cursor;

    var where = [];
    var conds = desc.where || [];
    for (var i = 0; i < conds.length; i++) {
      var c = conds[i];
      var v = c.value;
      if (Array.isArray(v)) v = v.join(',');
      where.push(c.field + ':' + c.op + ':' + v);
    }
    if (where.length) out.where = where;

    var order = [];
    var sorts = desc.orderBy || [];
    for (var j = 0; j < sorts.length; j++) {
      order.push(sorts[j].field + ':' + (sorts[j].dir || 'asc'));
    }
    if (order.length) out.orderBy = order;
    return out;
  }

  global.HMApi = {
    ApiClient: ApiClient,
    serializeDescriptor: serializeDescriptor,
  };
})(typeof window !== 'undefined' ? window : globalThis);

// Node/CommonJS export so the client can be unit-tested outside a browser. The
// browser build ignores this block; the guard keeps a bare <script> load working.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.HMApi;
}
