#!/usr/bin/env node
/**
 * Extract reviewed CPPCC leadership profile pages into person candidates.
 *
 * Stage 1 of the CPPCC pipeline: discover links only. The candidates are
 * unchecked — `verify_cppcc_profiles.js` determines which URLs are real resume
 * pages rather than section indexes.
 */
const { fetchOk, cleanHtml, extractLinks } = require('../src/net/http');
const { writeBatch } = require('../src/store/batches');
const { entityId } = require('../src/store/entity_id');
const { personKeyFromUrl } = require('../src/store/source_key');

const INDEX_URL = 'http://www.cppcc.gov.cn/zxld/';

/**
 * A leadership name is a short run of Chinese characters.
 *
 * The previous version only checked `name.length < 20`, which let navigation
 * text through. Restrict to a plausible name, but keep the length ceiling so
 * behaviour is a superset of what worked before.
 */
const NAME_RE = /^[\u4e00-\u9fff·]{2,19}$/;

/** Profile pages live under /zxld/; the index and section pages do not. */
const PROFILE_URL_RE = /\/zxld\//;

async function main() {
  const { body } = await fetchOk(INDEX_URL);

  const records = extractLinks(body, INDEX_URL)
    .filter(({ text, url }) => NAME_RE.test(text) && PROFILE_URL_RE.test(url))
    .map(({ text, url }) => ({
      // Keyed by the profile URL, not the name: 張偉 is not one person.
      id: entityId('person', personKeyFromUrl(url)),
      name: text,
      type: 'person',
      props: { 身份: '全国政协领导', 来源栏目: '中国政协网·政协领导' },
      aliases: [],
      relations: {},
      sources: [{
        id: 'source:cppcc',
        name: '中国政协网·政协领导',
        url,
        accessedAt: new Date().toISOString(),
        note: '目录抽取，待人工核验',
      }],
      external: { officialUrl: url, status: 'unreviewed' },
    }));

  const file = writeBatch('cppcc-leaders-', {
    source: INDEX_URL,
    discoveredAt: new Date().toISOString(),
    count: records.length,
    records,
  });

  console.log(`extracted ${records.length} CPPCC leader candidates -> ${require('path').basename(file)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
