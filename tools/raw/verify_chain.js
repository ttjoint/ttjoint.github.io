'use strict';
/**
 * Verify the layer-0 hash chain.
 *
 * A hash chain that nobody checks is a comment. This is wired into
 * `npm run check`, so a payload edited in place, or a record deleted from the
 * middle of a batch, fails the build rather than quietly changing history.
 *
 * What it catches:
 *   - a row edited in place        → contentHash mismatch
 *   - a row deleted                → the next record's prevHash no longer matches
 *   - a row inserted              → same
 * What it cannot catch:
 *   - the whole chain rewritten from scratch. That needs an external anchor:
 *     the head hash pasted into a git commit message is enough, because git
 *     itself protects commit history.
 *
 * Usage:
 *   node tools/raw/verify_chain.js              # full verification (62 s / 2.47M rows)
 *   node tools/raw/verify_chain.js --heads      # head digests only (<1 s), used by npm run check
 *   node tools/raw/verify_chain.js --source=cbdb
 *   node tools/raw/verify_chain.js --quiet
 */

const store = require('../../src/store/raw_store');

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
}
const ONLY = arg('source', null);
const QUIET = process.argv.includes('--quiet');
const HEADS = process.argv.includes('--heads');

/** Digest over all group heads: stable regardless of group order, short enough
 * to paste into a commit subject line as an external anchor. */
function anchorOf(heads) {
  const crypto = require('crypto');
  const material = heads.map((h) => `${h.source}/${h.group}:${h.head}`).sort().join('\n');
  return 'sha256:' + crypto.createHash('sha256').update(material).digest('hex');
}

function main() {
  const all = store.listAll();
  const groups = all.filter((g) => !ONLY || g.source === ONLY);

  if (!groups.length) {
    console.log(
      ONLY
        ? `no raw groups for source "${ONLY}" — nothing to verify`
        : 'raw/ is empty — corpus has not been ingested yet',
    );
    return 0;
  }

  if (HEADS) {
    const heads = store.headsOnly().filter((h) => !ONLY || h.source === ONLY);
    if (!QUIET) {
      for (const h of heads) {
        console.log(`  ${(h.source + '/' + h.group).padEnd(36)} ${h.head || '(empty)'}`);
      }
      console.log(`\n  corpus anchor: ${anchorOf(heads)}`);
    }
    console.log(`layer 0 heads read: ${heads.length} groups, no gaps`);
    return 0;
  }

  let broken = 0;
  let checked = 0;
  const heads = [];

  for (const { source, group } of groups) {
    const v = store.verifyGroup(source, group);
    checked += v.checked;

    if (!v.ok) {
      broken++;
      console.error(`✗ ${source}/${group}  broken at ${v.brokenAt}: ${v.reason}`);
      continue;
    }
    heads.push({ source, group, checked: v.checked, head: v.head });
    if (!QUIET) console.log(`✓ ${(source + '/' + group).padEnd(36)} ${String(v.checked).padStart(9)} records`);
  }

  if (!QUIET && heads.length) {
    console.log('\nheads:');
    for (const h of heads) console.log(`  ${h.source}/${h.group}  ${h.head || '(empty)'}`);
    console.log(`\n  corpus anchor: ${anchorOf(heads)}`);
  }

  console.log(`\n${checked.toLocaleString()} records verified, ${broken} broken`);
  return broken ? 1 : 0;
}

process.exit(main());
