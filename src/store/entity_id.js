'use strict';
/**
 * Entity ids: opaque, stable, and independent of the entity's name.
 *
 * ## Why the name must not be in the id
 *
 * The previous scheme was `type:sha256(type + '\0' + name).slice(0, 20)`. It
 * looked principled — one id per (type, name), no coordination needed — but it
 * made a *display label* into a *primary key*, and every symptom below follows
 * from that one mistake:
 *
 *   - Two people named 韓氏 (there are nine) hash to the same id, so the code
 *     that generated ids learned to append a counter: `韓氏（3）`. The counter is
 *     pure noise — it says nothing about which 韓氏 this is.
 *
 *   - The same collision was patched a second time, in the opposite direction,
 *     by folding the distinguishing fact into the name: `韓氏(田通妻)`. Now the
 *     name contains a relation. Searching "韓氏" no longer finds her, and the
 *     relation exists twice — once as a string in the name, once as a `spouse`
 *     edge — with no guarantee they agree.
 *
 *   - CBDB person 20209 and the same person re-imported end up as `劉環雋` and
 *     `劉環雋（1）`: same source row, two nodes, because the id was derived from
 *     a name that the importer had changed to avoid a collision.
 *
 *   - 關羽 appears twice in CBDB (467817, 497161), both without dates. A name-
 *     derived id cannot tell them apart, so they collapse — and no amount of
 *     disambiguating the *name* helps, because the distinguishing information
 *     was never in the name to begin with.
 *
 * A person's identity is not their name. Two people can share one, one person
 * can have several (courtesy name, temple name, alias), and a name can be
 * entirely unknown — CBDB records thousands of people whose name is only 某.
 * The id must be able to say "this is the person in row 467817" independently of
 * what they were called.
 *
 * ## The scheme
 *
 * Ids are `type:origin-key`, where the key names where the entity came from:
 *
 *     person:cbdb-467817            the CBDB row with c_personid 467817
 *     person:cpc-c64036-32641903    a 人民网 profile, keyed by its article id
 *     organization:local-000042     no external source; a locally allocated slot
 *     evidence:local-000118
 *
 * The key is opaque to the rest of the system: nothing parses it, nothing derives
 * meaning from its digits. It exists so that re-running an importer lands on the
 * same node, and so that a human reading a shard can see where the record came
 * from.
 *
 * ## Consequences for names
 *
 * `name` becomes an ordinary field: repeatable, mutable, possibly empty. Nine
 * entities may all be named 韓氏; they are distinguished by their edges
 * (`spouse → 田通` vs `spouse → 范澄`), which is exactly the information that
 * the name-based scheme was trying to smuggle into the name.
 *
 * `findByName` is therefore a *search* helper, never an identity check.
 */

/**
 * Base entity types, in one place so every layer agrees.
 *
 * The system has four base entity types plus evidence:
 *
 *   person        a human being
 *   thing         a non-person entity: a newspaper, a book, a treaty, a law
 *   organization  an organisation *or a state*: 东汉, 人民日报社, 黄巾军
 *   event         something that happened: 阪泉之战, 女娲造人
 *   evidence      a record of something: "人民日报 1978-05-11 ..."
 *
 * Organisations and states deliberately share one type. A dynasty differs from a
 * newspaper publisher in its `props['类型']`, not in its node type; giving
 * polities their own type would fork "东汉" from "汉朝" for no analytic gain.
 *
 * Evidence is a node, not a field on a node, because a record has its own
 * identity, its own carrier (which must itself be an entity), and is referenced
 * by many assertions. See docs/实体类型重构.md.
 */
const BASE_TYPES = Object.freeze(['person', 'thing', 'organization', 'event']);

/** Entity types that have their own id namespace. */
const TYPES = Object.freeze([...BASE_TYPES, 'evidence']);

/** Width of the id digest, in hex characters. Kept for the legacy audit only. */
const ID_WIDTH = 20;

/**
 * Build an id from a type and an opaque origin key.
 *
 * @param {string} type  'person' | 'thing' | 'organization' | 'event' | 'evidence'
 * @param {string} key   e.g. `cbdb-467817`, `local-000042`
 * @returns {string}     e.g. `person:cbdb-467817`
 */
function entityId(type, key) {
  if (!TYPES.includes(type)) {
    throw new Error(`entityId: unknown type "${type}" (expected one of ${TYPES.join(', ')})`);
  }
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('entityId: key must be a non-empty string');
  }
  // No silent normalisation. The old constructor stripped whitespace so that
  // "習 近平" and "習平" would not fork — but that was papering over a *name*
  // problem, and doing it to a key would mean a typo'd key silently resolved to
  // an existing entity. A key is machine-generated: reject anything odd.
  const clean = key.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(clean)) {
    throw new Error(`entityId: key "${key}" must be alphanumeric with . _ - only`);
  }
  return `${type}:${clean}`;
}

/**
 * Split an id into its type and origin key.
 * @returns {{type: string, key: string}|null}
 */
function parseId(id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  if (i <= 0) return null;
  const type = id.slice(0, i);
  const key = id.slice(i + 1);
  if (!TYPES.includes(type) || !key) return null;
  return { type, key };
}

/**
 * Id for a CBDB person. The key is `c_personid`, which is CBDB's own stable key
 * and the only thing that distinguishes two rows named 關羽.
 */
const cbdbPersonId = (cPersonId) => entityId('person', `cbdb-${String(cPersonId).replace(/\D/g, '')}`);

/** Id for a CBDB institution (`c_inst_code`). */
const cbdbOrgId = (instCode) => entityId('organization', `cbdb-${String(instCode).replace(/\D/g, '')}`);

/** Id for a CBDB event (`c_event_code`). */
const cbdbEventId = (eventCode) => entityId('event', `cbdb-${String(eventCode).replace(/\D/g, '')}`);

/**
 * Id for an entity that has no external source.
 *
 * The caller must supply a key that is stable for that entity — an article id, a
 * URL slug, or a slot from the local allocator. Never a name, never a hash of a
 * name: a rename must not change identity.
 */
const localId = (type, key) => entityId(type, `local-${key}`);

/**
 * Legacy: the old name-derived id. Kept ONLY so that `migrate_opaque_ids.js` can
 * recognise existing shards. Nothing in the read or write path may call this —
 * it is the bug, preserved deliberately so the migration can be checked.
 */
function legacyNameId(type, name) {
  const crypto = require('crypto');
  if (!TYPES.includes(type)) throw new Error(`legacyNameId: unknown type "${type}"`);
  if (typeof name !== 'string' || !name.trim()) throw new Error('legacyNameId: name required');
  const normalised = name.replace(/\s+/g, ' ').trim();
  const digest = crypto.createHash('sha256').update(`${type}\0${normalised}`).digest('hex');
  return `${type}:${digest.slice(0, ID_WIDTH)}`;
}

/**
 * True when `id` was produced by this module (any type, any key).
 *
 * Replaces the old "looks like sha256 hex" test, which only ever verified that an
 * id *looked* canonical and said nothing about whether it identified anything.
 */
function isCanonicalId(id) {
  const parsed = parseId(id);
  return Boolean(parsed) && /^([a-z]+-[0-9.]+|[a-z]+-[^/]+)$/i.test(parsed.key);
}

/** True when `id` is a locally allocated (no external source) id. */
function isLocalId(id) {
  return /^[a-z]+:local-/.test(String(id || ''));
}

/** True when `id` came from CBDB. */
function isCbdbId(id) {
  return /^[a-z]+:cbdb-/.test(String(id || ''));
}

/**
 * Legacy compatibility shims.
 *
 * These used to derive an id from a name. They now throw, because silently
 * keeping them would let new code re-introduce the bug: a caller passing a name
 * would get a plausible-looking id that collides with every namesake.
 *
 * Callers must choose an origin-specific constructor (`cbdbPersonId`, `localId`)
 * instead, which forces them to answer "where did this entity come from".
 */
const removedByDesign = (fn) =>
  function () {
    throw new Error(
      `${fn}() was removed: ids must not be derived from names. ` +
        'Use cbdbPersonId() / localId() / a source-specific constructor instead.',
    );
  };

module.exports = {
  BASE_TYPES,
  TYPES,
  ID_WIDTH,
  entityId,
  parseId,
  cbdbPersonId,
  cbdbOrgId,
  cbdbEventId,
  localId,
  legacyNameId,
  isCanonicalId,
  isLocalId,
  isCbdbId,
  // Removed on purpose — see `removedByDesign`.
  personId: removedByDesign('personId'),
  thingId: removedByDesign('thingId'),
  organizationId: removedByDesign('organizationId'),
  eventId: removedByDesign('eventId'),
  evidenceId: removedByDesign('evidenceId'),
  isCanonicalIdFor: removedByDesign('isCanonicalIdFor'),
};
