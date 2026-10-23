#!/usr/bin/env node
/**
 * Validate `data/sources/official.json`.
 *
 * Checks that every source has a well-formed id, an absolute URL, and a known
 * priority, and that no id or URL is duplicated.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'sources', 'official.json');

/** Source ids are their own namespace: `source:govorg:abc123`. */
const ID_RE = /^source:[a-z0-9:-]+$/;

const PRIORITIES = ['A', 'B', 'C'];

const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const ids = new Set();
const urls = new Set();
const errors = [];

for (const s of cfg.sources) {
  if (ids.has(s.id)) errors.push('duplicate id ' + s.id);
  ids.add(s.id);

  if (urls.has(s.url)) errors.push('duplicate url ' + s.url);
  urls.add(s.url);

  if (!ID_RE.test(s.id)) errors.push('invalid id ' + s.id);
  if (!/^https?:\/\//.test(s.url)) errors.push('invalid url ' + s.url);
  if (!PRIORITIES.includes(s.priority)) errors.push('invalid priority ' + s.id);
}

console.log(JSON.stringify({ count: cfg.sources.length, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
