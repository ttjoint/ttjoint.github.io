'use strict';
/**
 * Stable entity keys derived from a source URL.
 *
 * ## Why not the name
 *
 * Every importer used to key its records by `sha256(name)`. That is the design
 * bug this module exists to avoid: 張偉 is not one person, and a name is not a
 * key. Two scrapers pulling 張偉 from two ministries would collide into one
 * entity, and a corrected name (a typo fixed, a courtesy name preferred) would
 * mint a second node with no way to reunite it with its edges.
 *
 * ## What we use instead
 *
 * A URL, reduced to its stable part. Government and news sites embed an article
 * id, a content id, or a dated slug in the path, and those come from the
 * publisher — the source owns them and does not recycle them.
 *
 * The reduction is deliberately lossy in a *safe* direction: it keeps only
 * alphanumerics from the last few path segments, so a change to query strings,
 * tracking parameters, or a trailing slash does not change identity.
 *
 * When a URL carries nothing usable (a bare directory, a fragment), we fall back
 * to a hash of the whole URL. Still name-independent, still stable, and honest
 * about the fact that the only thing we know is "it came from this page".
 */

const crypto = require('crypto');
const { entityId } = require('./entity_id');

/**
 * Derive an opaque key from a URL.
 *
 * @param {string} url
 * @returns {string} e.g. `gov-7914539`, `url-3f2a9c81`
 */
function keyFromUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return 'url-' + sha(String(url), 12);
  }

  const path = u.pathname.replace(/\/+$/, '');
  const segs = path.split('/').filter(Boolean);

  const isDateish = (s) =>
    (s.length === 4 && Number(s) >= 1900 && Number(s) <= 2100) ||
    (s.length === 6 && /^(19|20)\d{4}$/.test(s)) ||
    (s.length === 8 && /^(19|20)\d{6}$/.test(s));
  const digitsIn = (text) => (text.match(/\d{3,}/g) || []).filter((s) => !isDateish(s));

  // Most specific first: the filename carries the article id on most CMSes,
  // so look there before scanning the directory names. `/c30834/t20230312_17900.html`
  // has three candidates (`30834`, `20230312`, `17900`); only the last is the
  // article, and only the filename has it.
  const lastSeg = segs[segs.length - 1] || '';
  const fromLast = digitsIn(lastSeg).sort((a, b) => b.length - a.length);
  if (fromLast.length) return fromLast[0];

  // Then the directory names, again taking the longest plausible run.
  const fromPath = digitsIn(segs.slice(0, -1).join('/')).sort((a, b) => b.length - a.length);
  if (fromPath.length) return fromPath[0];

  // Otherwise: the last meaningful segment, alphanumerics only.
  const meaningful = segs.filter((s) => !/^(index|default|main|list)\.\w+$/i.test(s));
  const tail = meaningful[meaningful.length - 1] || '';
  const cleaned = tail.replace(/\.(s?html?|jsp|php|aspx?)$/i, '').replace(/[^0-9a-z]/gi, '');
  if (cleaned.length >= 4) return cleaned.slice(0, 40).toLowerCase();

  // Nothing usable: the URL itself is the key, hashed and prefixed so the
  // shape stays readable in a shard file.
  return 'url-' + sha(String(url), 12);
}

function sha(text, width) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, width);
}

/**
 * Person id from a profile URL.
 * @param {string} url
 */
const personKeyFromUrl = (url) => `src-${keyFromUrl(url)}`;

/**
 * Organisation id from an official directory page URL.
 * @param {string} url
 */
const orgKeyFromUrl = (url) => `src-${keyFromUrl(url)}`;

module.exports = { keyFromUrl, personKeyFromUrl, orgKeyFromUrl, entityId };
