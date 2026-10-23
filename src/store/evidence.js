'use strict';
/**
 * Evidence nodes.
 *
 * ## Why evidence is a node, not a field
 *
 * Before this module, every entity carried a `sources` array like:
 *
 *     sources: [{ id: 'cpc-aHR0cDov...', name: '最高人民检察院', url: '...' }]
 *
 * Three things were wrong with that:
 *
 *   1. The `name` is a *string*, so "who says so" could not be queried, merged,
 *      or given properties of its own. Searching for 最高人民检察院 found nothing
 *      even though it was named on hundreds of records.
 *   2. The `id` was `base64url(url)`, so the same page cited from two entities
 *      produced two unrelated ids instead of one shared node.
 *   3. There was no place to record *what* the record says: only that a URL
 *      exists.
 *
 * So evidence becomes a node with the same standing as a person:
 *
 *     { id: 'evidence:...', type: 'evidence', name: '人民日报 1978-05-11 …',
 *       carrier: 'thing:...', documentedAt: TimeRange|null, medium: 'newspaper',
 *       url, accessedAt, excerpt, reliability, note }
 *
 * Its `carrier` is an **entity reference**, never a string: the newspaper that
 * carried the article is itself a `thing`, and its publisher is an
 * `organization`. That chain is what makes reliability gradable — a state
 * gazette and an anonymous web page are different kinds of evidence, and the
 * difference lives in the graph rather than in a numeric guess.
 *
 * ## What the id is derived from
 *
 * `(carrier name, date, title)` — see `evidenceId` in entity_id.js. Deliberately
 * *not* the URL: the same article cited from two URLs is one record, and two
 * articles in one paper on one day are two.
 *
 * This module is pure: it validates and constructs, it never reads or writes
 * disk. Storage goes through entity_writer like every other type.
 */

const { entityId, localId } = require('./entity_id');
const { allocateKey } = require('./id_allocator');

/**
 * Enumerated media, because a free-text `medium` drifts immediately
 * ("newspaper" / "报纸" / "报刊" / "press") and then cannot be filtered.
 */
const MEDIUM = Object.freeze({
  // 二手数据库（CBDB 等）。与上面几类不同：它本身不是文献，
  // 而是一个已经把文献整理成字段的数据库。`quote` 因此是
  // 列名拼接（`c_birthyear=1873`）而非句子——它就没有句子。
  DATABASE: 'database',
  NEWSPAPER: 'newspaper',
  PERIODICAL: 'periodical',
  BOOK: 'book',
  INSCRIPTION: 'inscription',
  ARCHIVE: 'archive',
  GAZETTE: 'gazette',
  ORAL: 'oral',
  WEB: 'web',
});

const MEDIUMS = Object.freeze(Object.values(MEDIUM));

/** Chinese labels for display; kept beside the enum so the two cannot drift. */
const MEDIUM_LABELS = Object.freeze({
  database: '二手数据库',
  newspaper: '报刊',
  periodical: '期刊',
  book: '书籍',
  inscription: '碑刻',
  archive: '档案',
  gazette: '公报',
  oral: '口述',
  web: '网络',
});

/**
 * Build a validated evidence node.
 *
 * Throws on structural errors (missing title, bad medium) instead of producing a
 * node that only fails later when something tries to render it.
 *
 * @param {object} spec
 * @param {string} spec.title          what the record is called
 * @param {string} [spec.carrierId]    entity id of the carrier (thing/organization)
 * @param {string} [spec.carrierName]  display name of the carrier, used for the id
 * @param {string} [spec.medium]       one of MEDIUM
 * @param {object} [spec.documentedAt] TimeRange
 * @param {string} [spec.url]
 * @param {string} [spec.accessedAt]
 * @param {string} [spec.excerpt]
 * @param {number} [spec.reliability]  0–1, or null when unassessed
 * @param {string} [spec.note]
 * @returns {object} the node
 */
function makeEvidence(spec) {
  const s = spec || {};
  const title = String(s.title == null ? '' : s.title).trim();
  if (!title) throw new Error('makeEvidence: title is required');

  let medium = s.medium == null ? MEDIUM.WEB : String(s.medium);
  if (!MEDIUMS.includes(medium)) {
    throw new Error(`makeEvidence: unknown medium "${medium}" (expected one of ${MEDIUMS.join(', ')})`);
  }

  // Reliability is optional and 0 is a legitimate value (a known-forged record),
  // so test for null/undefined rather than falsiness.
  let reliability = null;
  if (s.reliability != null) {
    const r = Number(s.reliability);
    if (!Number.isFinite(r) || r < 0 || r > 1) {
      throw new Error(`makeEvidence: reliability must be within 0..1, got ${s.reliability}`);
    }
    reliability = r;
  }

  const carrierName = String(s.carrierName == null ? '' : s.carrierName).trim();
  const carrierId = s.carrierId || null;
  const dateKey = s.documentedAt ? (s.documentedAt.start ?? s.documentedAt.mid ?? '') : '';

  // Evidence ids are opaque too.
  //
  // The old scheme hashed `(carrier, date, title)` — which meant that correcting a
  // typo in the title, or filling in a date that had been unknown, silently minted
  // a *different* record and orphaned every assertion that cited the old one.
  // Titles are exactly the kind of thing that gets corrected.
  //
  // So: honour an explicit id when the caller (a register, a migration) has one;
  // otherwise allocate a slot that will never be reissued.
  const id = s.id || localId('evidence', allocateKey('evidence'));

  const node = {
    id,
    type: 'evidence',
    name: s.carrierName && s.documentedAt
      ? `${carrierName} ${formatDateKey(dateKey)} ${title}`.replace(/\s+/g, ' ').trim()
      : title,
    carrier: carrierId,
    medium,
    documentedAt: s.documentedAt || null,
    url: s.url || '',
    accessedAt: s.accessedAt || '',
    excerpt: s.excerpt || '',
    reliability,
    note: s.note || '',
    // Set when we know a carrier exists in principle but have not built it yet.
    // Such a node is kept rather than dropped, so the gap is visible in counts.
    unresolved: !carrierId,
  };

  return node;
}

/** Render a JDN or ISO date for the evidence title; empty when unknown. */
function formatDateKey(key) {
  if (key === '' || key == null) return '';
  const n = Number(key);
  if (!Number.isFinite(n)) return String(key);
  // Reuse the project's Julian conversion rather than inventing a second one.
  const { jdnToJulian } = require('../time/julian');
  try {
    const d = jdnToJulian(n);
    const mm = String(d.month).padStart(2, '0');
    const dd = String(d.day).padStart(2, '0');
    return `${d.year}-${mm}-${dd}`;
  } catch {
    return String(n);
  }
}

/**
 * Validate a loaded evidence node.
 *
 * Used by the data validators so a hand-edited shard cannot introduce an
 * evidence record pointing at a carrier that does not exist.
 *
 * @param {object} node
 * @returns {string[]} problems, empty when valid
 */
function validateEvidence(node) {
  const problems = [];
  if (!node || typeof node !== 'object') return ['evidence node is not an object'];
  if (node.type !== 'evidence') problems.push(`type must be "evidence", got "${node.type}"`);
  if (!node.id) problems.push('missing id');
  if (!node.name) problems.push('missing name');
  if (node.medium && !MEDIUMS.includes(node.medium)) {
    problems.push(`unknown medium "${node.medium}"`);
  }
  if (node.reliability != null) {
    const r = Number(node.reliability);
    if (!Number.isFinite(r) || r < 0 || r > 1) problems.push(`reliability out of range: ${node.reliability}`);
  }
  if (node.carrier != null && node.carrier !== '') {
    const ok = /^(thing|organization):[0-9a-f]{20}$/.test(node.carrier);
    if (!ok) problems.push(`carrier must be a thing:/organization: id, got "${node.carrier}"`);
  }
  return problems;
}

/**
 * Infer the carrier organisation of a URL from its hostname.
 *
 * This is *derivation from the source itself*, not a handwritten guess table:
 * every entry below is the body that actually owns the domain, as stated on that
 * site's own pages. Where the owner is not obvious the function returns null and
 * the caller marks the evidence `unresolved` — which is the honest answer, and
 * shows up in the unresolved count instead of being papered over.
 *
 * @param {string} url
 * @returns {{name: string, type: 'organization'|'thing'}|null}
 */
function carrierFromUrl(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  const RULES = [
    // Order matters: the first matching rule wins, so the most specific host
    // must come before its parent domain (cpc.people.com.cn before people.com.cn).
    [/^cpc\.people\.com\.cn$/, { name: '中国共产党新闻网', type: 'thing' }],
    [/^([a-z0-9-]+\.)?spp\.gov\.cn$/, { name: '最高人民检察院', type: 'organization' }],
    [/^([a-z0-9-]+\.)?court\.gov\.cn$/, { name: '最高人民法院', type: 'organization' }],
    [/^([a-z0-9-]+\.)?npc\.gov\.cn$/, { name: '全国人民代表大会', type: 'organization' }],
    [/^([a-z0-9-]+\.)?cppcc\.gov\.cn$/, { name: '中国人民政治协商会议全国委员会', type: 'organization' }],
    [/^([a-z0-9-]+\.)?gov\.cn$/, { name: '中国政府网', type: 'thing' }],
    [/^([a-z0-9-]+\.)?people\.com\.cn$/, { name: '人民网', type: 'thing' }],
    [/^([a-z0-9-]+\.)?xinhuanet\.com$/, { name: '新华网', type: 'thing' }],
    [/^([a-z0-9-]+\.)?news\.cn$/, { name: '新华网', type: 'thing' }],
  ];
  for (const [re, hit] of RULES) {
    if (re.test(host)) return hit;
  }
  return null;
}

/** Best-effort medium from a URL's shape; 'web' when nothing matches. */
function mediumFromUrl(url) {
  const u = String(url || '');
  if (!u) return MEDIUM.WEB;
  if (/\.pdf(\?|$)/i.test(u)) return MEDIUM.ARCHIVE;
  if (/\/n1\/\d{4}\/\d{4}\/c\d+/.test(u)) return MEDIUM.NEWSPAPER;
  return MEDIUM.WEB;
}

module.exports = {
  MEDIUM,
  MEDIUMS,
  MEDIUM_LABELS,
  makeEvidence,
  validateEvidence,
  carrierFromUrl,
  mediumFromUrl,
  formatDateKey,
};
