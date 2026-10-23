'use strict';
/**
 * Write entities the way the rest of the pipeline expects them.
 *
 * Importers used to read `data/<type>/index.json`, merge in new records, and
 * write the whole array back. That was correct when `index.json` held every
 * entity. It is now a generated compatibility file containing only the first
 * index page, so the same code would read ~2000 summaries, treat them as the
 * full corpus, and overwrite the index with a merge of that subset — silently
 * dropping every entity from every later page.
 *
 * The authoritative store is now one JSON file per entity in
 * `data/<type>/entities/`. Importers merge against those shards, write them,
 * and then the index is rebuilt from them by `npm run build:index`.
 */
const fs = require('fs');
const path = require('path');

// This file lives in src/store/, so the repo root is two levels up.
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', 'data');
const { FOLDERS, folderOf } = require('./entity_types');

/**
 * Override the data root. Tests use this to work against a temp directory;
 * production code never calls it.
 *
 * The root is resolved through a mutable binding rather than a frozen const
 * because `shardPath` and `readAll` capture it at call time, not at module load.
 * Capturing it at load time made it impossible to isolate a test — which is
 * exactly how an earlier test run wrote throwaway entities into the real corpus.
 */
let dataRoot = DEFAULT_ROOT;

function setDataRoot(dir) {
  dataRoot = dir || DEFAULT_ROOT;
}

function shardPath(type, id) {
  return path.join(dataRoot, folderOf(type), 'entities', encodeURIComponent(id) + '.json');
}

/** All entities of a type (single source of truth: the shards). */
function readAll(type) {
  const dir = path.join(dataRoot, folderOf(type), 'entities');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/**
 * Merge records into the shard store.
 *
 * Records are matched by `id`, then by `name` (so re-importing the same person
 * under an equal id does not duplicate them). `merge` decides what happens to a
 * record that already exists; the default keeps existing data and adds the new
 * sources.
 *
 * Returns { added, updated, written, total, addedRecords }.
 */
function upsertAll(type, records, merge, opts) {
  const existing = new Map(readAll(type).map((e) => [e.id, e]));
  const byName = new Map([...existing.values()].map((e) => [e.name, e]));
  const mergeFn = merge || defaultMerge;
  let added = 0;
  let updated = 0;
  const addedRecords = [];

  for (const rec of records) {
    if (!rec || !rec.id) continue;
    const prev = existing.get(rec.id) || byName.get(rec.name);
    if (prev) {
      if (prev.id !== rec.id) continue; // same name, different id: leave both alone
      const next = mergeFn(prev, rec, opts);
      if (JSON.stringify(next) !== JSON.stringify(prev)) updated++;
      existing.set(prev.id, next);
    } else {
      existing.set(rec.id, rec);
      byName.set(rec.name, rec);
      addedRecords.push(rec);
      added++;
    }
  }

  // Only write shards whose content actually changed: rewriting every file is
  // slow at corpus scale and churns the filesystem for no reason.
  let written = 0;
  for (const entity of existing.values()) {
    const file = shardPath(type, entity.id);
    const text = JSON.stringify(entity, null, 2) + '\n';
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch (e) { /* new shard */ }
    if (current === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    written++;
  }
  // `addedRecords` lets callers report on what this run introduced, without
  // re-deriving it by diffing id sets.
  return { added, updated, written, total: existing.size, addedRecords };
}

/** Keep existing fields, append any new sources, and fill gaps from the record. */
/**
 * Default merge: keep curated fields, add new sources.
 *
 * `opts.replaceSources` switches `sources` from union to replacement. A migration
 * that rewrites source objects into evidence references needs replacement —
 * otherwise the union brings the old inline objects back and the migration is
 * silently undone on the next write.
 */
function defaultMerge(prev, rec, opts) {
  const out = Object.assign({}, rec, prev);
  const replaceSources = !!(opts && opts.replaceSources);
  // `replaceName` 让导入器修正后的名字覆盖磁盘上的旧名。
  //
  // 默认 `prev` 胜出（保护人工命名），但身份字段不能永远锁死：CBDB 的 434 条
  // 女性记录曾把关系写进名字（`雷氏(孛朮魯遠妻)`）。提取算法改成剥离括注后，
  // 重跑导入仍拿旧名——因为 `Object.assign({}, rec, prev)` 让 prev.name 赢了。
  // 不改名就只能删掉重建，而删掉会丢掉那些已经挂在它们名下的边。
  if (opts && opts.replaceName && rec.name) out.name = rec.name;
  // `replaceRelations` 让导入器重算的关系（含边级出处）覆盖磁盘上的旧值。
  //
  // 不加这个开关时，`Object.assign({}, rec, prev)` 让 prev.relations 全胜——
  // 导入器新提取的 provenance 永远写不进去，而 upsertAll 会报「更新 0 条」。
  //
  // `ownedPredicates` 声明「本次导入负责哪些谓词」：属于它的谓词以 rec 为准，
  // rec 没产出就删掉。不属于它的保留。
  //
  // 为什么需要这个：不声明时只能按「rec 有就覆盖、没有就保留」处理，
  // 于是导入器**修正掉的错误边永远删不掉**。实测中 CBDB 的复合码（`SS`=孫）
  // 本该不建边，但早期版本把 11 万条落成了 `kin`；修好后重跑，
  // 这些错误边因为「rec 没产出 kin」而被保留下来。
  if (opts && opts.replaceRelations && rec.relations) {
    const owned = opts.ownedPredicates ? new Set(opts.ownedPredicates) : null;
    const merged = Object.assign({}, prev.relations || {});

    if (owned) {
      // 导入器负责的谓词：以 rec 为准，rec 没有就清掉。
      //
      // 但**只清带出处的条目**。名字括注迁移建的 `kin` 边（527 条）与
      // KIN_DATA 无关，源数据里根本没有对应的行；它们没有 provenance，
      // 导入器重跑也永远不会重新产生。一并删掉就是静默丢数据。
      for (const pred of Object.keys(merged)) {
        if (!owned.has(pred)) continue;
        if (rec.relations[pred] && rec.relations[pred].length) continue;
        const keep = (merged[pred] || []).filter((v) => {
          const hasProv = v && typeof v === 'object'
            && Array.isArray(v.provenance) && v.provenance.length;
          return !hasProv;
        });
        if (keep.length) merged[pred] = keep;
        else delete merged[pred];
      }
    }

    // 逐条清掉被细化谓词取代的旧条目，而不是整键删除。
    //
    // 粒度很关键：一个人的 `sibling` 可能指向三个人，其中两个已被
    // 细化为 brother/sister，第三个源数据只说「是手足」——
    // 整键删除会把第三条也删掉，而它本来就是正确答案。
    for (const stale of (opts.superseded || [])) {
      const replacement = (opts.supersededBy && opts.supersededBy[stale]) || [];
      const refinedTargets = new Set();
      for (const k of replacement) {
        for (const v of rec.relations[k] || []) {
          const id = typeof v === 'string' ? v : v && (v.id || v.target);
          if (id) refinedTargets.add(id);
        }
      }
      if (!refinedTargets.size) continue;
      const keep = (merged[stale] || []).filter((v) => {
        const id = typeof v === 'string' ? v : v && (v.id || v.target);
        return !refinedTargets.has(id);
      });
      if (keep.length) merged[stale] = keep;
      else delete merged[stale];
    }
    for (const [pred, entries] of Object.entries(rec.relations)) {
      if (Array.isArray(entries) && entries.length) merged[pred] = entries;
    }
    out.relations = merged;
  }
  // `sourcesAudit` is for the review→publish path (export_static): the SQLite
  // review workspace holds pre-migration inline source objects, while the
  // authoritative shards hold evidence references plus the node topology. Under
  // this option a reference already on disk wins, and an incoming inline object
  // describing the same article (same URL) is dropped as stale. Without it, a
  // no-op `npm run publish` re-added 114 inline citations and silently undid the
  // sources→evidence migration.
  const audit = !!(opts && opts.sourcesAudit);
  const sources = replaceSources ? [] : [...(prev.sources || [])];
  const keyOf = (s) => {
    if (!s) return null;
    if (typeof s === 'string') return String(s);
    return s.id || s.url || null;
  };
  const seen = new Set(sources.map(keyOf).filter(Boolean));
  // URLs already cited on disk. An inline object in the review database whose
  // URL is already cited is the same citation, not a second one.
  //
  // The URL must also be recoverable from INLINE objects' references: after the
  // migration a shard holds `"evidence:3e1d…"` and the review database still
  // holds the pre-migration object with that same URL. Without `opts.evidenceUrl`
  // the two look unrelated, so the object is appended and the shard ends up
  // citing the article twice. That is how `npm run publish` undid the migration.
  const evidenceUrl = (opts && opts.evidenceUrl) || null;
  const seenUrls = new Set();
  for (const s of sources) {
    if (typeof s === 'string') {
      const u = evidenceUrl && evidenceUrl[s];
      if (u) seenUrls.add(u);
    } else if (s && s.url) {
      seenUrls.add(s.url);
    }
  }
  // Under `sourcesAudit`, an inline object on disk whose evidence node is also
  // referenced by id is a duplicate of that node; drop it so the shard keeps the
  // reference form.
  if (audit) {
    const refs = sources.filter((s) => typeof s === 'string');
    if (refs.length) {
      const kept = sources.filter((s) => {
        if (typeof s === 'string') return true;
        const u = s && s.url;
        // Keep the object only if no reference claims the same URL through
        // `opts.evidenceUrl` (evidence id -> url), when the caller can supply it.
        const map = opts.evidenceUrl || null;
        if (!u || !map) return true;
        return !refs.some((id) => map[id] === u);
      });
      sources.length = 0;
      sources.push(...kept);
    }
  }

  for (const s of rec.sources || []) {
    const key = keyOf(s);
    if (key && seen.has(key)) continue;
    // An inline object whose URL is already cited is the same source, not a new
    // one. This is what kept a migrated entity citing one article twice.
    if (s && typeof s === 'object' && s.url && seenUrls.has(s.url)) continue;
    if (key) seen.add(key);
    if (s && typeof s === 'object' && s.url) seenUrls.add(s.url);
    sources.push(s);
  }

  // Only materialise the container fields when there is something in them.
  //
  // Unconditionally setting them meant `upsertAll` added `sources: []` and
  // `external: {}` to records that had neither, so the content comparison below
  // always differed on the first pass and every export rewrote every shard. That
  // is how a no-op `npm run publish` ended up touching all 34 organization files
  // and reporting 64 writes for zero real changes.
  if (sources.length) out.sources = sources;
  else if (!('sources' in prev)) delete out.sources;

  // `replaceProps` 让导入器重算的 props 覆盖磁盘上的旧值。
  //
  // 默认是 `prev` 胜出，这是为了保护人工编辑过的记录不被导入覆盖。代价是：
  // 导入器修正了提取逻辑（例如把「1004年」改成「约 1004年 ± 30」）后重跑，
  // 新值永远写不进去，而 upsertAll 会报告「更新 0 条」——看起来像是没变化。
  //
  // `dropProps` 列出要删除的键：导入器不再产出的字段（如已废弃的
  // `名字括注`）必须真的从磁盘消失。合并写法会让删掉的字段永远留着——
  // 代码改了，数据却还是旧的。
  let props = (opts && opts.replaceProps)
    ? Object.assign({}, prev.props || {}, rec.props || {})
    : Object.assign({}, rec.props || {}, prev.props || {});
  for (const k of (opts && opts.dropProps) || []) delete props[k];
  if (Object.keys(props).length) out.props = props;
  else if (!('props' in prev)) delete out.props;

  const external = Object.assign({}, rec.external || {}, prev.external || {});
  if (Object.keys(external).length) out.external = external;
  else if (!('external' in prev)) delete out.external;

  // `claims` is structured data (positions, career entries with evidence), not
  // free-form props, so an importer that recomputes it must be able to replace
  // it. Before this, `Object.assign({}, rec, prev)` let `prev` win on every
  // field, so a corrected claim was silently discarded and `upsertAll` reported
  // updated: 0 for a record that really did change.
  if (rec.claims && Object.keys(rec.claims).length) {
    out.claims = Object.assign({}, prev.claims || {}, rec.claims);
  } else if (prev.claims) {
    out.claims = prev.claims;
  }

  return out;
}

module.exports = {
  readAll,
  upsertAll,
  shardPath,
  folderOf,
  FOLDERS,
  setDataRoot,
  DEFAULT_ROOT,
  defaultMerge,
};
