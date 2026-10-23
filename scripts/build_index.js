#!/usr/bin/env node
'use strict';
/**
 * Generate the browser indexes from sharded entity detail files.
 *
 * Why this is not a single array any more
 * ---------------------------------------
 * The old build wrote every entity into one `index.json`. At today's 5.3k
 * records that is 1.5 MB — tolerable. The project targets ~660k CBDB persons,
 * which would be roughly 190 MB of JSON, so the browser could not open it at
 * all. The layout below keeps the same information but makes the startup cost
 * independent of corpus size:
 *
 *   manifest.json         counts, page size, page list, chronology summary
 *   index/page-000.json   compact rows (name + minimal fields) for list views
 *   index/chrono.json     only dated entities, sorted by JDN, for the timeline
 *   search/prefix-XX.json name prefix buckets, for instant lookup
 *
 * A list view fetches one page; the timeline fetches one chronology file; a
 * search walks one or two prefix buckets. Nothing loads the whole corpus.
 *
 * `index.json` is still written as the *first page only* plus a pointer, so any
 * code path that still reads it degrades gracefully instead of breaking; the
 * manifest is the source of truth.
 *
 * Output is deterministic (sorted, fixed key order, no timestamps inside rows)
 * so rebuilt files diff cleanly in git.
 */
const fs = require('fs');
const path = require('path');
const { lifespanFromProps, rangeFromProp } = require('../src/store/graph_source');

// ---------------------------------------------------------------------------
// Publish filter
// ---------------------------------------------------------------------------
//
// The authoritative store holds the whole CBDB import (486k persons). That is what
// the local admin UI and the CLI query, and it must stay complete.
//
// The git-synced site is a different thing: it is a public, statically hosted
// exhibition of *modern* people — the archival, official-source part of the corpus.
// Pushing half a million ancient biographies to GitHub Pages would mean hundreds of
// megabytes in the repository and a first load measured in minutes, for material
// that is not the point of the site.
//
// So the two are split by output directory, not by deleting data:
//
//   npm run build:index     -> data/<type>/...          full corpus, local only
//   npm run build:site      -> site/data/<type>/...     modern subset, committed
//
// `--publish` selects the second. Nothing is ever removed from `data/`; the filter
// only decides which rows get copied into the publish tree.
const PUBLISH = process.argv.includes('--publish');

/** First year of the published window. Everything older stays local. */
const PUBLISH_FROM_YEAR = 1900;

/** JDN of 1900-01-01 (Gregorian), the cut-off for "modern". */
const PUBLISH_FROM_JDN = 2415021;

/**
 * Decide whether an entity belongs in the published site.
 *
 * Non-person entities (organizations, events, evidence, things) are all published:
 * they exist only because a modern, official source described them.
 *
 * Persons are published when they are dated 1900 or later. A person with no date at
 * all is *not* published — 408k of the CBDB import is undated, and an undated
 * biography cannot be shown to be modern. Being excluded from the site is not a
 * judgement about the person; it is the honest answer that we cannot place them.
 */
function isPublishable(entity, type) {
  if (type !== 'person') return true;
  const span = lifespanFromProps((entity.props) || {});
  if (!span) return false;
  // Use the latest year we know: someone born in 1880 who died in 1950 is a
  // twentieth-century figure and should be visible.
  const latest = span.end ?? span.start ?? span.mid;
  return latest != null && latest >= PUBLISH_FROM_JDN;
}

const ROOT = path.join(__dirname, '..', PUBLISH ? 'site/data' : 'data');
// build_index walks folder -> type, so use the inverse of the canonical map.
const { TYPE_OF_FOLDER: FOLDERS } = require('../src/store/entity_types');

/** Rows larger than this get paged; below it, one file is simpler and faster. */
const DEFAULT_PAGE_SIZE = 2000;

function rowOf(entity, type) {
  const props = entity.props || {};
  const lifespan = type === 'person'
    ? lifespanFromProps(props)
    : rangeFromProp(props['存在时间'] || props['成立时间'] || props['时间']);
  return {
    id: entity.id,
    name: entity.name || entity.legacyId || entity.id,
    type,
    aliases: entity.aliases || [],
    summary: (props['简介'] || props['描述'] || '').slice(0, 240),
    // Compact JDN range, or null. Presence of this field is what the timeline
    // filter keys on: absent means "undated", not "date unknown but included".
    lifespan: lifespan
      ? {
        start: lifespan.start,
        end: lifespan.end,
        mid: lifespan.mid,
        uncertainty: lifespan.uncertainty,
        precision: lifespan.precision,
      }
      : null,
    external: entity.external || null,
    detail: `entities/${encodeURIComponent(entity.id)}.json`,
  };
}

function writeJson(file, data, pretty) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data) + '\n';
  fs.writeFileSync(file, text);
  return Buffer.byteLength(text);
}

/**
 * Search bucketing.
 *
 * One file per two-character prefix produced 3.8k files for 5.3k people — the
 * manifest describing them gets as large as the data, and at 660k records the
 * file count alone would be unmanageable. Instead the *first* character selects
 * a bucket, and the buckets are packed greedily into groups of roughly
 * TARGET_BUCKET_ROWS rows so no single file is huge either. A Chinese surname
 * claims one bucket (李, 張, 王 ...), which is exactly the access pattern:
 * "searching 李 needs only the 李 bucket".
 *
 * The mapping lives in manifest.search.buckets as {char -> file}, which is
 * compact enough to stay well under a few hundred KB at 660k records.
 */
const TARGET_BUCKET_ROWS = 4000;

function firstChar(name) {
  const s = String(name || '').trim();
  return s ? Array.from(s)[0] : '';
}

function bucketFileName(index) {
  return `bucket-${String(index).padStart(3, '0')}.json`;
}

let total = 0;
const overview = {};

for (const [folder, type] of Object.entries(FOLDERS)) {
  // Publish builds read the authoritative shards from `data/` but write their
  // filtered output into `site/data/`, so the source and sink are never the same
  // directory.
  const sourceDir = path.join(__dirname, '..', 'data', folder);
  const dir = path.join(ROOT, folder);
  const sourceDetailDir = path.join(sourceDir, 'entities');
  const detailDir = path.join(dir, 'entities');

  // A type that exists in the model but has no entities yet is not an error.
  // Throwing here meant adding a fifth entity type required creating data before
  // the build could run at all, which is backwards.
  if (!fs.existsSync(sourceDetailDir)) {
    console.log(`${folder}: no shards, skipped`);
    fs.mkdirSync(detailDir, { recursive: true });
    overview[folder] = { count: 0, dated: 0, pages: 0 };
    continue;
  }

  const sourceRows = fs.readdirSync(sourceDetailDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(sourceDetailDir, f), 'utf8')));

  const kept = PUBLISH ? sourceRows.filter((e) => isPublishable(e, type)) : sourceRows;
  const dropped = sourceRows.length - kept.length;

  // Detail pages for published entities must be copied alongside their index rows,
  // otherwise every link 404s.
  if (PUBLISH) {
    fs.mkdirSync(detailDir, { recursive: true });
    for (const e of kept) {
      const name = `${encodeURIComponent(e.id)}.json`;
      fs.writeFileSync(path.join(detailDir, name), JSON.stringify(e, null, 2) + '\n');
    }
  }

  const rows = kept
    .map((x) => rowOf(x, type))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id));

  const pageSize = DEFAULT_PAGE_SIZE;
  const pages = [];
  for (let i = 0; i < rows.length; i += pageSize) {
    const slice = rows.slice(i, i + pageSize);
    const page = pages.length;
    const name = `page-${String(page).padStart(3, '0')}.json`;
    writeJson(path.join(dir, 'index', name), slice);
    pages.push({
      page,
      file: `index/${name}`,
      count: slice.length,
      first: slice.length ? slice[0].name : null,
      last: slice.length ? slice[slice.length - 1].name : null,
    });
  }

  // Chronology: dated rows only, ordered by JDN mid, for the timeline filter.
  const chrono = rows
    .filter((r) => r.lifespan && r.lifespan.mid != null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      mid: r.lifespan.mid,
      start: r.lifespan.start,
      end: r.lifespan.end,
      uncertainty: r.lifespan.uncertainty,
      precision: r.lifespan.precision,
    }))
    .sort((a, b) => a.mid - b.mid || a.id.localeCompare(b.id));
  writeJson(path.join(dir, 'index', 'chrono.json'), chrono);

  // Search buckets: group first characters into files of about
  // TARGET_BUCKET_ROWS rows, largest characters first.
  const byChar = new Map();
  for (const r of rows) {
    const c = firstChar(r.name);
    if (!byChar.has(c)) byChar.set(c, []);
    byChar.get(c).push({ id: r.id, name: r.name, type: r.type, aliases: r.aliases });
  }
  const charGroups = [...byChar.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh'));
  const buckets = [];
  let current = { chars: [], rows: [] };
  for (const [ch, items] of charGroups) {
    if (current.rows.length && current.rows.length + items.length > TARGET_BUCKET_ROWS) {
      buckets.push(current);
      current = { chars: [], rows: [] };
    }
    current.chars.push(ch);
    current.rows = current.rows.concat(items);
  }
  if (current.rows.length) buckets.push(current);

  const charToFile = {};
  const searchBuckets = [];
  buckets.forEach((b, i) => {
    const file = bucketFileName(i);
    writeJson(path.join(dir, 'search', file), b.rows);
    // Relative to the type folder, matching `buckets[].file` below. It used to be
    // the bare file name, which `DataStore.loadSearchBucket` joined onto
    // `data/<folder>/` and fetched as `data/persons/bucket-000.json` — a 404 that
    // the caller's `.catch` swallowed, so search silently fell back to whatever was
    // already in memory and never returned a bucket hit.
    const rel = `search/${file}`;
    b.chars.forEach((ch) => { charToFile[ch] = rel; });
    searchBuckets.push({ file: rel, chars: b.chars.join(''), count: b.rows.length });
  });

  const firstPageFile = pages.length ? pages[0].file.slice('index/'.length) : null;
  const manifest = {
    version: 3,
    type,
    count: rows.length,
    dated: chrono.length,
    pageSize,
    pageCount: pages.length,
    pages,
    chronology: chrono.length ? 'index/chrono.json' : null,
    search: {
      strategy: 'first-char',
      targetRows: TARGET_BUCKET_ROWS,
      // char -> bucket file, so a lookup is one map hit plus one fetch.
      charToFile: charToFile,
      buckets: searchBuckets,
    },
    // Legacy single-file pointer, kept so older code does not 404.
    legacyIndex: firstPageFile,
    detailDir: 'entities/',
  };
  writeJson(path.join(dir, 'manifest.json'), manifest, true);

  // index.json compat: this file is a *banner*, not the data.
  //
  // It used to be an array with `_truncated` attached as an array property,
  // which JSON.stringify silently drops — so consumers saw a bare 2000-row
  // array and could not tell it was truncated. That is exactly how validators
  // and importers ended up covering 2000 of 5351 entities while reporting OK.
  // Wrapping in an object keeps the marker visible after serialisation.
  if (pages.length) {
    const first = JSON.parse(fs.readFileSync(path.join(dir, pages[0].file), 'utf8'));
    writeJson(
      path.join(dir, 'index.json'),
      {
        _truncated: rows.length > first.length,
        _count: rows.length,
        _pageSize: first.length,
        _manifest: 'manifest.json',
        _note: '生成文件：仅为兼容保留，只含首页。全部数据见 index/page-*.json 或 entities/。请勿写入。',
        rows: first,
      },
      true,
    );
  } else {
    writeJson(path.join(dir, 'index.json'), { _truncated: false, _count: 0, rows: [] }, true);
  }

  console.log(
    `${folder}: ${rows.length} entries (${chrono.length} dated) -> ${pages.length} page(s), `
    + `${searchBuckets.length} search bucket(s)`
    + (PUBLISH && dropped ? ` [publish: ${dropped} pre-${PUBLISH_FROM_YEAR} or undated not published]` : ''),
  );
  overview[folder] = { count: rows.length, dated: chrono.length, pages: pages.length };
  total += rows.length;
}

writeJson(path.join(ROOT, 'manifest.json'), {
  version: 3,
  // The published tree states its own extent, so a reader can tell a filtered
  // build from a truncated one. Without this a 3.4k-row site looks like the whole
  // 486k corpus that lost 99% of its data.
  publish: PUBLISH
    ? { filtered: true, personsFromYear: PUBLISH_FROM_YEAR, note: '仅发布 1900 年及以后的现代人物；全量数据保留在本地 data/，不进入版本库。' }
    : { filtered: false, note: '全量语料，仅本地使用。' },
  types: overview,
  total,
}, true);

console.log(`total: ${total}`);
