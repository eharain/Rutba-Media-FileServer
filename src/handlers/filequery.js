'use strict';

/**
 * One filter builder, used by both `GET /_api/files` and the bulk job.
 *
 * They MUST agree: "select all matching this filter, then tag them" is a promise
 * that the set the user previewed is the set that gets tagged. Two independent
 * WHERE-clause builders drift, and the drift shows up as a bulk operation quietly
 * touching the wrong assets.
 *
 * Returns `{ clause, args }` for splicing after `FROM files`. Every value is bound,
 * never interpolated.
 */

function buildFileFilter(get) {
  const where = [];
  const args = [];
  const val = (k) => {
    const v = get(k);
    return v == null || v === '' ? null : String(v);
  };

  const status = (val('status') || 'active').toLowerCase();
  if (status !== 'all') {
    where.push('status = ?');
    args.push(['trashed', 'missing', 'active'].includes(status) ? status : 'active');
  }

  const q = val('q');
  if (q) { where.push('(path LIKE ? OR name LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }

  const type = val('type');
  if (type) { where.push('mime LIKE ?'); args.push(`${type}%`); }

  const visibility = val('visibility');
  if (visibility) { where.push('visibility = ?'); args.push(visibility === 'private' ? 'private' : 'public'); }

  const tag = val('tag');
  if (tag) {
    where.push('id IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name = ?)');
    args.push(tag);
  }

  const collection = val('collection');
  if (collection) {
    // Accept an id or a name, because a saved search reads better with the name and
    // the console has the id to hand.
    if (/^\d+$/.test(collection)) {
      where.push('id IN (SELECT cf.file_id FROM collection_files cf WHERE cf.collection_id = ?)');
      args.push(Number(collection));
    } else {
      where.push('id IN (SELECT cf.file_id FROM collection_files cf JOIN collections c ON c.id = cf.collection_id WHERE c.name = ?)');
      args.push(collection);
    }
  }

  // Folder scope: the prefix, plus everything under it.
  //
  // `folder_mode=direct` narrows that to the folder's IMMEDIATE children — what a
  // folder-by-folder browser lists, as opposed to the whole subtree a bulk action
  // wants. Absent (or `under`) keeps the original subtree meaning, so every existing
  // caller is untouched.
  //
  // The prefix is escaped before it goes into LIKE. `q` is a search, where a loose
  // match is merely generous, but a folder is STRUCTURE: unescaped, a directory
  // called `my_videos` also matches `myXvideos/...`, and this same clause decides
  // which files a bulk tag or delete touches. The escape character is declared
  // explicitly rather than relying on the backslash default, which `sql_mode`
  // NO_BACKSLASH_ESCAPES turns off.
  const folder = val('folder');
  if (folder) {
    const clean = likePrefix(folder.replace(/^\/+|\/+$/g, ''));
    if ((val('folder_mode') || 'under') === 'direct') {
      where.push("(path LIKE ? ESCAPE '!' AND path NOT LIKE ? ESCAPE '!')");
      args.push(`${clean}/%`, `${clean}/%/%`);
    } else {
      where.push("(path LIKE ? ESCAPE '!')");
      args.push(`${clean}/%`);
    }
  }

  const volume = val('volume');
  if (volume) { where.push('volume_id = ?'); args.push(volume); }

  const owner = val('owner');
  if (owner) {
    if (owner === 'none') where.push('owner_user_id IS NULL');
    else { where.push('owner_user_id = ?'); args.push(Number(owner)); }
  }

  const minSize = val('min_size');
  if (minSize) { where.push('size_bytes >= ?'); args.push(Number(minSize)); }
  const maxSize = val('max_size');
  if (maxSize) { where.push('size_bytes <= ?'); args.push(Number(maxSize)); }

  const since = val('since');
  if (since) { where.push('updated_at >= ?'); args.push(since); }

  // Upload-date window. Deliberately created_at, and deliberately NOT folded into
  // `since` above: "changed since" and "uploaded between" are different questions,
  // and a gallery asking the second must not be answered with the first — a file
  // re-tagged today did not arrive today.
  const createdAfter = val('created_after');
  if (createdAfter) { where.push('created_at >= ?'); args.push(createdAfter); }
  const createdBefore = val('created_before');
  if (createdBefore) { where.push('created_at <= ?'); args.push(createdBefore); }

  // Custom metadata: `field:<key>=<value>`, exact match on the text projection every
  // value type also writes, so one syntax works for all of them.
  const fieldKey = val('field');
  const fieldValue = val('field_value');
  if (fieldKey) {
    if (fieldValue) {
      where.push(`id IN (SELECT v.file_id FROM file_field_values v JOIN metadata_fields m ON m.id = v.field_id
                          WHERE m.field_key = ? AND v.value_text = ?)`);
      args.push(fieldKey, fieldValue);
    } else {
      // No value given ⇒ "has this field set at all".
      where.push(`id IN (SELECT v.file_id FROM file_field_values v JOIN metadata_fields m ON m.id = v.field_id
                          WHERE m.field_key = ?)`);
      args.push(fieldKey);
    }
  }

  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

// Neutralize the LIKE wildcards in a literal prefix. `!` is the escape character
// declared by the clauses above; it must be escaped first or it would escape the
// escapes this function just added.
function likePrefix(s) {
  return String(s).replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

// Convenience wrappers for the two shapes callers actually have.
const fromSearchParams = (params) => buildFileFilter((k) => params.get(k));
const fromObject = (obj) => buildFileFilter((k) => (obj && obj[k] != null ? obj[k] : null));

module.exports = { buildFileFilter, fromSearchParams, fromObject, likePrefix };
