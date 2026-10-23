#!/usr/bin/env node
/**
 * Probe every enabled official source and record what came back.
 *
 * Writes a batch of {name, url, status, bytes, finalUrl} plus a `latest.json`
 * pointer that `validate_official_check.js` reads. A failing source is recorded,
 * not fatal: the point of this script is to see which sources are down today.
 */
const fs = require('fs');
const path = require('path');
const { fetchText } = require('../src/net/http');
const { officialDir, batchStamp } = require('../src/store/batches');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'data', 'sources', 'official.json');

/** Statuses that mean "blocked by a WAF", not "the server is broken". */
const KNOWN_LIMITS = new Set([412, 403]);

async function probe(source) {
  try {
    const res = await fetchText(source.url);
    return {
      ...source,
      checkedAt: null,
      status: res.status,
      bytes: res.body.length,
      finalUrl: res.finalUrl,
      viaHttpFallback: false,
    };
  } catch (e) {
    // Some government hosts reject TLS at the WAF (e.g. SSL alert 40). When the
    // source declares a plain-HTTP fallback, use it rather than reporting a
    // failure that says nothing about the site's health.
    if (source.httpUrl) {
      try {
        const res = await fetchText(source.httpUrl);
        return {
          ...source,
          checkedAt: null,
          status: res.status,
          bytes: res.body.length,
          finalUrl: res.finalUrl,
          viaHttpFallback: true,
        };
      } catch (e2) {
        return { ...source, checkedAt: null, status: 0, error: e2.message };
      }
    }
    return { ...source, checkedAt: null, status: 0, error: e.message };
  }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const fetchedAt = new Date().toISOString();
  const out = officialDir(ROOT);

  const results = [];
  for (const source of config.sources.filter((x) => x.enabled)) {
    const r = await probe(source);
    r.checkedAt = fetchedAt;
    results.push(r);

    if (r.status === 0) {
      console.error('FAIL', source.name, r.error);
    } else {
      console.log(r.status, source.name, r.viaHttpFallback ? '(http fallback)' : '');
    }
  }

  const outFile = path.join(out, `${batchStamp()}.json`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ sourceConfig: CONFIG, fetchedAt, results }, null, 2) + '\n');
  fs.writeFileSync(
    path.join(out, 'latest.json'),
    JSON.stringify({ batch: path.basename(outFile, '.json'), file: path.basename(outFile), count: results.length }, null, 2) + '\n',
  );

  const blocked = results.filter((r) => KNOWN_LIMITS.has(r.status)).length;
  const failed = results.filter((r) => r.status === 0 || r.status >= 500).length;
  console.log(`checked ${results.length}; blocked-by-WAF ${blocked}; failed ${failed}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
