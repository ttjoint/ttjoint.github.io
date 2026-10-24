#!/usr/bin/env node
'use strict';
/**
 * Assemble the public, git-synced site into `site/`.
 *
 * ## Why a separate tree
 *
 * The authoritative corpus is the full CBDB import — 486,788 persons as of the
 * last import. The local admin UI, the CLI and every importer work against it, and
 * it must stay complete.
 *
 * The repository is a different artefact: it is a statically hosted exhibition of
 * modern, sourced people. Committing half a million ancient biographies would put
 * hundreds of megabytes into git, blow past GitHub Pages' limits and make the first
 * page load unusable — for material that is not what the site is for.
 *
 * So the split is by output directory, never by deletion:
 *
 *   data/            authoritative everything           not committed (see .gitignore)
 *   site/            published modern subset            committed, this is what ships
 *
 * `site/` is a build product. Nothing should ever be edited inside it; the sources
 * are `index.html`, `js/`, `css/` and `data/`.
 *
 * ## What goes in
 *
 *   - the shell (`index.html`, `js/`, `css/`)
 *   - `data/<type>/` built with `build_index.js --publish`, i.e. persons from 1900
 *     CE onward plus every non-person entity
 *   - `data/predicates/registry.json`, so the browser resolves predicate words
 *   - `p/<type>/<slug>/index.html`, `browse/`, `sitemap.xml`, `robots.txt` from
 *     `build_static_pages.js` (see below)
 *
 * ## Why the static pages
 *
 * The viewer is a hash-routed SPA, so every entity shares the URL `<site>/#/...`
 * and a fragment never reaches a server. To a crawler the whole corpus was one
 * page. `build_static_pages.js` writes one real HTML page per published entity at
 * `/p/<type>/<slug>/` plus a linked browse index, so entities are discoverable
 * without running JavaScript. Those pages carry no JS and are not the SPA; they
 * link into it.
 *
 * Evidence and sources are copied in full: they only exist because a modern
 * official document mentioned them.
 *
 * Usage: node scripts/build_site.js [--clean]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');

/** Files and directories that make up the browser shell. */
// `vendor` 必须在列表里：Vue 从 CDN 改成本地后，漏了 vendor 会让
// 静态站白屏（`Vue is not defined`），而本地开发看 index.html 是好的——
// 问题只在发布产物里出现，最难查的一类。
const SHELL = ['index.html', 'js', 'css', 'vendor'];

/** Copy a file or directory tree. Returns the number of files written. */
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const entry of fs.readdirSync(src)) {
      // `.DS_Store` and editor droppings are not part of the site.
      if (/^(\.DS_Store|Thumbs\.db|\.git)$/.test(entry)) continue;
      n += copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return n;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 1;
}

/** Total size of a tree, in bytes. */
function treeSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d)) {
      const p = path.join(d, entry);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function main() {
  // `--clean` matters because the publish filter shrinks the set over time: a name
  // that was published once and is not any more would otherwise linger in
  // site/data as a stale page or detail file, and the site would show people the
  // current filter excludes.
  if (process.argv.includes('--clean') && fs.existsSync(SITE)) {
    fs.rmSync(SITE, { recursive: true, force: true });
    console.log('removed existing site/');
  }
  fs.mkdirSync(SITE, { recursive: true });

  for (const entry of SHELL) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) {
      throw new Error(`missing shell entry: ${entry}`);
    }
    const n = copyRecursive(src, path.join(SITE, entry));
    console.log(`copied ${entry} (${n} file${n === 1 ? '' : 's'})`);
  }

  // Predicate registry: the browser needs the word table to label edges, and it is
  // generated from the same source as the rest of the data.
  const registry = path.join(ROOT, 'data', 'predicates', 'registry.json');
  if (fs.existsSync(registry)) {
    copyRecursive(registry, path.join(SITE, 'data', 'predicates', 'registry.json'));
  } else {
    throw new Error('data/predicates/registry.json missing; run npm run build:index first');
  }

  // The filtered indexes. `--publish` reads data/ and writes site/data/.
  execFileSync(process.execPath, [path.join(__dirname, 'build_index.js'), '--publish'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // Crawlable static pages. Must run after `--publish` so it pages exactly the
  // published set: a beacon page for an entity the filter excludes would be a
  // page the SPA cannot open.
  const { build: buildStaticPages } = require('./build_static_pages');
  const staticResult = buildStaticPages({ siteDir: SITE });

  // The public site must not still reference the local admin database or the raw
  // CBDB dump. Neither is in site/, but check that nothing expects them.
  const size = treeSize(SITE);
  console.log(`\nsite/ assembled: ${mb(size)}`);
  if (size > 100 * 1024 * 1024) {
    console.warn(`warning: site/ exceeds 100 MB (${mb(size)}); GitHub will reject files this large.`);
  }
}

main();
