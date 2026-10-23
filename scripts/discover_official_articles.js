#!/usr/bin/env node
/**
 * Discover appointment/news article links from a configured government source.
 *
 * Usage: node scripts/discover_official_articles.js [--source=source:gov:cabinet]
 *
 * Articles are unfiltered text matches on appointment vocabulary; a human
 * reviews them before `status` becomes `approved`.
 */
const fs = require('fs');
const path = require('path');
const { fetchOk, extractLinks } = require('../src/net/http');
const { writeBatch } = require('../src/store/batches');

const ROOT = path.join(__dirname, '..');
const SOURCES_FILE = path.join(ROOT, 'data', 'sources', 'official.json');

/** Link text that suggests an appointment or personnel article. */
const RELEVANT_TEXT = /任免|任职|免职|国务院|领导|人事|部长|主任|局长/;

const DEFAULT_SOURCE = 'source:gov:cabinet';

async function main() {
  const arg = process.argv.find((x) => x.startsWith('--source='));
  const key = arg ? arg.split('=')[1] : DEFAULT_SOURCE;

  const { sources } = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  const source = sources.find((s) => s.id === key);
  if (!source) throw new Error(`unknown source ${key}`);

  const { body } = await fetchOk(source.url);

  const articles = extractLinks(body, source.url)
    .filter(({ text }) => RELEVANT_TEXT.test(text))
    .map(({ text, url }) => ({
      title: text,
      url,
      sourceId: source.id,
      status: 'unreviewed',
    }));

  const file = writeBatch('articles-', {
    source,
    discoveredAt: new Date().toISOString(),
    count: articles.length,
    articles,
  });

  console.log(`discovered ${articles.length} candidate articles from ${source.name} -> ${path.basename(file)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
