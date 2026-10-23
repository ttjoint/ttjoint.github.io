'use strict';
/**
 * Convert the legacy `props['生卒']` prose string into the structured date props
 * the rest of the system actually reads.
 *
 * ## Why this exists
 *
 * `import_cbdb.js` used to emit only:
 *
 *     props['生卒'] = '0年 ~ 不详'
 *
 * while `graph_source.lifespanFromProps()` looks for `出生年月` / `逝世时间` and
 * nothing else. So **every one of the 7,120 persons had `lifespan === null`**, and
 * the three-tier timeline filter, the `index/chrono.json` bucket and every date
 * query silently operated on an empty set. Nothing threw; searches simply matched
 * nothing.
 *
 * The root cause was upstream and is fixed in the importer. This script repairs the
 * shards that were written before that fix, without re-reading the 584 MB CBDB
 * database — the information needed is already in the string.
 *
 * ## What the string cannot tell us
 *
 * `生卒` is lossy. `'0年 ~ 不详'` came from CBDB's `c_index_year = 0`, which is its
 * sentinel for "unknown" — not a year anyone lived in. And the importer rendered
 * it as `0年` rather than dropping it. Those are converted to *no date at all*
 * rather than being passed through, because a person pinned to the year 0 sorts to
 * the top of the timeline and reads as the earliest person in the corpus.
 *
 * A `生卒` of `'X年 ~ 不详'` also cannot say whether X is a birth year or merely an
 * activity year, so it becomes `出生年月` only when there is no death year to
 * confuse it with — the same rule the importer now applies.
 *
 * Usage: node tools/oneoff/migrate_lifespan_props.js [--dry-run]
 */

const { readAll, shardPath } = require('../../src/store/entity_writer');

const DRY_RUN = process.argv.includes('--dry-run');

/** CBDB's 0 means "unknown"; negative years are real and must survive. */
function realYear(text) {
  if (text == null) return null;
  const m = String(text).trim().match(/^(前)?(\d+)年?$/);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n === 0) return null;
  return m[1] ? -n : n;
}

function formatYear(n) {
  return n < 0 ? `前${Math.abs(n)}年` : `${n}年`;
}

/**
 * Split `'A年 ~ B年'` into { birth, death } structured props.
 * Returns `{}` when the string carries no usable date.
 */
function fromLifeSpanText(text) {
  const parts = String(text).split('~').map((s) => s.trim());
  const birth = realYear(parts[0]);
  const death = realYear(parts[1]);
  const props = {};
  if (birth != null && death == null) {
    // Only an activity/birth year survives, so label it as a birth only when that
    // is all we have — same rule as the importer.
    props['出生年月'] = formatYear(birth);
  } else if (birth != null && death != null) {
    props['出生年月'] = formatYear(birth);
    props['逝世时间'] = formatYear(death);
  } else if (birth == null && death != null) {
    // Death-only: never invent a birth year to fill the gap.
    props['逝世时间'] = formatYear(death);
  }
  return props;
}

function main() {
  const persons = readAll('person');
  let converted = 0;
  let dropped = 0;
  const report = [];

  for (const p of persons) {
    const props = p.props || {};
    const text = props['生卒'];
    if (!text) continue;

    const structured = fromLifeSpanText(text);
    // Never overwrite a real date that is already there (a re-import may have
    // filled these in).
    const merged = { ...structured };
    for (const k of ['出生年月', '逝世时间']) {
      if (props[k]) merged[k] = props[k];
    }

    const nextProps = { ...props };
    delete nextProps['生卒'];
    Object.assign(nextProps, merged);

    if (!Object.keys(merged).length) dropped++;

    if (report.length < 5) {
      report.push(`${p.name}: "${text}" -> ${JSON.stringify(merged)}`);
    }

    if (!DRY_RUN) {
      p.props = nextProps;
      require('fs').writeFileSync(shardPath('person', p.id), JSON.stringify(p, null, 2) + '\n', 'utf8');
    }
    converted++;
  }

  console.log(`处理带「生卒」字符串的人物: ${converted}`);
  console.log(`  其中无法解析出年份（0年/不详）: ${dropped}`);
  for (const line of report) console.log('  ' + line);
  if (DRY_RUN) console.log('[dry-run] 未写入');
}

if (require.main === module) main();

module.exports = { fromLifeSpanText, realYear };
