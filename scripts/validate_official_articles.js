#!/usr/bin/env node
/**
 * Validate the latest discovered-articles batch.
 *
 * Checks batch metadata, per-article completeness, URL uniqueness, and that the
 * declared `count` matches reality — a mismatch means a write was truncated.
 */
const {
  readLatestBatch,
} = require('../src/store/batches');

const VALID_STATUS = ['unreviewed', 'approved'];

function main() {
  const { name, data: x } = readLatestBatch('articles-', 'npm run discover:articles');

  const bad = [];
  if (!x.source?.id || !x.discoveredAt) bad.push('missing batch metadata');

  const urls = new Set();
  for (const a of x.articles || []) {
    if (!a.title || !a.url || !a.sourceId) bad.push('incomplete article');
    if (urls.has(a.url)) bad.push('duplicate URL ' + a.url);
    urls.add(a.url);
    if (!VALID_STATUS.includes(a.status)) bad.push('invalid status ' + a.url);
  }

  const actual = (x.articles || []).length;
  if (x.count !== actual) bad.push(`count mismatch: declared ${x.count}, actual ${actual}`);

  console.log(JSON.stringify({
    file: name,
    count: x.count,
    actual,
    uniqueUrls: urls.size,
    errors: bad,
  }, null, 2));

  process.exitCode = bad.length ? 1 : 0;
}

main();
