#!/usr/bin/env node
'use strict';
/**
 * Generate crawlable static pages for the published tree.
 *
 * ## Why this exists
 *
 * The viewer is a hash-routed SPA (`/#/person/person:cbdb-122316`). A fragment is
 * never sent to the server, so every entity in the corpus resolves to the same
 * URL: `<site>/`. A crawler therefore sees one page — the shell — and the other
 * 3,809 entities do not exist as far as any search engine is concerned.
 *
 * Inlining static content into the shell does not fix that: it makes `/` richer,
 * not the entities discoverable. Discovery needs a distinct, linked URL per
 * entity. So this script writes one plain HTML page per published entity at a
 * real path, plus a browse index that links them all, plus a sitemap.
 *
 *   site/p/<route>/<slug>/index.html
 *   site/browse/index.html
 *   site/sitemap.xml
 *   site/robots.txt
 *
 * ## Why these are not the SPA
 *
 * They carry no JavaScript at all. A visitor who lands here reads the record and
 * can jump into the interactive view with one link. Rendering the Vue app on each
 * of 3,810 pages would need a DOM per page (jsdom or headless Chrome) and would
 * multiply build time by three orders of magnitude for no indexing benefit —
 * Google parses the static HTML fine.
 *
 * This is the deliberate split recommended for this project: the entity pages are
 * "SEO beacons" that carry semantics, not the interactive experience.
 *
 * ## Nothing here invents data
 *
 * Every string comes from the published shards. Fields that are absent are
 * omitted rather than guessed; a relation whose target is outside the published
 * tree renders as plain text marked 未收录 instead of a dead link.
 *
 * Usage: node scripts/build_static_pages.js [--base-url https://host]
 */

const fs = require('fs');
const path = require('path');

const { formatRange } = require('../src/time/julian');
const { BUILTIN } = require('../src/predicates/registry');
const { PredicateRegistry } = require('../src/predicates/registry');

// Shards store relations under their authored label (`时代`), while predicate
// definitions are keyed by canonical key (`era`). One registry resolves the two.
const registry = new PredicateRegistry();

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');

/**
 * Public origin, used for absolute URLs in <link rel=canonical> and sitemap.xml.
 *
 * Both require absolute URLs. The default matches the repository this site ships
 * from (`ttjoint/ttjoint.github.io` is a user site, so Pages serves it at the
 * domain root). Override with --base-url when deploying elsewhere.
 */
const DEFAULT_BASE_URL = 'https://ttjoint.github.io';

/** Folder in site/data -> entity type. Mirrors FOLDERS in js/core/data_store.js. */
const FOLDERS = {
  persons: 'person',
  organizations: 'organization',
  events: 'event',
  things: 'thing',
  evidence: 'evidence',
};

/**
 * Entity type -> router path segment.
 *
 * Must match `EntitySchema` in js/services.js. It is duplicated rather than
 * imported because that file is a browser bundle relying on globals (`Vue`,
 * `EntitySchema` at top level), not a Node module.
 */
const ROUTES = {
  person: 'person',
  organization: 'org',
  event: 'event',
  thing: 'thing',
  evidence: 'evidence',
};

const TYPE_LABELS = {
  person: '人物',
  organization: '组织',
  event: '事件',
  thing: '非人实体',
  evidence: '证据',
};

/**
 * Sitemap protocol hard limits. Exceeding either makes the file invalid and
 * silently unreadable by crawlers, so the generator splits instead.
 */
const SITEMAP_MAX_URLS = 50000;
const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

/** Escape text for an HTML text node or a quoted attribute value. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * URL path segment for an entity id.
 *
 * Ids are `<type>:<slug>` and every published slug matches [A-Za-z0-9._-], which
 * was verified against the whole published tree; the colon is the only character
 * that needs dropping. The rest of the sanitising is for future imports: an id is
 * data, and data must never be able to choose a path.
 *
 * Two specific hazards, both silent until something reads the wrong file:
 *   - `/` in an id would introduce an extra path segment;
 *   - a slug of `.` or `..` makes `path.join` walk up out of the site directory.
 *     `person:..` is not hypothetical once ids come from an import.
 */
function slugOf(id) {
  const colon = String(id).indexOf(':');
  const raw = colon > 0 ? String(id).slice(colon + 1) : String(id);
  let slug = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  // A run of dots can be read as a directory reference (`..`) or as a hidden
  // file (`.foo`). Neither is a legitimate entity name, so neutralise both.
  slug = slug.replace(/\.{2,}/g, '-').replace(/^\.+/, '');
  return slug || '-unknown-';
}

/** Site-relative URL of an entity's static page, e.g. `p/person/cbdb-122316/`. */
function staticPathOf(entity) {
  return `p/${ROUTES[entity.type] || 'person'}/${slugOf(entity.id)}/`;
}

/** Absolute URL of an entity's static page. */
function staticUrlOf(entity, baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/${staticPathOf(entity)}`;
}

/**
 * Hash URL of the interactive view for an entity.
 *
 * Relative on purpose: the page sits four levels deep, and a visitor may be
 * serving the tree from a subdirectory. `../../../` walks back to the site root.
 */
function spaHrefOf(entity) {
  const id = encodeURIComponent(entity.id);
  return `../../../#/${ROUTES[entity.type] || 'person'}/${id}`;
}

/** Predicate key -> Chinese label, from the builtin registry plus extensions. */
function loadPredicateLabels() {
  const labels = {};
  // `BUILTIN` is an ARRAY of definitions, not a key->def map. Iterating it with
  // Object.entries() yields numeric indices as keys, which silently produced an
  // empty label table and left every relation rendering its raw key (`husband`).
  const defs = Array.isArray(BUILTIN) ? BUILTIN : Object.values(BUILTIN || {});
  for (const def of defs) {
    if (def && def.key && def.label) labels[def.key] = def.label;
  }
  const ext = path.join(ROOT, 'data', 'predicates', 'registry.json');
  if (fs.existsSync(ext)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ext, 'utf8'));
      for (const p of parsed.predicates || []) {
        if (p && p.key && p.label) labels[p.key] = p.label;
      }
    } catch (err) {
      throw new Error(`data/predicates/registry.json is not valid JSON: ${err.message}`);
    }
  }
  return labels;
}

/**
 * Predicate keys whose target is a value, not an entity id.
 *
 * Without this the relation renderer treats `birthDate: 1104年` as a dangling entity
 * reference and prints `1104年（未收录）`, which reads as "this value has a page but
 * was not published". It is not an entity at all. The same distinction is made in
 * the browser (entity_detail.js `resolvedRelations`).
 */
function loadLiteralPredicates() {
  const literals = new Set();
  const defs = Array.isArray(BUILTIN) ? BUILTIN : Object.values(BUILTIN || {});
  for (const def of defs) {
    if (def && def.key && def.range === 'literal') literals.add(def.key);
  }
  const ext = path.join(ROOT, 'data', 'predicates', 'registry.json');
  if (fs.existsSync(ext)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ext, 'utf8'));
      for (const p of parsed.predicates || []) {
        if (p && p.key && p.range === 'literal') literals.add(p.key);
      }
    } catch (err) {
      throw new Error(`data/predicates/registry.json is not valid JSON: ${err.message}`);
    }
  }
  return literals;
}

/**
 * Read the published tree.
 *
 * Index pages carry the computed `lifespan` (the entity shard does not), and the
 * shard carries props/relations/provenance. Both are needed, so this loads the
 * index rows first and then the detail file each row points at.
 */
function loadPublished(siteDir) {
  const byType = {};
  const byId = new Map();

  for (const [folder, type] of Object.entries(FOLDERS)) {
    const dir = path.join(siteDir, 'data', folder);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entities = [];

    for (const page of manifest.pages || []) {
      const pagePath = path.join(dir, page.file);
      if (!fs.existsSync(pagePath)) continue;
      for (const row of JSON.parse(fs.readFileSync(pagePath, 'utf8'))) {
        const detailRel = row.detail || `entities/${encodeURIComponent(row.id)}.json`;
        const detailPath = path.join(dir, detailRel);
        let detail = {};
        if (fs.existsSync(detailPath)) {
          detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
        }
        // Index row first, detail over it: name/lifespan come from the index,
        // everything else from the shard. The shard's own `name` wins when both
        // exist, because it is the stored value and the index is derived from it.
        const entity = { ...row, ...detail, lifespan: row.lifespan || null };
        entity.type = entity.type || type;
        entities.push(entity);
        byId.set(entity.id, entity);
      }
    }

    byType[type] = entities;
  }

  return { byType, byId };
}

/** Render one `key: value` block, or '' when there is nothing to show. */
/**
 * Render a prop value, turning entity references into links.
 *
 * Two reference spellings exist in the data: `【person:cbdb-1】` and a bare
 * `person:cbdb-1` left in running text. Both should be clickable — a reader who
 * sees an id must be able to follow it — so both resolve through one shape gate.
 * The gate is the `type:` prefix, which prose does not contain by accident.
 *
 * `ctx.byId` decides the label: the entity's own name when it is in the published
 * slice, the raw id otherwise, marked as unpublished rather than linked into a 404.
 */
function linkRefs(value, ctx) {
  const text = String(value ?? '');
  const BARE = /(person|organization|event|thing|evidence):[A-Za-z0-9._-]+/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = BARE.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    const id = m[0];
    const target = ctx.byId.get(id);
    if (target) {
      out += `<a href="../../../${staticPathOf(target)}">${esc(target.name || id)}</a>`;
    } else {
      out += `<span class="static-unpublished">${esc(id)}（未收录）</span>`;
    }
    last = m.index + id.length;
  }
  out += esc(text.slice(last));
  return out;
}

function renderProps(entity, ctx) {
  const props = entity.props || {};
  const entries = Object.entries(props).filter(([, v]) => v != null && String(v).trim() !== '');
  if (!entries.length) return '';
  const rows = entries
    .map(
      ([k, v]) =>
        `      <div class="static-prop"><dt>${esc(k)}</dt><dd>${linkRefs(v, ctx)}</dd></div>`,
    )
    .join('\n');
  return `
  <section class="static-section">
    <h2>基本资料</h2>
    <dl class="static-props">
${rows}
    </dl>
  </section>`;
}

/** Render the relation list, linking only targets present in the published tree. */
function renderRelations(entity, ctx) {
  const relations = entity.relations || {};
  const keys = Object.keys(relations).filter((k) => {
    const v = relations[k];
    return Array.isArray(v) ? v.length : v != null;
  });
  if (!keys.length) return '';

  const blocks = keys
    .map((predicate) => {
      const label = ctx.labels[predicate] || predicate;
      // `relations` is keyed by whatever the shard used. Shards use the Chinese
      // label (`时代`) while the literal set is keyed by the canonical key (`era`),
      // so resolve through the alias table before testing membership.
      const canonical = ctx.resolveKey(predicate);
      const isLiteral = ctx.literalPredicates.has(canonical);
      const targets = Array.isArray(relations[predicate])
        ? relations[predicate]
        : [relations[predicate]];
      const items = targets
        .map((targetId) => {
          // A literal is the value itself: never look it up, never call it missing.
          if (isLiteral) return esc(targetId);
          const target = ctx.byId.get(targetId);
          if (target) {
            const name = target.name || targetId;
            return `<a href="../../../${staticPathOf(target)}">${esc(name)}</a>`;
          }
          // The target exists in the corpus but not in this published slice
          // (e.g. a pre-1900 spouse). Say so instead of linking into a 404.
          return `<span class="static-unpublished">${esc(targetId)}（未收录）</span>`;
        })
        .join('、');
      return `      <div class="static-prop"><dt>${esc(label)}</dt><dd>${items}</dd></div>`;
    })
    .join('\n');

  return `
  <section class="static-section">
    <h2>关系</h2>
    <dl class="static-props">
${blocks}
    </dl>
  </section>`;
}

/**
 * Render provenance quotes.
 *
 * For person records this is the only prose on the page, and it is real: the
 * quote is the verbatim source string the value was extracted from. Without it a
 * detail page is a name and two years, which is thin content for indexing.
 */
function renderProvenance(entity) {
  const entries = Array.isArray(entity.provenance) ? entity.provenance : [];
  const usable = entries.filter((p) => p && typeof p.quote === 'string' && p.quote.trim());
  const sources = Array.isArray(entity.sources) ? entity.sources.filter(Boolean) : [];
  if (!usable.length && !sources.length) return '';

  const quoteItems = usable
    .map(
      (p) => `      <li><span class="static-reason">${esc(p.reason || '来源')}</span>
        <code class="static-quote">${esc(p.quote)}</code>
        <span class="static-ref">${esc(p.rawRef || '')}</span></li>`,
    )
    .join('\n');
  const sourceItems = sources
    .map((s) => `      <li><span class="static-ref">${esc(s)}</span></li>`)
    .join('\n');

  return `
  <section class="static-section">
    <h2>资料来源</h2>
    ${quoteItems ? `<ul class="static-quotes">\n${quoteItems}\n    </ul>` : ''}
    ${sourceItems ? `<ul class="static-quotes">\n${sourceItems}\n    </ul>` : ''}
  </section>`;
}

/** Aliases, when present. `tags` is not rendered because the field no longer exists. */
function renderAliasSection(entity) {
  const aliases = (Array.isArray(entity.aliases) ? entity.aliases : []).filter(Boolean);
  if (!aliases.length) return '';
  return `
  <section class="static-section">
    <h2>其他</h2>
    <dl class="static-props">
      <div class="static-prop"><dt>别名</dt><dd>${aliases
        .map((x) => `<span class="static-alias">${esc(x)}</span>`)
        .join('')}</dd></div>
    </dl>
  </section>`;
}

/** Evidence records have their own shape: a URL, a medium, a reliability note. */
function renderEvidenceDetail(entity) {
  const rows = [];
  if (entity.url) {
    rows.push(
      `<div class="static-prop"><dt>链接</dt><dd><a href="${esc(entity.url)}" rel="nofollow noopener">${esc(entity.url)}</a></dd></div>`,
    );
  }
  if (entity.medium) rows.push(`<div class="static-prop"><dt>载体</dt><dd>${esc(entity.medium)}</dd></div>`);
  if (entity.documentedAt)
    rows.push(`<div class="static-prop"><dt>成文时间</dt><dd>${esc(entity.documentedAt)}</dd></div>`);
  if (entity.accessedAt)
    rows.push(`<div class="static-prop"><dt>查阅时间</dt><dd>${esc(entity.accessedAt)}</dd></div>`);
  if (entity.reliability != null)
    rows.push(`<div class="static-prop"><dt>可靠性</dt><dd>${esc(entity.reliability)}</dd></div>`);
  if (entity.excerpt) rows.push(`<div class="static-prop"><dt>摘录</dt><dd>${esc(entity.excerpt)}</dd></div>`);
  if (!rows.length) return '';
  return `
  <section class="static-section">
    <h2>证据信息</h2>
    <dl class="static-props">
      ${rows.join('\n      ')}
    </dl>
  </section>`;
}

/** A short, honest <meta description>: only what the record actually says. */
function describe(entity, ctx) {
  const typeLabel = TYPE_LABELS[entity.type] || entity.type;
  const parts = [`${entity.name}`];
  const span = formatRange(entity.lifespan);
  if (span) parts.push(span);
  parts.push(typeLabel);
  const props = entity.props || {};
  for (const key of ['简介', '职能']) {
    const v = props[key];
    if (v && String(v).trim()) {
      parts.push(String(v).trim());
      break;
    }
  }
  if (entity.summary && String(entity.summary).trim()) parts.push(String(entity.summary).trim());
  const relCount = Object.values(entity.relations || {}).reduce(
    (n, v) => n + (Array.isArray(v) ? v.length : v ? 1 : 0),
    0,
  );
  if (relCount) parts.push(`记载 ${relCount} 条关系`);
  parts.push('HumanMap 人物与组织关系图谱');
  // Chinese characters are wide; ~120 keeps the description readable in results.
  const text = parts.join('，').replace(/\s+/g, ' ');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** Shared page furniture. Mirrors the SPA header/footer classes from css/style.css. */
function pageShell({ title, description, canonical, canonicalPrev, canonicalNext, body }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
${canonicalPrev ? `<link rel="prev" href="${esc(canonicalPrev)}">` : ''}
${canonicalNext ? `<link rel="next" href="${esc(canonicalNext)}">` : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<link rel="stylesheet" href="/css/style.css">
</head>
<body class="static-page">
<header class="app-header">
  <div class="header-inner">
    <a href="/" class="logo">
      <span class="logo-icon">◈</span>
      <span class="logo-text">HumanMap</span>
    </a>
    <div class="header-right">
      <a href="/browse/" class="btn btn-sm" style="margin-right:4px">全部对象</a>
      <div class="mode-badge">只读模式</div>
    </div>
  </div>
</header>
<main class="app-main">
${body}
</main>
<footer class="app-footer">
  <span>HumanMap &copy; 2026</span>
  <span class="footer-sep">·</span>
  <span>人际关系与家族图谱分析系统</span>
</footer>
</body>
</html>
`;
}

/** One entity page. */
function renderEntityPage(entity, ctx) {
  const typeLabel = TYPE_LABELS[entity.type] || entity.type;
  const span = formatRange(entity.lifespan);
  const heading = span ? `${entity.name}（${span}）` : entity.name;

  const body = `  <article class="static-entity">
    <nav class="static-crumb">
      <a href="/">首页</a> <span class="footer-sep">·</span>
      <a href="/browse/">全部对象</a> <span class="footer-sep">·</span>
      <span>${esc(typeLabel)}</span>
    </nav>
    <h1>${esc(heading)}</h1>
    <p class="static-meta">${esc(typeLabel)}${span ? ` · ${esc(span)}` : ''}${
      entity.aliases && entity.aliases.length ? ` · 别名：${esc(entity.aliases.join('、'))}` : ''
    }</p>
${renderProps(entity, ctx)}${renderRelations(entity, ctx)}${renderEvidenceDetail(entity)}${renderAliasSection(entity)}${renderProvenance(entity)}
    <p class="static-cta">
      <a class="btn" href="${spaHrefOf(entity)}">在交互式图谱中查看 →</a>
    </p>
  </article>`;

  return pageShell({
    title: `${entity.name}${span ? `（${span}）` : ''} · HumanMap`,
    description: describe(entity, ctx),
    canonical: staticUrlOf(entity, ctx.baseUrl),
    body,
  });
}

/**
 * The browse index.
 *
 * Grouped by type and split across pages so a single page never grows with the
 * corpus. `pageSize` is deliberately far below the 50k sitemap limit: this page
 * is also what a human scrolls.
 */
const BROWSE_PAGE_SIZE = 2000;

function renderBrowsePage(type, entities, pageIndex, pageCount, ctx) {
  const items = entities
    .map((e) => {
      const span = formatRange(e.lifespan);
      return `      <li><a href="/${staticPathOf(e)}">${esc(e.name)}</a>${
        span ? `<span class="static-year">${esc(span)}</span>` : ''
      }</li>`;
    })
    .join('\n');

  const pager = [];
  if (pageIndex > 0) {
    pager.push(`<a href="/browse/${type}/page-${pageIndex - 1}.html">← 上一页</a>`);
  }
  pager.push(`<span>第 ${pageIndex + 1} / ${pageCount} 页</span>`);
  if (pageIndex < pageCount - 1) {
    pager.push(`<a href="/browse/${type}/page-${pageIndex + 1}.html">下一页 →</a>`);
  }

  const typeLabel = TYPE_LABELS[type] || type;
  const body = `  <article class="static-entity">
    <nav class="static-crumb">
      <a href="/">首页</a> <span class="footer-sep">·</span>
      <a href="/browse/">全部对象</a>
    </nav>
    <h1>${esc(typeLabel)}索引</h1>
    <p class="static-meta">共 ${ctx.counts[type] || entities.length} 条，本页 ${entities.length} 条</p>
    <ul class="static-list">
${items}
    </ul>
    <nav class="static-pager">${pager.join(' <span class="footer-sep">·</span> ')}</nav>
  </article>`;

  const url = `${ctx.baseUrl}/browse/${type}/page-${pageIndex}.html`;
  return pageShell({
    title: `${typeLabel}索引（第 ${pageIndex + 1} 页）· HumanMap`,
    description: `HumanMap 已收录的${typeLabel}，第 ${pageIndex + 1} 页，共 ${pageCount} 页。`,
    canonical: pageIndex === 0 ? `${ctx.baseUrl}/browse/${type}/` : url,
    canonicalPrev: pageIndex > 0 ? `${ctx.baseUrl}/browse/${type}/page-${pageIndex - 1}.html` : null,
    canonicalNext:
      pageIndex < pageCount - 1 ? `${ctx.baseUrl}/browse/${type}/page-${pageIndex + 1}.html` : null,
    body,
  });
}

/** Landing page for /browse/: one link per type. */
function renderBrowseHub(ctx) {
  const rows = Object.entries(ctx.byType)
    .filter(([, list]) => list.length)
    .map(([type, list]) => {
      const typeLabel = TYPE_LABELS[type] || type;
      return `      <li><a href="/browse/${type}/">${esc(typeLabel)}</a><span class="static-year">${list.length} 条</span></li>`;
    })
    .join('\n');

  const body = `  <article class="static-entity">
    <nav class="static-crumb"><a href="/">首页</a></nav>
    <h1>全部对象</h1>
    <p class="static-meta">按类型浏览已发布的记录，每条都有独立的静态页面。</p>
    <ul class="static-list">
${rows}
    </ul>
  </article>`;

  return pageShell({
    title: '全部对象 · HumanMap',
    description: 'HumanMap 已收录的人物、组织、事件、非人实体与证据，按类型浏览。',
    canonical: `${ctx.baseUrl}/browse/`,
    body,
  });
}

/**
 * Split a URL list into sitemap files respecting both protocol limits.
 *
 * Returns `[{name, xml}]`. A single file is named `sitemap.xml`; multiple are
 * `sitemap-0.xml`, ... plus a `sitemap-index.xml` pointing at them.
 */
function buildSitemaps(urls) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  const overhead = 200;
  for (const url of urls) {
    const entry = `  <url><loc>${esc(url)}</loc></url>\n`;
    const bytes = Buffer.byteLength(entry, 'utf8');
    if (
      current.length >= SITEMAP_MAX_URLS ||
      (current.length && currentBytes + bytes > SITEMAP_MAX_BYTES - overhead)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(url);
    currentBytes += bytes;
  }
  if (current.length) chunks.push(current);

  const wrap = (list) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${list
      .map((u) => `  <url><loc>${esc(u)}</loc></url>`)
      .join('\n')}\n</urlset>\n`;

  if (chunks.length === 1) return [{ name: 'sitemap.xml', xml: wrap(chunks[0]) }];
  const files = chunks.map((list, i) => ({ name: `sitemap-${i}.xml`, xml: wrap(list) }));
  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files
    .map((f) => `  <sitemap><loc>${f.name}</loc></sitemap>`)
    .join('\n')}\n</sitemapindex>\n`;
  files.push({ name: 'sitemap-index.xml', xml: index });
  return files;
}

/**
 * Static content for the SPA shell's homepage.
 *
 * Placed OUTSIDE `#app` and at the end of <body>, for two reasons:
 *  - the root component declares no `template`, so Vue compiles the mount
 *    element's innerHTML (`#app`) as its template. Content inside `#app` would be
 *    swallowed by that compilation; content after it is not.
 *  - at the end of the body it sits below the fold, so the moment before
 *    `app.js` removes it never flashes above the fold.
 *
 * Its job is crawl discovery: the SPA header links with <router-link>, which is
 * client-side only, so without this the homepage emits no real <a href> into the
 * site and a crawler has no path to the entity pages.
 */
function renderHomeFallback(ctx) {
  const rows = Object.entries(ctx.byType)
    .filter(([, list]) => list.length)
    .map(([type, list]) => {
      const label = TYPE_LABELS[type] || type;
      return `      <li><a href="/browse/${type}/">${esc(label)}</a><span class="static-year">${list.length} 条</span></li>`;
    })
    .join('\n');
  const total = Object.values(ctx.counts).reduce((a, b) => a + b, 0);
  return `<div id="static-fallback">
  <h2>HumanMap：人物与组织关系图谱</h2>
  <p>已发布 ${total} 条记录，每条都有可检索的独立页面。数据来源为 CBDB（中国历代人物传记资料库）与官方公开文献，每项取值均附原文证据。</p>
  <ul class="static-list">
${rows}
  </ul>
  <p><a href="/browse/">按类型浏览全部 ${total} 条记录 →</a></p>
</div>`;
}

/**
 * Splice the homepage fallback into the copied shell.
 *
 * Written into `site/index.html` only — the source `index.html` stays untouched so
 * `npm run serve` (which serves the repo root) never shows generated content and
 * there is still exactly one shell file to maintain.
 */
function injectHomeFallback(siteDir, ctx) {
  const file = path.join(siteDir, 'index.html');
  if (!fs.existsSync(file)) return false;
  const html = fs.readFileSync(file, 'utf8');
  const block = renderHomeFallback(ctx);
  const marker = '</body>';
  const at = html.lastIndexOf(marker);
  if (at < 0) return false;
  fs.writeFileSync(file, `${html.slice(0, at)}${block}\n${html.slice(at)}`, 'utf8');
  return true;
}

/** robots.txt: allow everything, advertise the sitemap. */
function buildRobots(baseUrl) {
  const sitemapName = 'sitemap.xml';
  return `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl.replace(/\/+$/, '')}/${sitemapName}\n`;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function parseBaseUrl(argv) {
  const i = argv.indexOf('--base-url');
  const raw = i >= 0 ? argv[i + 1] : process.env.HM_SITE_URL;
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Generate every static page.
 *
 * Returns a summary so build_site.js can report what shipped.
 */
function build({ siteDir = SITE, baseUrl = DEFAULT_BASE_URL, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const { byType, byId } = loadPublished(siteDir);
  const total = byId.size;
  if (!total) {
    log('no published entities found; skipping static pages');
    return { pages: 0, bytes: 0 };
  }

  const counts = {};
  for (const [type, list] of Object.entries(byType)) counts[type] = list.length;

  const ctx = {
    byId,
    byType,
    baseUrl,
    labels: loadPredicateLabels(),
    literalPredicates: loadLiteralPredicates(),
    // Resolve a shard's predicate spelling (`时代`) to its canonical key (`era`)
    // so range lookups work regardless of which form the shard used.
    resolveKey: (k) => (registry.resolve(k) || k),
    counts,
  };

  // Entity pages.
  let bytes = 0;
  for (const entity of byId.values()) {
    const html = renderEntityPage(entity, ctx);
    writeFile(path.join(siteDir, staticPathOf(entity), 'index.html'), html);
    bytes += Buffer.byteLength(html, 'utf8');
  }
  log(`static entity pages: ${total} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  // Browse hub.
  writeFile(path.join(siteDir, 'browse', 'index.html'), renderBrowseHub(ctx));

  // Browse pages, one series per type.
  const sitemapUrls = [];
  for (const [type, list] of Object.entries(byType)) {
    if (!list.length) continue;
    const sorted = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    const pageCount = Math.max(1, Math.ceil(sorted.length / BROWSE_PAGE_SIZE));
    for (let i = 0; i < pageCount; i++) {
      const slice = sorted.slice(i * BROWSE_PAGE_SIZE, (i + 1) * BROWSE_PAGE_SIZE);
      const html = renderBrowsePage(type, slice, i, pageCount, ctx);
      // page-0 also lands at the type directory so /browse/person/ resolves.
      if (i === 0) writeFile(path.join(siteDir, 'browse', type, 'index.html'), html);
      writeFile(path.join(siteDir, 'browse', type, `page-${i}.html`), html);
    }
    log(`browse pages: ${type} ${sorted.length} -> ${pageCount} page(s)`);
  }

  // Sitemap: canonical entity URLs plus the browse pages. Deliberately excludes
  // the browse pagination duplicates (page-0 == the type directory).
  sitemapUrls.push(`${baseUrl}/`);
  sitemapUrls.push(`${baseUrl}/browse/`);
  for (const type of Object.keys(counts)) {
    if (counts[type]) sitemapUrls.push(`${baseUrl}/browse/${type}/`);
  }
  for (const entity of byId.values()) sitemapUrls.push(staticUrlOf(entity, baseUrl));

  const sitemaps = buildSitemaps(sitemapUrls);
  for (const file of sitemaps) writeFile(path.join(siteDir, file.name), file.xml);
  writeFile(path.join(siteDir, 'robots.txt'), buildRobots(baseUrl));
  log(`sitemap: ${sitemapUrls.length} URLs in ${sitemaps.length} file(s)`);

  if (injectHomeFallback(siteDir, ctx)) log('homepage: static fallback injected');

  return { pages: total, bytes, sitemaps: sitemaps.length, sitemapUrls: sitemapUrls.length };
}

module.exports = {
  build,
  // Exported for tests.
  esc,
  slugOf,
  staticPathOf,
  staticUrlOf,
  spaHrefOf,
  describe,
  renderEntityPage,
  renderBrowsePage,
  renderHomeFallback,
  injectHomeFallback,
  buildSitemaps,
  buildRobots,
  loadPredicateLabels,
  loadPublished,
  DEFAULT_BASE_URL,
  BROWSE_PAGE_SIZE,
  SITEMAP_MAX_URLS,
  SITEMAP_MAX_BYTES,
  TYPE_LABELS,
  ROUTES,
  FOLDERS,
};

if (require.main === module) {
  const result = build({ baseUrl: parseBaseUrl(process.argv) });
  process.exitCode = result.pages ? 0 : 1;
}
