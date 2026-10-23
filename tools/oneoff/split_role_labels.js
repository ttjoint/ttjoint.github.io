'use strict';
/**
 * Split "organisation" labels that are really "org + post" into their two parts.
 *
 * ## The problem
 *
 * The structured extractor put the whole phrase in the `organization` field when
 * the source text said things like 中共二十届中央政治局委员. So eight people ended
 * up with `{ organization: '中共二十届中央政治局委员', role: undefined }`:
 *
 *   organization  中共二十届中央政治局委员   ← a *post*, not a body
 *   role          (empty)
 *
 * Left alone, an organisation entity named "…政治局委员" would be created, which
 * is simply wrong: 委员 is a designation, 政治局 is the body.
 *
 * ## The fix
 *
 * For each such label, strip a known post suffix into `role` and keep the rest as
 * the organisation. The suffix list is closed and ordered longest-first, so the
 * split is deterministic and reviewable — not a guess.
 *
 * Usage: node tools/oneoff/split_role_labels.js [--dry-run]
 */
const { readAll, upsertAll } = require('../../src/store/entity_writer');

const DRY = process.argv.includes('--dry-run');

/**
 * Post phrases, longest first, expanded to (body suffix, post).
 *
 * The left side is what the source text says; the right side is what it *means*.
 * Written out in full rather than assembled from parts because the colloquial
 * forms do not compose: 中央委员 abbreviates 中央委员会 + 委员, while
 * 中央政治局委员 is already complete. A rule that tried to derive one from the
 * other produced the nonsense body "中共二十届会".
 *
 *   [matched suffix, body suffix to append, post]
 */
const POST_SUFFIXES = [
  ['中央政治局常务委员会委员', '中央政治局常务委员会', '委员'],
  ['中央政治局委员', '中央政治局', '委员'],
  ['中央书记处书记', '中央书记处', '书记'],
  ['中央政治局常委', '中央政治局', '常委'],
  ['中央委员会委员', '', '委员'],
  // 中共二十届中央委员 = 中共二十届 + 中央委员会 + 委员
  ['中央委员', '中央委员会', '委员'],
  ['委员会委员', '', '委员'],
  ['委员', '', '委员'],
  ['常委', '', '常委'],
  ['书记', '', '书记'],
];

/**
 * Bodies that must never be split off, because the word ending looks like a post
 * but the whole word is the body: 国务委员 is a state councillor, not "委员 of
 * 国务". Listing them is less error-prone than trying to make the suffix rule
 * clever enough to infer it.
 */
const WHOLE_WORD_BODIES = new Set([
  '国务委员', '国务', '政协', '中央政治局', '中央书记处',
]);

/**
 * Split a label into { organization, role }.
 * Returns null when the label does not end with a known post suffix, or when
 * stripping it would leave nothing (a bare 委员 with no body).
 *
 * @param {string} label
 * @returns {{organization: string, role: string}|null}
 */
function splitPost(label) {
  if (typeof label !== 'string') return null;
  const text = label.trim();
  if (!text) return null;
  if (WHOLE_WORD_BODIES.has(text)) return null;
  for (const [suffix, bodySuffix, role] of POST_SUFFIXES) {
    if (text.length <= suffix.length) continue;
    if (!text.endsWith(suffix)) continue;
    const body = text.slice(0, text.length - suffix.length).trim();
    if (!body) continue;
    // A body that is itself a whole-word institution must not gain a suffix.
    if (WHOLE_WORD_BODIES.has(body)) return null;
    return { organization: body + bodySuffix, role };
  }
  return null;
}

/**
 * Entries whose `organization` is missing but whose `role` holds a body+post
 * phrase (e.g. role="中共二十届中央书记处书记").
 *
 * Deliberately narrow. A bare post like "首席大法官" or "二级大检察官" has no
 * body in it, and inventing one would be worse than leaving the field empty. So
 * this only fires for phrases that name a body *and* a post, i.e. the split must
 * leave a body that reads like an organisation: it must contain 中央/届 and the
 * remainder must not itself be a bare post word.
 *
 * @param {string} role
 * @returns {{organization: string, role: string}|null}
 */
function splitRoleOnly(role) {
  if (typeof role !== 'string') return null;
  const text = role.trim();
  // Only body+post phrases of the 中共二十届中央… family are safe to split here.
  if (!/^中共.+届/.test(text)) return null;
  return splitPost(text);
}

function main() {
  const people = readAll('person');
  let touchedPeople = 0;
  const changed = [];

  for (const p of people) {
    const claims = p.claims;
    if (!claims) continue;
    let dirty = false;
    for (const key of ['currentPositions', 'career']) {
      const list = claims[key];
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (!c) continue;
        // Case 1: organisation holds a body+post phrase while role is empty.
        if (c.organization && !c.role) {
          const split = splitPost(c.organization);
          if (split) {
            c.organization = split.organization;
            c.role = split.role;
            dirty = true;
          }
          continue;
        }
        // Case 2: organisation is absent and the role holds the body+post phrase.
        if (!c.organization && c.role) {
          const split = splitRoleOnly(c.role);
          if (split) {
            c.organization = split.organization;
            c.role = split.role;
            dirty = true;
          }
        }
      }
    }
    if (dirty) {
      touchedPeople++;
      changed.push(p);
    }
  }

  console.log(`扫描 ${people.length} 人，需修正 ${touchedPeople} 人`);
  const sample = changed.slice(0, 10);
  for (const p of sample) {
    for (const c of [...(p.claims.currentPositions || []), ...(p.claims.career || [])]) {
      if (c && c.role) console.log(`  ${p.name}: organization="${c.organization}" role="${c.role}"`);
    }
  }
  if (changed.length > sample.length) console.log(`  … 其余 ${changed.length - sample.length} 人`);

  if (DRY) {
    console.log('\n--dry-run：未写入');
    return;
  }
  if (!changed.length) {
    console.log('无需写入');
    return;
  }
  const res = upsertAll('person', changed);
  console.log(`\n写入 ${res.written} 个分片`);
}

if (require.main === module) main();

module.exports = { splitPost, splitRoleOnly, POST_SUFFIXES };
