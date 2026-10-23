'use strict';
/**
 * Read-only HTTP API over the derived SQLite index.
 *
 * Why a separate server
 * ---------------------
 * `admin_server.js` is the write path: it owns a mutable copy of the corpus and
 * exists so a human can approve edits. This is the opposite — a pure read path
 * over `local_data/humanmap.sqlite3`, whose only job is to let the browser ask
 * questions the JSON shards cannot answer cheaply (family-tree recursion,
 * timeline windows, full-text search across 486k names).
 *
 * They are separate processes on purpose: a read-only server cannot corrupt the
 * corpus, and the admin server must not be reachable from a public page.
 *
 * The boundary
 * ------------
 * Every request is turned into a query descriptor and handed to
 * `query_lang.compile()`. This file never writes SQL. That is the entire security
 * story: field names, operators and sort orders come from whitelists inside
 * query_lang.js, every value is a bound parameter, and there is no code path
 * here that concatenates a string into a statement.
 *
 * Endpoints
 * ---------
 *   GET  /api/health                 row counts, schema version, corpus anchor
 *   GET  /api/query?...              descriptor in the query string (see below)
 *   POST /api/query                  descriptor as a JSON body, for long filters
 *   GET  /api/entity/:id             one entity with its edges, both directions
 *   GET  /api/tree/:id?dir=&depth=   family tree, bounded recursion
 *   GET  /api/timeline?from=&to=     entities whose lifespan overlaps a window
 *
 * The query-string form exists because the browser's `fetch` cache cannot cache a
 * POST. Anything that may be cached or bookmarked uses GET.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const q = require('../src/store/query_lang');
const { SCHEMA_VERSION } = require('../src/store/db_schema');

const PORT = Number(process.env.HM_API_PORT || 8787);
const DB_PATH = process.env.HM_DB || path.join(__dirname, '..', 'local_data', 'humanmap.sqlite3');

/**
 * Which tree to serve the app from.
 *
 * `site/` is the publish tree: exactly what a deploy ships, so testing against it
 * tests what users get. But it only exists after `npm run build:site`, which also
 * rebuilds every published data file and takes tens of minutes. During UI work
 * that turnaround is unusable, so HM_DEV=1 serves the repo root instead — same
 * shell, same js/, but the data directory is the full corpus rather than the
 * published subset.
 *
 * The two are not interchangeable: a bug that only appears against the published
 * subset (a missing modern person, a route with no data) is exactly the kind that
 * matters, so the default stays `site/`.
 */
const DEV = process.env.HM_DEV === '1';
const SITE_ROOT = DEV ? path.join(__dirname, '..') : path.join(__dirname, '..', 'site');

/** Hard cap on recursive depth. Unbounded recursion on a 486k graph is a DoS. */
const MAX_DEPTH = 8;
const DEFAULT_DEPTH = 5;

let db = null;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // The corpus changes only when build_db runs, so a short cache is safe and
    // saves the 486k-row queries from being re-run on every navigation.
    'Cache-Control': 'public, max-age=60',
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

/**
 * A family tree in one direction.
 *
 * Two things here are load-bearing rather than stylistic:
 *
 *  1. `INDEXED BY`. Without it SQLite scans every edge of the predicate and joins
 *     the whole set: measured 13.45ms vs 0.05ms for depth 5, and the gap widens
 *     as edges are added (P4 is expected to take this from 51k to ~410k).
 *  2. Ascending and descending are separate CTEs. A single recursive CTE cannot
 *     cover both because the recursive step must join on a different column; trying
 *     to parametrise the column makes the query unplannable.
 *
 * Depth is bounded by the caller and clamped here. `UNION` (not `UNION ALL`)
 * deduplicates, which is what stops a pedigree collapse — marriage between
 * cousins — from returning the same ancestor exponentially many times.
 */
function familyTree(id, dir, depth, predicate) {
  // Clamp HERE, not at the route. The route is one caller; a test, a script or a
  // future endpoint is another. Measured: depth 999 on a busy node ran for 64
  // seconds before returning — the recursion was correct but unbounded, which is
  // a denial-of-service with one query string.
  const asked = Number(depth);
  const bounded = Number.isFinite(asked) ? Math.max(1, Math.min(asked, MAX_DEPTH)) : DEFAULT_DEPTH;

  const down = dir !== 'up';
  const index = down ? 'idx_edges_subject' : 'idx_edges_object';
  const fromCol = down ? 'subject' : 'object';
  const toCol = down ? 'object' : 'subject';
  const predFilter = predicate ? ' AND e.predicate = ?' : '';
  // Parameter order MUST match the placeholder order in the SQL below:
  //   SELECT ?, 0        -> id
  //   w.depth < ?        -> bounded
  //   e.predicate = ?    -> predicate
  // Getting these two swapped is silent: without a predicate the query is
  // unaffected, and with one it compares depth to a string (which SQLite coerces
  // to 0), so the recursion stops immediately and the walk returns just the seed.
  const params = predicate ? [id, bounded, predicate] : [id, bounded];

  const sql = `
    WITH RECURSIVE walk(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT e.${toCol}, w.depth + 1
        FROM edges e INDEXED BY ${index}
        JOIN walk w ON e.${fromCol} = w.id
       WHERE w.depth < ?${predFilter}
    )
    SELECT w.id, w.depth, en.name, en.type, en.valid_from, en.valid_to
      FROM walk w
      LEFT JOIN entities en ON en.id = w.id
     ORDER BY w.depth, en.name`;
  return db.prepare(sql).all(...params);
}
/** One entity plus every edge that touches it, in both directions. */
/**
 * 解析数据库里存的 JSON 列。解析失败返回 null 而不是抛——
 * 一条坏数据不该让整个请求 500。
 */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function entityDetail(id) {
  let row = db.prepare(
    `SELECT id, type, name, summary, props_json, valid_from, valid_to, folder
       FROM entities WHERE id = ?`,
  ).get(id);

  // 证据节点不在 `entities` 表里，它们有自己的表。
  //
  // 这不是特例代码：`evidence` 存的是「文献本身」，字段（carrier/medium/
  // reliability）与实体不同，混进 entities 会让每列对一半行无意义。
  // 但前端需要 `evidence:cbdb` 才能显示「媒介：二手数据库」——
  // 查不到就只能显示一个名字。
  if (!row) {
    const ev = db.prepare(
      `SELECT id, name, medium, carrier, url, accessed_at, excerpt, reliability, version, underlying_sources
         FROM evidence WHERE id = ?`,
    ).get(id);
    if (!ev) return null;
    return {
      id: ev.id,
      type: 'evidence',
      name: ev.name,
      summary: ev.excerpt || null,
      folder: 'evidence',
      // 结构化字段用证据节点的标准键名（与 `src/store/evidence.js` 一致），
      // 不用中文 props：`HMEvidence.describeEvidence` 读的是 `medium` /
      // `carrier` / `reliability`，塞进 `props.媒介` 它看不见，
      // 气泡里就只剩一个名字。
      medium: ev.medium,
      carrier: ev.carrier,
      url: ev.url,
      accessedAt: ev.accessed_at,
      excerpt: ev.excerpt,
      reliability: ev.reliability,
      version: ev.version,
      underlyingSources: ev.underlying_sources,
      lifespan: null,
      aliases: [],
      outgoing: [],
      incoming: [],
      provenance: [],
    };
  }

  // Both directions in one pass. Doing them as separate queries meant the caller
  // had to know which side to look at, and every caller got it wrong for at least
  // one predicate.
  const out = db.prepare(
    `SELECT e.id AS edge_id, e.predicate, e.object AS other, e.qualifiers, en.name AS other_name, en.type AS other_type
       FROM edges e INDEXED BY idx_edges_subject
       LEFT JOIN entities en ON en.id = e.object
      WHERE e.subject = ?`,
  ).all(id);
  const inb = db.prepare(
    `SELECT e.id AS edge_id, e.predicate, e.subject AS other, e.qualifiers, en.name AS other_name, en.type AS other_type
       FROM edges e INDEXED BY idx_edges_object
       LEFT JOIN entities en ON en.id = e.subject
      WHERE e.object = ?`,
  ).all(id);

  // 边的出处。与实体级 provenance 是两回事：
  //   scope='entity'  这个人本身被记载于哪里
  //   scope='edge'    这条断言（「他的父亲是某某」）出自哪里
  // 不带上它，前端就无法在关系项旁显示「凭什么这么说」。
  const edgeProv = db.prepare(
    `SELECT target_id, raw_ref, quote, reason
       FROM provenance
      WHERE scope = 'edge' AND target_id IN (
        SELECT id FROM edges WHERE subject = ? OR object = ?
      )`,
  ).all(id, id);
  const provByEdge = new Map();
  for (const p of edgeProv) {
    if (!provByEdge.has(p.target_id)) provByEdge.set(p.target_id, []);
    // `locator` 不在表结构里（它只存在于分片 JSON），不查也不返。
    provByEdge.get(p.target_id).push({
      rawRef: p.raw_ref,
      quote: p.quote,
      reason: p.reason,
    });
  }
  const withProv = (rows) => rows.map((e) => ({
    ...e,
    // qualifiers 在表里存的是 JSON 字符串。不解析的话前端拿到的是
    // 文本 `"{\"role\":\"中央主席\"}"`，读 `.role` 得 undefined，
    // 职务信息在页面上静默消失——数据在库里，读者看不见。
    qualifiers: safeJson(e.qualifiers),
    provenance: provByEdge.get(e.edge_id) || [],
  }));

  const aliases = db.prepare('SELECT alias FROM aliases WHERE entity_id = ? ORDER BY alias').all(id);
  const provenance = db.prepare(
    `SELECT p.id, p.evidence_id, p.raw_ref, p.quote, p.reason, p.commit_id, ev.name AS evidence_name, ev.url AS evidence_url
       FROM provenance p
       LEFT JOIN evidence ev ON ev.id = p.evidence_id
      WHERE p.target_id = ? AND p.scope = 'entity'
      LIMIT 50`,
  ).all(id);

  const { props_json: rawProps, ...rest } = row;
  return {
    ...rest,
    props: rawProps ? JSON.parse(rawProps) : {},
    lifespan: row.valid_from || row.valid_to
      ? { start: row.valid_from, end: row.valid_to }
      : null,
    aliases: aliases.map((a) => a.alias),
    outgoing: withProv(out),
    incoming: withProv(inb),
    provenance,
  };
}

/**
 * Parse a query descriptor out of a GET query string.
 *
 * Format (kept flat so it survives URLSearchParams without a JSON blob):
 *   type=person&where=birthDate:between:1000,2000&where=name:prefix:王
 *   &orderBy=birthDate:asc&limit=50&cursor=...
 *
 * A field repeated (`where=` twice) becomes two conditions ANDed together.
 * Values are strings from the URL; `between` splits on the comma and converts to
 * numbers, everything else stays a string and is coerced by the column type.
 */
function descriptorFromQuery(sp) {
  const desc = { limit: sp.get('limit') ? Number(sp.get('limit')) : undefined };
  const type = sp.get('type');
  if (type) desc.type = type;

  const where = [];
  for (const raw of sp.getAll('where')) {
    const first = raw.indexOf(':');
    const second = raw.indexOf(':', first + 1);
    if (first < 0 || second < 0) throw new Error(`malformed where: ${raw}`);
    const field = raw.slice(0, first);
    const op = raw.slice(first + 1, second);
    const value = raw.slice(second + 1);
    if (op === 'between') {
      const [lo, hi] = value.split(',');
      where.push({ field, op, value: [Number(lo), Number(hi)] });
    } else if (op === 'in') {
      where.push({ field, op, value: value.split(',') });
    } else if (value === 'true' || value === 'false') {
      where.push({ field, op, value: value === 'true' });
    } else {
      where.push({ field, op, value });
    }
  }
  if (where.length) desc.where = where;

  // `q`：全文检索的简写，等价于 `where=name:text:<q>`。
  //
  // 没有它时，`?q=冒樹楷` 被**静默忽略**，返回默认排序的前几条——
  // 用户搜一个名字得到一堆无关的人，看不出是搜错了还是功能坏了。
  // 静默失败比报错更糟：报错至少告诉你「这条路走不通」。
  //
  // 之所以叫 `q` 而不是强制写 `where=name:text:…`：检索框是最高频的入口，
  // 调用方不该为了一个词去拼描述符语法。
  const q = sp.get('q');
  if (q && q.trim()) {
    desc.where = (desc.where || []).concat([{ field: 'name', op: 'text', value: q.trim() }]);
  }

  const orderBy = sp.getAll('orderBy').map((raw) => {
    const [field, dir] = raw.split(':');
    return { field, dir: dir || 'asc' };
  });
  if (orderBy.length) desc.orderBy = orderBy;

  const cursor = sp.get('cursor');
  if (cursor) desc.cursor = cursor;
  return desc;
}

function health() {
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  const meta = {};
  for (const row of db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value;
  return {
    schemaVersion: SCHEMA_VERSION,
    meta,
    counts: {
      entities: one('SELECT COUNT(*) FROM entities'),
      edges: one('SELECT COUNT(*) FROM edges'),
      aliases: one('SELECT COUNT(*) FROM aliases'),
      evidence: one('SELECT COUNT(*) FROM evidence'),
      provenance: one('SELECT COUNT(*) FROM provenance'),
    },
    predicates: db.prepare('SELECT predicate, COUNT(*) n FROM edges GROUP BY predicate ORDER BY n DESC').all(),
  };
}

// ------------------------------------------------------------------ static
//
// Served from the same origin as the API so the browser needs no CORS headers and
// no second server. The publish tree (`site/`) is what a deploy would ship, so
// testing against it here means testing what users get.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // `/data/` is allowed in both modes: the frontend's DataStore loads manifests
  // and shards from it, and the API deliberately does not duplicate that path.
  //
  // The difference is what is behind it: `site/data/` is the published subset
  // (modern persons only), while the repo's `data/` is the full corpus. Serving
  // the latter in dev is acceptable ONLY because the server binds to 127.0.0.1 —
  // it must never be exposed. The startup banner says so.
  //
  // Everything else here is refused outright: the raw layer, the local database
  // and the source tree are not part of the app in any mode.
  for (const secret of ['raw', 'local_data', 'src', 'tools', 'test', '.git']) {
    if (rel === secret || rel.startsWith(secret + '/')) return fail(res, 403, 'forbidden');
  }

  const full = path.resolve(SITE_ROOT, rel);
  // `new URL` has already normalised `..` and `%2e%2e` away before we see the
  // path, so site/ cannot be escaped through the URL itself. The remaining risk is
  // double-decoding: a caller that decoded here and then joined would re-open
  // traversal. We deliberately do NOT decode. This check is belt-and-braces, and
  // it uses path.resolve so it holds even if the caller changes.
  const root = path.resolve(SITE_ROOT);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return fail(res, 403, 'forbidden');
  }

  // Directory -> index.html, because GitHub Pages does it and this server must
  // match the deploy target. Every static entity page is a directory
  // (`site/p/person/cbdb-1/index.html`) and the canonical, sitemap-advertised URL
  // is the trailing-slash form; serving those as 404 made the whole generated
  // tree look broken locally while working on Pages, which is the one divergence
  // this server exists to prevent. Done after the containment check so the
  // resolved child cannot escape the root.
  const file = resolveIndex(full);

  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}

/**
 * Map a filesystem path to the file GitHub Pages would serve for it.
 *
 * `/x/` and `/x` both mean `/x/index.html`; anything that is already a file is
 * returned unchanged. `index.html` is the only name considered — Pages does not
 * do extensionless lookup — so this cannot invent a route that a deploy would 404.
 */
function resolveIndex(full) {
  try {
    if (fs.statSync(full).isDirectory()) return path.join(full, 'index.html');
    return full;
  } catch {
    return full;
  }
}

// ---------------------------------------------------------------------- main

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      // A descriptor is small; anything larger is not one.
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') return serveStatic(res, url.pathname);

  try {
    if (parts[1] === 'health') return json(res, 200, health());

    if (parts[1] === 'query') {
      const desc = req.method === 'POST' ? await readBody(req) : descriptorFromQuery(url.searchParams);
      return json(res, 200, q.run(db, desc));
    }

    if (parts[1] === 'entity') {
      const id = decodeURIComponent(parts.slice(2).join('/'));
      const detail = entityDetail(id);
      return detail ? json(res, 200, detail) : fail(res, 404, 'entity not found');
    }

    if (parts[1] === 'tree') {
      const id = decodeURIComponent(parts.slice(2).join('/'));
      const dir = url.searchParams.get('dir') === 'up' ? 'up' : 'down';
      const asked = Number(url.searchParams.get('depth') || DEFAULT_DEPTH);
      // familyTree clamps as well; this value is only used for the echoed
      // response, so the two must agree on what was actually run.
      const depth = Number.isFinite(asked) ? Math.max(1, Math.min(asked, MAX_DEPTH)) : DEFAULT_DEPTH;
      const predicate = url.searchParams.get('predicate') || null;
      const rows = familyTree(id, dir, depth, predicate);
      return json(res, 200, { id, dir, depth, predicate, maxDepth: MAX_DEPTH, rows });
    }

    // ---------------------------------------------------------------- sources
    //
    // 反向视图：证据文件 → 它支撑了哪些断言。
    //
    // 现有查询方向都是「实体 → 它的出处」，管理界面需要反过来看：
    // 「《宋史》到底被引用了多少次、支撑了哪些关系、有没有可疑的批量生成」。
    // 这个方向也能用来核对出处质量——比如某个文献的 quote 全是同一条模板，
    // 说明它并非真的被读过。
    // ---------------------------------------------------------------- commit
    //
    // 提交校验端点。**本端点不写盘。**
    //
    // 它只回答「这批断言能不能入库」，供录入后台在提交前自检。
    // 真正写入需要走完整链路：落 raw/ → transformer 重跑 → 重新 build。
    // 那个链路涉及多个进程和分钟级耗时，不能挂在一个 HTTP 请求里。
    //
    // 现在没有写入口是有意的：宁可暂时没有，也不要一个绕过校验的入口。
    if (parts[1] === 'commit') {
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return fail(res, 400, e.message);
      }

      const { validateBatch } = require('../src/store/commit_validation.js');
      const rawStore = require('../src/store/raw_store.js');

      const claims = Array.isArray(body) ? body : (body && body.claims) || [];
      if (!claims.length) return fail(res, 400, 'claims is empty');

      const result = validateBatch(claims, {
        // rawRef 必须在 raw 层真实存在。这是「出处不是编的」的硬证据。
        rawExists: (ref) => rawStore.exists(ref),
        // quote 由服务端按 span 从原文截取，**不接受提交者直接填写**。
        // 允许直接写 quote 的话，它与手写一条断言没有区别——任何内容都能
        // 被塞进「原文摘录」，而校验无法分辨是抄的还是编的。
        rawGet: (ref) => rawStore.getByRawId(ref),
      });

      return json(res, result.ok ? 200 : 422, {
        ok: result.ok,
        total: result.total,
        failed: result.failed,
        results: result.results.map((r) => ({
          index: r.index,
          ok: r.ok,
          issues: r.issues,
          // 回显服务端截出的引文：调用方要能确认「截的是哪一句」。
          // 不回显的话，录入员提交完不知道系统截到了什么。
          quote: r.normalized ? r.normalized.provenance.quote : null,
          span: r.normalized ? r.normalized.provenance.span : null,
          fingerprint: r.normalized ? r.normalized.provenance.fingerprint : null,
        })),
        // 明确告知调用方下一步，避免误以为已经写入。
        note: result.ok
          ? '校验通过。写入需走 raw/ → transformer → build 链路，本端点不落盘。'
          : '校验未通过，未写入任何内容。',
      });
    }

    if (parts[1] === 'sources') {
      const want = parts[2];

      // 单个文献的详情：按 scope 分组统计 + 抽样断言。
      if (want) {
        const title = decodeURIComponent(want);
        const counts = db.prepare(
          `SELECT scope, COUNT(*) AS n FROM provenance WHERE source_title = ? GROUP BY scope`,
        ).all(title);
        const byScope = {};
        for (const r of counts) byScope[r.scope] = r.n;

        // 抽样：边级给出「主语 —谓词→ 宾语」，实体级给出「实体名 + 字段」。
        const edgeSamples = db.prepare(
          `SELECT p.target_id, p.raw_ref, p.quote, p.reason, p.locator,
                  e.subject, e.predicate, e.object,
                  s.name AS subject_name, o.name AS object_name
             FROM provenance p
             JOIN edges e ON e.id = p.target_id
             LEFT JOIN entities s ON s.id = e.subject
             LEFT JOIN entities o ON o.id = e.object
            WHERE p.source_title = ? AND p.scope = 'edge'
            ORDER BY p.id
            LIMIT ?`,
        ).all(title, Number(url.searchParams.get('limit') || 30));

        const entitySamples = db.prepare(
          `SELECT p.target_id, p.raw_ref, p.quote, p.reason, p.locator,
                  en.name AS entity_name, en.type AS entity_type
             FROM provenance p
             LEFT JOIN entities en ON en.id = p.target_id
            WHERE p.source_title = ? AND p.scope = 'entity'
            ORDER BY p.id
            LIMIT ?`,
        ).all(title, Number(url.searchParams.get('limit') || 10));

        const distinctQuotes = db.prepare(
          `SELECT COUNT(DISTINCT quote) AS n FROM provenance WHERE source_title = ?`,
        ).get(title).n;
        const total = (byScope.edge || 0) + (byScope.entity || 0);

        return json(res, 200, {
          title,
          total,
          byScope,
          // 不同 quote 的条数。远小于总数说明大量断言共用同一条引文——
          // 那通常意味着自动生成，不是逐条读过。
          distinctQuotes,
          edges: edgeSamples.map((r) => ({
            targetId: r.target_id,
            subject: r.subject,
            subjectName: r.subject_name,
            predicate: r.predicate,
            object: r.object,
            objectName: r.object_name,
            rawRef: r.raw_ref,
            quote: r.quote,
            reason: r.reason,
            locator: r.locator ? safeJson(r.locator) : null,
          })),
          entities: entitySamples.map((r) => ({
            targetId: r.target_id,
            entityName: r.entity_name,
            entityType: r.entity_type,
            rawRef: r.raw_ref,
            quote: r.quote,
            reason: r.reason,
            locator: r.locator ? safeJson(r.locator) : null,
          })),
        });
      }

      // 总表：按文献分组，带条数。
      const rows = db.prepare(
        `SELECT source_title AS title, COUNT(*) AS n,
                SUM(CASE WHEN scope = 'edge' THEN 1 ELSE 0 END) AS edges,
                SUM(CASE WHEN scope = 'entity' THEN 1 ELSE 0 END) AS entities
           FROM provenance
          WHERE source_title IS NOT NULL
          GROUP BY source_title
          ORDER BY n DESC`,
      ).all();
      const untitled = db.prepare(
        `SELECT COUNT(*) AS n FROM provenance WHERE source_title IS NULL`,
      ).get().n;
      return json(res, 200, { sources: rows, untitled, total: rows.reduce((a, r) => a + r.n, 0) });
    }

    if (parts[1] === 'predicates') {
      // 每个谓词的边数 + 示例实体。谓词页靠它显示「这个谓词用了多少次」，
      // 没有数字的话 56 个谓词看起来一样重要，而实测分布极不均匀
      // （maleChild 90k vs daughter 2）。
      const counts = db.prepare(
        'SELECT predicate, COUNT(*) AS n FROM edges GROUP BY predicate',
      ).all();
      const byPredicate = new Map(counts.map((r) => [r.predicate, r.n]));

      // 示例只取前几个，用于「这个谓词长什么样」。ORDER BY id 保证稳定，
      // 否则每次刷新示例都变，用户会以为数据在动。
      const sampleStmt = db.prepare(
        `SELECT e.subject, e.object, s.name AS subject_name, o.name AS object_name
           FROM edges e
           LEFT JOIN entities s ON s.id = e.subject
           LEFT JOIN entities o ON o.id = e.object
          WHERE e.predicate = ?
          ORDER BY e.id
          LIMIT 3`,
      );

      // 单个谓词的详情。
      const want = parts[2];
      if (want) {
        const key = decodeURIComponent(want);
        return json(res, 200, {
          predicate: key,
          count: byPredicate.get(key) || 0,
          samples: sampleStmt.all(key).map((r) => ({
            subject: r.subject,
            subjectName: r.subject_name,
            object: r.object,
            objectName: r.object_name,
          })),
        });
      }

      // 总表：只返回边数，谓词定义在 registry 里（前端已有，不重复传）。
      const out = {};
      for (const [k, n] of byPredicate) out[k] = n;
      return json(res, 200, { counts: out, total: counts.reduce((a, r) => a + r.n, 0) });
    }

    if (parts[1] === 'timeline') {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return fail(res, 400, 'from and to must be julian day numbers');
      }
      // Ordered by birthDate because that is the indexed column. Ordering by name
      // here measured 28ms against 3ms: the range still narrows the rows, but the
      // sort then has to materialise them.
      const result = q.run(db, {
        where: [{ field: 'birthDate', op: 'between', value: [from, to] }],
        orderBy: [{ field: 'birthDate', dir: 'asc' }],
        limit: Number(url.searchParams.get('limit') || 200),
        cursor: url.searchParams.get('cursor') || undefined,
      });
      return json(res, 200, result);
    }

    // The descriptor's structure and allowed values are documented by the server
    // itself, so the frontend does not have to hardcode a second copy.
    if (parts[1] === 'schema') {
      return json(res, 200, {
        fields: Object.fromEntries(
          Object.entries(q.FIELD_SPECS).map(([k, v]) => [
            k,
            { type: v.type, ops: v.ops, sortable: !!v.sortable, nullable: !!v.nullable },
          ]),
        ),
        orderBy: Object.keys(q.ORDER_SPECS),
        cursorFields: q.CURSOR_FIELDS,
      });
    }

    return fail(res, 404, 'not found');
  } catch (e) {
    // A descriptor the compiler rejects is the caller's bug, not a server fault.
    // 400 lets the frontend distinguish "I asked wrong" from "the server broke".
    const status = e instanceof q.QueryError ? 400 : 500;
    return json(res, status, { error: e.message, code: e.code || 'ERROR' });
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`missing ${DB_PATH}\nrun: npm run build:db`);
    process.exit(1);
  }
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => json(res, 500, { error: e.message }));
  });
  server.listen(PORT, '127.0.0.1', () => {
    const n = Object.values(db.prepare('SELECT COUNT(*) c FROM entities').get())[0];
    const where = DEV ? 'repo root (dev, NEVER expose)' : 'site/ (published)';
    console.log(`HumanMap API  http://127.0.0.1:${PORT}/  (${n} entities, read-only, serving ${where})`);
    if (!fs.existsSync(path.join(SITE_ROOT, 'index.html'))) {
      console.warn('warning: no index.html in the served tree; run npm run build:site or set HM_DEV=1');
    }
  });
}

if (require.main === module) main();

/**
 * Test hooks.
 *
 * The module keeps the database in a module-level binding because the route table
 * needs it. Tests inject a small fixture instead of opening the real 330MB file,
 * and the `_`-prefixed readers let a test call the query functions directly without
 * going through a socket.
 */
function _setDb(next) {
  db = next;
}

module.exports = {
  route,
  main,
  descriptorFromQuery,
  familyTree,
  entityDetail,
  health,
  MAX_DEPTH,
  DEFAULT_DEPTH,
  _setDb,
  _db: () => db,
  _tree: (id, dir, depth, predicate) => familyTree(id, dir, depth, predicate),
  _detail: (id) => entityDetail(id),
  _health: () => health(),
};
