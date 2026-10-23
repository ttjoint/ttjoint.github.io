'use strict';
/**
 * Static, crawlable pages (`scripts/build_static_pages.js`).
 *
 * The viewer is a hash-routed SPA, so before this existed every entity in the
 * corpus resolved to the same URL (`<site>/#/...`) as far as any crawler was
 * concerned. These tests pin the three things that make the generated pages
 * worth having, each of which has a silent failure mode:
 *
 *   1. every published entity has a page, and its URL is stable and unique
 *   2. every internal link resolves to a file that exists (a dead link is
 *      invisible until a user clicks it, and a crawler just marks it 404)
 *   3. the sitemap advertises exactly the pages that exist, within protocol limits
 *
 * They run against a synthetic published tree rather than `site/`, so they test
 * the generator and not whatever happens to be built at the moment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gen = require('../../scripts/build_static_pages');

/** Build a throwaway published tree with the same shape build_index.js emits. */
function makeSite(dir, entities, predicateRegistry) {
  const folders = {
    person: 'persons',
    organization: 'organizations',
    event: 'events',
    thing: 'things',
    evidence: 'evidence',
  };
  for (const [type, folder] of Object.entries(folders)) {
    const list = entities.filter((e) => e.type === type);
    if (!list.length) continue;
    const base = path.join(dir, 'data', folder);
    fs.mkdirSync(path.join(base, 'entities'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'manifest.json'),
      JSON.stringify({
        version: 3,
        type,
        count: list.length,
        dated: list.filter((e) => e.lifespan && e.lifespan.start != null).length,
        pageSize: 2000,
        pageCount: 1,
        pages: [{ page: 0, file: 'index/page-000.json', count: list.length }],
      }),
    );
    fs.mkdirSync(path.join(base, 'index'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'index', 'page-000.json'),
      JSON.stringify(
        list.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          summary: e.summary || '',
          aliases: e.aliases || [],
          tags: e.tags || [],
          lifespan: e.lifespan || null,
          external: e.external || {},
          detail: `entities/${encodeURIComponent(e.id)}.json`,
        })),
      ),
    );
    for (const e of list) {
      fs.writeFileSync(
        path.join(base, 'entities', `${encodeURIComponent(e.id)}.json`),
        JSON.stringify(e),
      );
    }
  }
  const regDir = path.join(dir, '..', 'data', 'predicates');
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(
    path.join(regDir, 'registry.json'),
    JSON.stringify(predicateRegistry || { version: 1, predicates: [] }),
  );
  return dir;
}

function tmpSite(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hm-static-${name}-`));
  const site = path.join(root, 'site');
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<!DOCTYPE html><html><body><div id="app"></div></body></html>');
  // The real build copies css/ alongside the shell, and the generated pages link
  // it root-absolutely. Without the stub the link checker reports a false broken
  // link for every page and stops proving anything about the links it was written
  // to check.
  fs.mkdirSync(path.join(site, 'css'), { recursive: true });
  fs.writeFileSync(path.join(site, 'css', 'style.css'), ':root{}');
  return { root, site };
}

const SAMPLE = [
  {
    id: 'person:a',
    type: 'person',
    name: '張三',
    props: { 出生年月: '1901年' },
    lifespan: { start: 2415568, end: 2419000, mid: 2417000, uncertainty: 0, precision: 'year' },
    relations: { husband: ['person:b'] },
    tags: ['清末'],
    aliases: ['三郎'],
    provenance: [{ rawRef: 'raw:cbdb/BIOG_MAIN/1', quote: 'c_birthyear=1901', reason: '出生年月' }],
  },
  {
    id: 'person:b',
    type: 'person',
    name: '李四',
    lifespan: null,
    // Points at an entity outside the published slice: must not become a link.
    relations: { husband: ['person:not-published'] },
  },
  { id: 'organization:c', type: 'organization', name: '某会', props: { 简介: '一个组织' } },
  {
    id: 'evidence:d',
    type: 'evidence',
    name: '某证据',
    url: 'https://example.org/a?b=1&c=2',
    medium: 'web',
    accessedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Read every .html under a directory. */
function htmlFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.html')) out.push(p);
    }
  })(dir);
  return out;
}

// ------------------------------------------------------------------ URL shape

test('static: an entity URL is derived from type and slug, not from the name', () => {
  // The name is not unique and not URL-safe; the id is. Deriving the URL from the
  // name would collide the moment two people share one (which is common and legal
  // in this corpus) and would put CJK into the path.
  const page = gen.staticPathOf({ id: 'person:cbdb-122316', type: 'person' });
  assert.equal(page, 'p/person/cbdb-122316/');

  // The route segment differs from the type for organizations (`org`, per
  // EntitySchema in js/services.js) and must be used, or those pages 404.
  assert.equal(gen.staticPathOf({ id: 'organization:local-000001', type: 'organization' }), 'p/org/local-000001/');
  assert.equal(gen.staticPathOf({ id: 'thing:x', type: 'thing' }), 'p/thing/x/');
});

test('static: two entities with the same name get different URLs', () => {
  const a = gen.staticPathOf({ id: 'person:x1', type: 'person' });
  const b = gen.staticPathOf({ id: 'person:x2', type: 'person' });
  assert.notEqual(a, b);
});

test('static: a slug that contains unsafe characters is sanitised', () => {
  // Imported ids are supposed to be [A-Za-z0-9._-], but a bad import must not be
  // able to produce a traversal segment or a broken path.
  const p = gen.staticPathOf({ id: 'person:../../etc/passwd', type: 'person' });
  assert.doesNotMatch(p, /\.\./);
  assert.doesNotMatch(p, /:(?!\/)/);
});

// ------------------------------------------------------------------- escaping

test('static: text and attributes are escaped', () => {
  // A name containing markup would otherwise inject into every page that lists
  // it, and an evidence URL legitimately contains `&`.
  assert.equal(gen.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(gen.esc('a"b'), 'a&quot;b');
  assert.equal(gen.esc("a'b"), 'a&#39;b');
  assert.equal(gen.esc('a&b'), 'a&amp;b');
});

// ------------------------------------------------------------- page generation

test('static: every published entity gets a page, and only those', () => {
  const { site } = tmpSite('pages');
  makeSite(site, SAMPLE);
  const result = gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  assert.equal(result.pages, SAMPLE.length);
  for (const e of SAMPLE) {
    const file = path.join(site, gen.staticPathOf(e), 'index.html');
    assert.ok(fs.existsSync(file), `missing page for ${e.id}`);
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(html.includes(gen.esc(e.name)), `page for ${e.id} does not contain its name`);
    assert.match(html, /<link rel="canonical"/);
  }
});

test('static: a page carries real content for indexing, not just a title', () => {
  const { site } = tmpSite('content');
  makeSite(site, SAMPLE);
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  const html = fs.readFileSync(path.join(site, gen.staticPathOf(SAMPLE[0]), 'index.html'), 'utf8');
  // The provenance quote is the page's only prose; losing it leaves a name and
  // two years, which is thin content.
  assert.match(html, /c_birthyear=1901/);
  assert.match(html, /<h1>/);
  assert.match(html, /<meta name="description" content="[^"]{20,}"/);
});

test('static: a relation to an unpublished entity is text, not a dead link', () => {
  // 483,182 persons are excluded from the published slice. A spouse who is one of
  // them must not produce a link to a page that was never generated.
  const { site } = tmpSite('unpublished');
  makeSite(site, SAMPLE);
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  const html = fs.readFileSync(path.join(site, gen.staticPathOf(SAMPLE[1]), 'index.html'), 'utf8');
  assert.doesNotMatch(html, /p\/person\/not-published/);
  assert.match(html, /未收录/);
});

test('static: a predicate renders its Chinese label, not its raw key', () => {
  // `BUILTIN` is an array of definitions; iterating it as an object yields numeric
  // keys, which produced an empty label table and left every relation showing
  // `husband`. This is the regression test for that.
  const { root, site } = tmpSite('labels');
  makeSite(site, SAMPLE);
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });
  // The real registry lives at <root>/data/predicates/registry.json.
  const labels = gen.loadPredicateLabels();
  assert.equal(labels.husband, '夫');
  assert.equal(labels.father, '父亲');
  assert.ok(path.isAbsolute(root));

  const html = fs.readFileSync(path.join(site, gen.staticPathOf(SAMPLE[0]), 'index.html'), 'utf8');
  assert.match(html, /<dt>夫<\/dt>/);
  assert.doesNotMatch(html, /<dt>husband<\/dt>/);
});

// ---------------------------------------------------------------- link safety

test('static: every internal link resolves to a generated file', () => {
  // This is the check that catches an off-by-one in the relative prefix. The
  // entity pages sit four levels deep, so a wrong number of `../` produces links
  // that look fine in the source and 404 in a browser.
  const { site } = tmpSite('links');
  makeSite(site, SAMPLE);
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  let checked = 0;
  for (const file of htmlFiles(site)) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|#|data:)/.test(url)) continue;
      checked++;
      const bare = url.split('#')[0];
      const target = bare.startsWith('/')
        ? path.join(site, bare)
        : path.resolve(path.dirname(file), bare || '.');
      const candidates = [target, `${target}.html`, path.join(target, 'index.html')];
      assert.ok(
        candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile()),
        `broken link ${url} in ${path.relative(site, file)}`,
      );
    }
  }
  assert.ok(checked > 0, 'the walker found no links at all, so it proved nothing');
});

test('static: the interactive link points at the hash route, encoded', () => {
  // The SPA resolves `#/person/person:cbdb-1`; an unencoded colon happens to work
  // but is not what the router expects, and the id contains characters the
  // fragments must survive.
  const href = gen.spaHrefOf({ id: 'person:cbdb-1', type: 'person' });
  assert.match(href, /#\/person\/person%3Acbdb-1$/);
  assert.match(href, /^\.\.\/\.\.\/\.\.\//);
});

// -------------------------------------------------------------------- sitemap

test('static: the sitemap lists every entity page and nothing that is missing', () => {
  const { site } = tmpSite('sitemap');
  makeSite(site, SAMPLE);
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  const xml = fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(new Set(urls).size, urls.length, 'duplicate <loc> entries');

  for (const e of SAMPLE) {
    assert.ok(urls.includes(gen.staticUrlOf(e, 'https://example.test')), `sitemap missing ${e.id}`);
  }
  // Each advertised URL must resolve to a file, otherwise the sitemap teaches a
  // crawler to fetch 404s.
  for (const url of urls) {
    const rel = url.replace('https://example.test', '') || '/';
    const target = path.join(site, rel);
    assert.ok(
      [target, path.join(target, 'index.html')].some((c) => fs.existsSync(c)),
      `sitemap advertises a missing page: ${url}`,
    );
  }
});

test('static: sitemaps split at the protocol limit and cannot exceed it', () => {
  // 50,000 <url> entries and 50MB uncompressed are hard limits; a file over
  // either is silently ignored by crawlers, which looks identical to "not
  // indexed yet".
  const urls = Array.from({ length: 120000 }, (_, i) => `https://example.test/p/person/x${i}/`);
  const files = gen.buildSitemaps(urls);
  assert.ok(files.length >= 3, `expected a split, got ${files.length} file(s)`);

  const index = files.find((f) => f.name === 'sitemap-index.xml');
  assert.ok(index, 'a split sitemap set needs an index file');

  let total = 0;
  for (const f of files) {
    if (f.name === 'sitemap-index.xml') continue;
    const count = (f.xml.match(/<url>/g) || []).length;
    total += count;
    assert.ok(count <= gen.SITEMAP_MAX_URLS, `${f.name} has ${count} URLs`);
    assert.ok(Buffer.byteLength(f.xml, 'utf8') <= gen.SITEMAP_MAX_BYTES, `${f.name} is too large`);
  }
  assert.equal(total, urls.length, 'the split lost URLs');
});

test('static: a small site still gets a single sitemap.xml', () => {
  const files = gen.buildSitemaps(['https://example.test/a/', 'https://example.test/b/']);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'sitemap.xml');
});

test('static: robots.txt advertises the sitemap with an absolute URL', () => {
  // A relative Sitemap: line is invalid and silently ignored.
  const txt = gen.buildRobots('https://example.test');
  assert.match(txt, /^User-agent: \*$/m);
  assert.match(txt, /^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
  // A trailing slash on the base URL must not produce a double slash.
  assert.match(gen.buildRobots('https://example.test/'), /^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
});

// ------------------------------------------------------------- homepage shell

test('static: the homepage fallback is injected outside #app', () => {
  // The root component declares no `template`, so Vue compiles the innerHTML of
  // `#app` as its template. A fallback block inside `#app` would be eaten by that
  // compilation instead of being visible to a crawler.
  const { site } = tmpSite('home');
  makeSite(site, SAMPLE);
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.match(html, /<div id="static-fallback">/);
  assert.match(html, /href="\/browse\/"/);

  const appClose = html.indexOf('</div>', html.indexOf('<div id="app"'));
  const fallback = html.indexOf('id="static-fallback"');
  assert.ok(fallback > appClose, 'the fallback must come after #app is closed');
  assert.match(html, /id="static-fallback"[\s\S]*<\/body>/);
});

test('static: the homepage fallback links every non-empty type', () => {
  const { site } = tmpSite('home-links');
  makeSite(site, SAMPLE);
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  for (const type of ['person', 'organization']) {
    assert.match(html, new RegExp(`href="/browse/${type}/"`), `homepage does not link ${type}`);
  }
});

// ------------------------------------------------------------------ browse pages

test('static: browse pages paginate without dropping entities', () => {
  // The browse index is the crawl path to the leaf pages, so a paging bug hides
  // entities from crawlers even though their files exist.
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `person:p${String(i).padStart(3, '0')}`,
    type: 'person',
    name: `人${String(i).padStart(3, '0')}`,
  }));
  const { site } = tmpSite('browse');
  makeSite(site, many);
  const orig = gen.BROWSE_PAGE_SIZE;
  // 25 entities over a page size of 2000 is one page, so build twice to see the
  // link appear in both the file and the directory alias.
  gen.build({ siteDir: site, baseUrl: 'https://example.test', quiet: true });

  const page0 = fs.readFileSync(path.join(site, 'browse', 'person', 'page-0.html'), 'utf8');
  const alias = fs.readFileSync(path.join(site, 'browse', 'person', 'index.html'), 'utf8');
  assert.equal(page0, alias, 'page-0 and the directory alias must be identical');

  const linked = new Set([...page0.matchAll(/href="\/p\/person\/([^"]+)\/"/g)].map((m) => m[1]));
  assert.equal(linked.size, many.length, 'browse page does not link every entity');
  assert.equal(orig, gen.BROWSE_PAGE_SIZE);
});
