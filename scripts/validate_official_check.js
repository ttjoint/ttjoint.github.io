#!/usr/bin/env node
/**
 * Summarise the latest official-source check batch.
 *
 * Reads `data/imports/official/latest.json` (written by check_official_sources.js)
 * and classifies each result: ok / redirect / failed / blocked-by-WAF.
 *
 * A source that declares `requiresBrowser` and returns 412/403 is a *known
 * limit*, not a failure: those hosts reject non-browser clients at the CDN and
 * the check script is not meant to defeat that.
 */
const fs = require('fs');
const path = require('path');
const { officialDir } = require('../src/store/batches');

const isKnownLimit = (r) => r.requiresBrowser && (r.status === 412 || r.status === 403);
const isOk = (r) => r.status >= 200 && r.status < 300;
const isRedirect = (r) => r.status >= 300 && r.status < 400;
const isFailure = (r) => (r.status === 0 || r.status >= 500) && !isKnownLimit(r);

function main() {
  const dir = officialDir();
  const pointerFile = path.join(dir, 'latest.json');

  if (!fs.existsSync(pointerFile)) {
    throw new Error('no official source check result; run: npm run sources:check');
  }

  const latest = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  const batchFile = path.join(dir, latest.file);
  if (!fs.existsSync(batchFile)) {
    throw new Error(`latest.json points at missing batch ${latest.file}`);
  }

  const results = JSON.parse(fs.readFileSync(batchFile, 'utf8')).results || [];

  const report = {
    checked: results.length,
    ok: results.filter(isOk).length,
    redirects: results.filter(isRedirect).length,
    failed: results.filter(isFailure).length,
    knownLimits: results.filter(isKnownLimit).map((r) => ({ name: r.name, status: r.status, reason: r.note })),
    failures: results.filter(isFailure).map((r) => ({ name: r.name, url: r.url, error: r.error, status: r.status })),
  };

  console.log(JSON.stringify(report, null, 2));

  // Only real failures fail the run; a redirect is reported but not fatal.
  process.exitCode = report.failed ? 1 : 0;
}

main();
