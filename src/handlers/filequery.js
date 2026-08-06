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
  const folder = val('folder');
  if (folder) {
    const clean = folder.replace(/^\/+|\/+$/g, '');
    where.push('(path LIKE ? )');
    args.push(`${clean}/%`);
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

// Convenience wrappers for the two shapes callers actually have.
const fromSearchParams = (params) => buildFileFilter((k) => params.get(k));
const fromObject = (obj) => buildFileFilter((k) => (obj && obj[k] != null ? obj[k] : null));

module.exports = { buildFileFilter, fromSearchParams, fromObject };
