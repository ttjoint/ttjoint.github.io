#!/usr/bin/env node
/**
 * Discover official organization links from the State Council directory.
 *
 * Writes a review batch; nothing here is enabled until a human flips `enabled`.
 */
const path = require('path');
const { fetchOk, cleanHtml, extractLinks } = require('../src/net/http');
const { writeBatch } = require('../src/store/batches');
const { entityId } = require('../src/store/entity_id');

const ROOT = path.join(__dirname, '..');
const INDEX_URL = 'https://www.gov.cn/gwyzzjg/index.htm';

/** Hosts that appear in the directory but are not organization sites. */
const EXCLUDED_HOSTS = /(beian\.miit\.gov\.cn|beian\.gov\.cn|weibo\.com)/;

/** Link text that indicates navigation chrome rather than an organization. */
const EXCLUDED_TEXT = /(备案|微博|京ICP备|京公网安备)/;

async function main() {
  const { body } = await fetchOk(INDEX_URL);

  const sources = extractLinks(body, INDEX_URL)
    .filter(({ text, url }) => {
      // Only external sites: www.gov.cn links are internal navigation.
      try {
        if (/www\.gov\.cn$/.test(new URL(url).hostname)) return false;
        if (EXCLUDED_HOSTS.test(url)) return false;
      } catch {
        return false;
      }
      return text && !EXCLUDED_TEXT.test(text);
    })
    .map(({ text, url }) => ({
      // Source-registry ids are their own namespace (not entities).
      id: 'source:govorg:' + require('crypto').createHash('sha1').update(url).digest('hex').slice(0, 12),
      name: text,
      url,
      kind: 'ministry-directory',
      priority: 'B',
      enabled: false,
    }));

  const file = writeBatch('gov-org-', {
    source: INDEX_URL,
    discoveredAt: new Date().toISOString(),
    count: sources.length,
    sources,
  });

  console.log(`discovered ${sources.length} external organization links -> ${path.basename(file)}`);
  for (const s of sources) console.log(s.name, s.url);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
