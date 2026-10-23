'use strict';
/**
 * Allocator for entities that have no external source key.
 *
 * ## Why a persistent counter
 *
 * Most entities can be keyed by something outside this repo: a CBDB `c_personid`,
 * a 人民网 article id, an official page slug. Those keys are stable because the
 * source owns them.
 *
 * The rest — a manually seeded organisation, a hand-entered event, an evidence
 * record whose carrier and date are unknown — have no such key. The previous
 * scheme fell back to hashing the name, which is the bug this whole refactor
 * removes. The remaining honest option is to *allocate* an identifier and
 * remember it.
 *
 * The counter lives in `data/.id_seq.json` next to the shards, because that file
 * is the authoritative store: if the counter were derived from "highest id in
 * use", deleting the newest entity would make its id get reissued to a different
 * one, and every edge that pointed at the deleted node would silently attach to
 * the newcomer.
 *
 * ## Why not random uuids
 *
 * Randomness works, but it makes the corpus harder to eyeball: `local-000042`
 * sorts, diffs, and reads like an index, while `local-7f3a9c` is noise. It also
 * makes "how many locally keyed entities exist" answerable at a glance.
 *
 * ## Collision safety
 *
 * `allocate` never returns a key already present in the shard store, even if the
 * saved counter has drifted (a restored backup, a stitched-together dataset). The
 * counter is a fast path, not the source of truth.
 */

const fs = require('fs');
const path = require('path');

let dataRoot = path.resolve(__dirname, '..', '..', 'data');

function setDataRoot(dir) {
  dataRoot = dir;
}

const seqFile = () => path.join(dataRoot, '.id_seq.json');

function readSeq() {
  try {
    return JSON.parse(fs.readFileSync(seqFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSeq(seq) {
  fs.mkdirSync(path.dirname(seqFile()), { recursive: true });
  fs.writeFileSync(seqFile(), JSON.stringify(seq, null, 2) + '\n', 'utf8');
}

/**
 * Allocate the next local key for a type.
 *
 * @param {string} type
 * @param {(key: string) => boolean} [isTaken]  extra collision check (e.g. shard exists)
 * @returns {string} e.g. `000042`
 */
function allocateKey(type, isTaken) {
  const seq = readSeq();
  let n = Number(seq[type] || 0);
  let key;
  do {
    n += 1;
    key = String(n).padStart(6, '0');
  } while (isTaken && isTaken(key));
  seq[type] = n;
  writeSeq(seq);
  return key;
}

/** Peek without allocating — used by audits and dry runs. */
function peekSeq(type) {
  return Number(readSeq()[type] || 0);
}

module.exports = { allocateKey, peekSeq, setDataRoot, seqFile };
