'use strict';
/**
 * The one place that maps an entity type to its directory name.
 *
 * This table used to be copy-pasted into nine files (entity_writer,
 * data_reader, build_index, check_manifests, graph_source, admin_server,
 * export_static, js/core/data_store, and the FOLDERS literal in entity_id).
 * Adding a fifth entity type meant finding all of them, and missing one produced
 * a silent partial import rather than an error.
 *
 * Now every layer imports from here. Tests assert that the on-disk directories
 * match this table, so a type that exists in code but not on disk (or the
 * reverse) fails loudly.
 */

/** type -> folder, e.g. `thing` -> `things`. */
const FOLDERS = Object.freeze({
  person: 'persons',
  thing: 'things',
  organization: 'organizations',
  event: 'events',
  evidence: 'evidence',
});

/** folder -> type, the inverse of FOLDERS. */
const TYPE_OF_FOLDER = Object.freeze(
  Object.fromEntries(Object.entries(FOLDERS).map(([type, folder]) => [folder, type])),
);

/** All folders, in a stable order (used by build and validation scripts). */
const ALL_FOLDERS = Object.freeze(Object.values(FOLDERS));

/** All types, in a stable order. */
const ALL_TYPES = Object.freeze(Object.keys(FOLDERS));

/**
 * Throwing lookup: an unknown type is a programming error, not a data problem.
 * @param {string} type
 * @returns {string} the folder name
 */
function folderOf(type) {
  const folder = FOLDERS[type];
  if (!folder) {
    throw new Error(`unknown entity type "${type}" (expected one of ${ALL_TYPES.join(', ')})`);
  }
  return folder;
}

/**
 * Throwing lookup in the other direction.
 * @param {string} folder
 * @returns {string} the type name
 */
function typeOfFolder(folder) {
  const type = TYPE_OF_FOLDER[folder];
  if (!type) {
    throw new Error(`unknown entity folder "${folder}" (expected one of ${ALL_FOLDERS.join(', ')})`);
  }
  return type;
}

module.exports = { FOLDERS, TYPE_OF_FOLDER, ALL_FOLDERS, ALL_TYPES, folderOf, typeOfFolder };
