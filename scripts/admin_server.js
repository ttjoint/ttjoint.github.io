#!/usr/bin/env node
/**
 * Local-only HumanMap admin API.
 *
 * Serves the review queue and entity CRUD over HTTP on 127.0.0.1, backed by
 * `local_data/humanmap.sqlite3`. Set HM_ADMIN_TOKEN to require a token.
 *
 * Layout note: the route handlers are kept short and the two non-obvious pieces
 * — mapping a reviewed candidate onto an entity, and seeding an empty database
 * from the shards — are named functions, because they both encode decisions that
 * are easy to get subtly wrong and worth reading in isolation.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const initSqlJs = require('sql.js');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'local_data');
const DB_FILE = path.join(DB_DIR, 'humanmap.sqlite3');
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.HM_ADMIN_TOKEN || '';

/** Max request body, in bytes. */
const MAX_BODY = 5e6;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://localhost:' + PORT,
    'access-control-allow-headers': 'content-type,x-admin-token',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (x) => {
      body += x;
      if (body.length > MAX_BODY) reject(new Error('request too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT }, (err, out, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(out);
    });
  });
}

/**
 * Human-readable source name for a profile URL.
 *
 * Stored on the entity so the UI shows "最高人民检察院" rather than a bare
 * hostname. Falls back to the host itself, which is still better than nothing.
 */
function sourceNameFor(url) {
  const m = String(url || '').match(/^https?:\/\/([^/]+)/i);
  const host = (m ? m[1] : '').toLowerCase();

  if (/spp\.gov\.cn$/.test(host)) return '最高人民检察院';
  if (/cppcc\.gov\.cn$/.test(host)) return '全国政协官网';
  if (/court\.gov\.cn$/.test(host)) return '最高人民法院';
  if (/npc\.gov\.cn$/.test(host)) return '中国人大网';
  if (/gov\.cn$/.test(host)) return '中国政府网';
  if (/people\.com\.cn$/.test(host)) return '人民网人物资料';
  if (/ccdi\.gov\.cn$/.test(host)) return '中央纪委国家监委';
  return host || '未知来源';
}

/**
 * Build the entity that an approved review produces.
 *
 * The candidate comes from `extract_structured_candidates.js` and carries the
 * fields the model or the rule extractor found; this maps them onto the Chinese
 * property keys the rest of the app reads. Every claim keeps its `evidence` and
 * `sourceUrl` so an approved record stays traceable to the sentence it came from.
 */
function entityFromReview(reviewRow) {
  const data = JSON.parse(reviewRow.data);
  const candidate = data.candidate || {};
  const evidence = data.evidence || {};
  const provenance = data.provenance || {};

  /** Drop empty strings and nulls so no blank props are stored. */
  const clean = (obj) => Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== '' && v != null),
  );

  const claims = {};
  if ((candidate.currentPositions || []).length) {
    claims.currentPositions = candidate.currentPositions.map((p) => ({
      organization: p.organization || '',
      role: p.role || '',
      evidence: p.evidence || '',
      sourceUrl: evidence.sourceUrl,
    }));
  }
  if ((candidate.career || []).length) {
    claims.career = candidate.career.map((p) => ({
      date: p.date || '',
      organization: p.organization || '',
      role: p.role || '',
      evidence: p.evidence || '',
      sourceUrl: evidence.sourceUrl,
    }));
  }

  return {
    id: data.id,
    type: 'person',
    name: candidate.name || reviewRow.name,
    props: clean({
      性别: candidate.gender,
      出生年月: candidate.birthDate,
      籍贯: candidate.nativePlace,
      民族: candidate.ethnicity,
      学历: candidate.education,
      逝世时间: candidate.deceasedDate,
      简介: candidate.summary,
      // Review state is metadata about this record, not a classification of the
      // person. It lived in `tags` alongside '官方资料', which is provenance and is
      // already carried by `sources` below.
      审核状态: '已审核',
    }),
    aliases: [],
    relations: {},
    sources: [{
      id: 'review:' + data.id,
      name: sourceNameFor(evidence.sourceUrl),
      url: evidence.sourceUrl,
      accessedAt: provenance.createdAt || new Date().toISOString(),
      note: `经管理员审核通过（${provenance.method || 'rules'}）`,
    }],
    claims,
  };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
  data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_entity_search ON entities(type, name, deleted);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT, action TEXT, payload TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_queue(
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', source_batch TEXT,
  review_note TEXT, reviewed_at TEXT);
`;

async function openDatabase() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (f) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', f) });

  const isNew = !fs.existsSync(DB_FILE);
  const db = isNew ? new SQL.Database() : new SQL.Database(fs.readFileSync(DB_FILE));
  db.run(SCHEMA);

  const save = () => fs.writeFileSync(DB_FILE, Buffer.from(db.export()));

  function query(sql, args = []) {
    const stmt = db.prepare(sql);
    stmt.bind(args);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  /** Load pending candidates from the structured-import batches into the queue. */
  function importReviews() {
    const dir = path.join(ROOT, 'data', 'imports', 'official');
    if (!fs.existsSync(dir)) return;

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('structured-') && f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const batch = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const rec of batch.records || []) {
        if (rec.status !== 'pending') continue;
        const candidate = rec.candidate || {};
        db.run(
          `INSERT INTO review_queue(id,type,name,data,status,source_batch,review_note,reviewed_at)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             type=excluded.type, name=excluded.name, data=excluded.data, source_batch=excluded.source_batch
           WHERE review_queue.status='pending'`,
          [rec.id, rec.type, candidate.name || rec.id, JSON.stringify(rec), 'pending', file, '', ''],
        );
      }
    }
  }

  /**
   * Seed an empty database from the authoritative shards.
   *
   * Uses `readEntities` (manifest + shards), not `index.json`, which holds only
   * its first page and would seed a fraction of the corpus.
   *
   * `INSERT OR IGNORE` is deliberate: an id already present in the audit database
   * may carry a reviewer's unsaved edits, and seeding must never overwrite those.
   * The flip side is that the audit database only ever moves forward on NEW ids —
   * it never picks up changes made to a shard after its first seeding.
   */
  function seedFromShards() {
    const { readEntities } = require('../src/store/data_reader');
    const { TYPE_OF_FOLDER } = require('../src/store/entity_types');
    const folders = TYPE_OF_FOLDER;
    let added = 0;

    for (const [folder, type] of Object.entries(folders)) {
      // A type with no entities yet (a freshly introduced one) must not abort
      // seeding for the others.
      if (!fs.existsSync(path.join(ROOT, 'data', folder, 'entities'))) continue;
      for (const full of readEntities(folder)) {
        const before = query('SELECT id FROM entities WHERE id = ?', [full.id]).length;
        db.run(
          'INSERT OR IGNORE INTO entities(id,type,name,data,deleted,updated_at) VALUES(?,?,?,?,0,?)',
          [full.id, type, full.name || full.legacyId || full.id, JSON.stringify(full), new Date().toISOString()],
        );
        if (!before) added++;
      }
    }
    return added;
  }

  /**
   * Pull entities that exist only on disk into the audit database.
   *
   * ## The bug this fixes
   *
   * Seeding used to run only when the database file did not exist
   * (`if (isNew)`). After that the SQLite copy never learned about anything
   * written to the shards — new imports, new evidence nodes, `props` restored by
   * a re-import. `npm run publish` then exported the stale copy back over the
   * shards: re-importing repaired the shards, and the very next `publish` put the
   * damage back ("5269 files changed" was the tell).
   *
   * `--refresh` brings the two sides back in step without dropping review state.
   *
   * ## Why overwrite is opt-in
   *
   * The audit database has no "reviewer has edited this" flag, so an unconditional
   * overwrite from disk could silently discard work done in the admin UI. The
   * default is therefore additive (fill in ids the database has never seen);
   * `--from-shards` additionally replaces rows whose stored payload differs from
   * the shard, which is what you want after repairing the authoritative data.
   */
  function refreshFromShards({ overwrite = false } = {}) {
    const { readEntities } = require('../src/store/data_reader');
    const { TYPE_OF_FOLDER } = require('../src/store/entity_types');
    let added = 0;
    let replaced = 0;

    for (const [folder, type] of Object.entries(TYPE_OF_FOLDER)) {
      if (!fs.existsSync(path.join(ROOT, 'data', folder, 'entities'))) continue;
      for (const full of readEntities(folder)) {
        const existing = query('SELECT data FROM entities WHERE id = ?', [full.id]);
        const payload = JSON.stringify(full);
        if (!existing.length) {
          db.run(
            'INSERT OR IGNORE INTO entities(id,type,name,data,deleted,updated_at) VALUES(?,?,?,?,0,?)',
            [full.id, type, full.name || full.id, payload, new Date().toISOString()],
          );
          added++;
        } else if (overwrite && existing[0].data !== payload) {
          db.run('UPDATE entities SET data = ?, updated_at = ? WHERE id = ?',
            [payload, new Date().toISOString(), full.id]);
          replaced++;
        }
      }
    }

    console.log(`refresh: 补入 ${added} 个实体` + (overwrite ? `，按分片重写 ${replaced} 个` : '（已有记录未改动，加 --from-shards 可覆盖）'));
  }

  if (isNew) {
    seedFromShards();
    importReviews();
    // Drop stale pending rows so a re-import reflects the current batches.
    db.run("DELETE FROM review_queue WHERE status = 'pending'");
    importReviews();
    save();
  } else if (process.argv.includes('--refresh')) {
    refreshFromShards({ overwrite: process.argv.includes('--from-shards') });
    save();
  }

  return { db, save, query, importReviews };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function main() {
  const { db, save, query } = await openDatabase();

  function auth(req, res) {
    if (TOKEN && req.headers['x-admin-token'] !== TOKEN) {
      json(res, 401, { error: '需要 X-Admin-Token' });
      return false;
    }
    return true;
  }

  function audit(entityId, action, payload) {
    db.run('INSERT INTO audit(entity_id,action,payload,at) VALUES(?,?,?,?)', [
      entityId, action, JSON.stringify(payload || {}), new Date().toISOString(),
    ]);
  }

  /** Serve a static file, refusing anything outside ROOT. */
  function serve(res, pathname) {
    if (pathname === '/admin' || pathname === '/admin.html') pathname = '/admin.html';

    const relative = String(pathname || '/index.html').replace(/^[/\\]+/, '');
    const file = path.resolve(ROOT, relative);
    const rootResolved = path.resolve(ROOT);

    // Path traversal guard: the resolved file must stay inside ROOT.
    if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) {
      return json(res, 404, { error: 'not found' });
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return json(res, 404, { error: 'not found' });
    }

    res.writeHead(200, {
      'content-type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain',
    });
    fs.createReadStream(file).pipe(res);
  }

  async function route(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1:' + PORT}`);
    const parts = parsed.pathname.split('/').filter(Boolean);

    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (parts[0] !== 'api') return serve(res, parsed.pathname);
    if (!auth(req, res)) return;

    try {
      const id = parts[2] ? decodeURIComponent(parts[2]) : '';

      if (parts[1] === 'reviews' && req.method === 'GET') {
        const status = parsed.searchParams.get('status') || 'pending';
        const rows = query(
          'SELECT * FROM review_queue WHERE (?="" OR status=?) ORDER BY rowid',
          [status, status],
        );
        return json(res, 200, rows.map((x) => ({ ...x, data: JSON.parse(x.data) })));
      }

      if (parts[1] === 'reviews' && id && req.method === 'PUT') {
        const body = await readBody(req);
        const status = body.status;
        if (!['approved', 'rejected', 'pending'].includes(status)) {
          return json(res, 400, { error: 'invalid review status' });
        }

        const existing = query('SELECT * FROM review_queue WHERE id=?', [id]);
        if (!existing.length) return json(res, 404, { error: 'review not found' });

        db.run('UPDATE review_queue SET status=?,review_note=?,reviewed_at=? WHERE id=?', [
          status, body.note || '', new Date().toISOString(), id,
        ]);

        if (status === 'approved') {
          const entity = entityFromReview(existing[0]);
          db.run(
            'INSERT OR REPLACE INTO entities(id,type,name,data,deleted,updated_at) VALUES(?,?,?,?,0,?)',
            [entity.id, entity.type, entity.name, JSON.stringify(entity), new Date().toISOString()],
          );
          audit(id, 'review-approved', { note: body.note || '', entityId: entity.id });
        } else {
          audit(id, 'review-' + status, { note: body.note || '' });
        }

        save();
        return json(res, 200, { ok: true, status });
      }

      if (parts[1] === 'audit') {
        return json(res, 200, query('SELECT * FROM audit ORDER BY id DESC LIMIT 200'));
      }

      if (parts[1] === 'entities' && req.method === 'GET' && !id) {
        const q = parsed.searchParams.get('q') || '';
        const type = parsed.searchParams.get('type') || '';
        const limit = Math.min(Number(parsed.searchParams.get('limit') || 500), 20000);
        const offset = Number(parsed.searchParams.get('offset') || 0);

        const rows = query(
          'SELECT data FROM entities WHERE deleted=0 AND (?="" OR type=?) AND (?="" OR name LIKE ?) ORDER BY name LIMIT ? OFFSET ?',
          [type, type, q, '%' + q + '%', limit, offset],
        );
        return json(res, 200, rows.map((x) => JSON.parse(x.data)));
      }

      if (parts[1] === 'entities' && req.method === 'GET' && id) {
        const rows = query('SELECT data FROM entities WHERE id=? AND deleted=0', [id]);
        return rows.length ? json(res, 200, JSON.parse(rows[0].data)) : json(res, 404, { error: 'not found' });
      }

      if (parts[1] === 'entities' && (req.method === 'POST' || req.method === 'PUT')) {
        const entity = await readBody(req);
        if (!entity.id || !entity.type || !entity.name) {
          return json(res, 400, { error: 'id,type,name required' });
        }

        const exists = query('SELECT id FROM entities WHERE id=?', [entity.id]).length;
        db.run(
          'INSERT OR REPLACE INTO entities(id,type,name,data,deleted,updated_at) VALUES(?,?,?,?,0,?)',
          [entity.id, entity.type, entity.name, JSON.stringify(entity), new Date().toISOString()],
        );
        audit(entity.id, exists ? 'update' : 'create', entity);
        save();
        return json(res, 200, entity);
      }

      if (parts[1] === 'entities' && req.method === 'DELETE' && id) {
        db.run('UPDATE entities SET deleted=1,updated_at=? WHERE id=?', [new Date().toISOString(), id]);
        audit(id, 'soft-delete');
        save();
        return json(res, 200, { ok: true });
      }

      if (parts[1] === 'publish' && req.method === 'POST') {
        await exec(process.execPath, ['scripts/export_static.js']);
        return json(res, 200, { ok: true, message: '静态数据已生成' });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // `--refresh` is a maintenance action: sync and exit. Leaving a server
  // listening would make a one-shot sync behave like `npm run admin` and force
  // the caller to kill it (or trip over EADDRINUSE on the next run).
  if (process.argv.includes('--refresh')) {
    return;
  }

  http.createServer(route).listen(PORT, '127.0.0.1', () => {
    console.log(`HumanMap admin: http://127.0.0.1:${PORT}/admin.html`);
  });
}

main();
