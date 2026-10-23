'use strict';
/**
 * Split relational qualifiers out of person names.
 *
 * ## The defect
 *
 * The CBDB import produces names like `阿魯渾氏(王結妻)` — a name with a kinship
 * annotation glued on. 49,106 persons carry one. This is the exact shape the project
 * forbids: a name string must be atomic, and a relation belongs on an edge, not
 * inside a display field.
 *
 * Three concrete harms:
 *   - **Search breaks.** Nobody types `阿魯渾氏(王結妻)`; they type `阿魯渾氏`.
 *   - **Identity is polluted.** The same woman under two marriages would be two names.
 *   - **The relation is hidden.** `王結妻` is a spouse edge that no query can see.
 *
 * ## What the qualifier can be
 *
 *   - 亲属关系: `曹卿母` (mother of 曹卿), `王結妻` (wife of 王結), `X女` (daughter)
 *   - 别名/称号: `始畢可汗`, `Pierre Ngai`
 *
 * A kinship qualifier ends in a role word and starts with a person's name. The name
 * prefix is looked up through the corpus; when it resolves to exactly one person, a
 * relation edge is written. When it does not, the qualifier is kept as an alias so no
 * information is destroyed — but the *name* is always cleaned.
 *
 * ## Never guess
 *
 * If `王結` matches two different people, no edge is written (ambiguous is worse than
 * absent, and the alias preserves the evidence). If the role word is unknown, the
 * qualifier becomes an alias. The cleaned name is written in every case: leaving it
 * dirty is the bug being fixed.
 *
 * Usage: node tools/oneoff/split_relational_names.js [--dry-run]
 */

const fs = require('fs');
const { readAll, shardPath } = require('../../src/store/entity_writer');

const DRY_RUN = process.argv.includes('--dry-run');

/** `名字(注记)` or `名字（注记）`, note at the end only. */
const NOTE_SUFFIX = /^(.*?)[（(]([^（()）]*)[）)]$/;

/**
 * Role words that can end a kinship qualifier, mapped to the predicate key the
 * registry uses. Order matters: 前母 / 後母 must be tested before 母.
 *
 * Keys must be English registry keys (see src/predicates/registry.js), never the
 * Chinese labels.
 */
const ROLE_SUFFIXES = [
  ['前母', 'stepMother'],
  ['後母', 'stepMother'],
  ['继母', 'stepMother'],
  ['繼母', 'stepMother'],
  ['母', 'mother'],
  ['父', 'father'],
  ['妻', 'wife'],
  ['妾', 'concubine'],
  ['女', 'daughter'],
  ['子', 'son'],
  ['弟', 'youngerSibling'],
  ['妹', 'youngerSibling'],
  ['兄', 'olderSibling'],
  ['姊', 'olderSibling'],
  ['姐', 'olderSibling'],
];

/** True when the note is a Latin-script name, i.e. an alias rather than a relation. */
function isLatinAlias(note) {
  return /^[\x20-\x7e]+$/.test(note) && /[A-Za-z]/.test(note);
}

/**
 * Parse a note into { role, name } when it is a kinship annotation.
 * `王結妻` -> { role: 'wife', name: '王結' }
 */
function parseKinship(note) {
  for (const [suffix, key] of ROLE_SUFFIXES) {
    if (!note.endsWith(suffix)) continue;
    const who = note.slice(0, -suffix.length).trim();
    // A bare role word (`妻`) says nothing about whose wife, so it is not a relation.
    if (!who) return null;
    return { role: key, name: who };
  }
  return null;
}

function main() {
  const persons = readAll('person');
  const withNote = persons.filter((e) => NOTE_SUFFIX.test(String(e.name || '')));
  console.log(`带括注的名字: ${withNote.length}`);

  // Name -> ids, for resolving the relative. Namesakes are common, so a name that
  // resolves to more than one person produces no edge.
  const byName = new Map();
  for (const e of persons) {
    const n = String(e.name || '');
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(e.id);
  }

  const stats = { renamed: 0, aliased: 0, edged: 0, ambiguous: 0, unresolved: 0, seqDeleted: 0 };
  const samples = [];

  for (const p of withNote) {
    const m = String(p.name).match(NOTE_SUFFIX);
    if (!m) continue;
    const base = m[1].trim();
    const note = m[2].trim();
    if (!base) continue;

    // A pure counter (`張長（1）`) is a collision marker with no information at all:
    // the id already distinguishes the people. Drop it outright.
    if (/^\d+$/.test(note)) {
      p.name = base;
      stats.seqDeleted++;
      stats.renamed++;
      if (!DRY_RUN) fs.writeFileSync(shardPath('person', p.id), JSON.stringify(p, null, 2) + '\n', 'utf8');
      continue;
    }

    p.name = base;
    p.aliases = p.aliases || [];
    const kinship = isLatinAlias(note) ? null : parseKinship(note);

    if (kinship) {
      const targets = byName.get(kinship.name) || [];
      // Never self-reference: `艾氏(艾氏妻)` would be nonsense.
      const ids = targets.filter((id) => id !== p.id);
      if (ids.length === 1) {
        const rel = ids[0];
        p.relations = p.relations || {};
        if (!p.relations[kinship.role]) p.relations[kinship.role] = [];
        const exists = p.relations[kinship.role].some(
          (r) => (typeof r === 'string' ? r : r.target) === rel,
        );
        if (!exists) p.relations[kinship.role].push(rel);
        // Keep the original qualifier as an alias so the record stays traceable to
        // how CBDB wrote it.
        if (!p.aliases.includes(note)) p.aliases.push(note);
        stats.edged++;
        stats.aliased++;
      } else if (ids.length > 1) {
        // Two people share that name — we cannot tell which one the note means.
        if (!p.aliases.includes(note)) p.aliases.push(note);
        stats.ambiguous++;
        stats.aliased++;
      } else {
        if (!p.aliases.includes(note)) p.aliases.push(note);
        stats.unresolved++;
        stats.aliased++;
      }
    } else {
      // Title, Latin name, or an unrecognised annotation: an alias, not a relation.
      if (!p.aliases.includes(note)) p.aliases.push(note);
      stats.aliased++;
    }

    if (samples.length < 6) {
      samples.push(`${m[0]} -> name="${base}" alias="${note}"${stats.edged ? '' : ''}`);
    }
    stats.renamed++;

    if (!DRY_RUN) {
      fs.writeFileSync(shardPath('person', p.id), JSON.stringify(p, null, 2) + '\n', 'utf8');
    }
  }

  console.log(`  改名: ${stats.renamed}`);
  console.log(`  其中纯序号（直接删除）: ${stats.seqDeleted}`);
  console.log(`  括注转别名: ${stats.aliased}`);
  console.log(`  建立亲属边: ${stats.edged}`);
  console.log(`  名字歧义未建边: ${stats.ambiguous}`);
  console.log(`  名字未找到: ${stats.unresolved}`);
  for (const s of samples) console.log('  ' + s);
  if (DRY_RUN) console.log('[dry-run] 未写入');
}

main();
