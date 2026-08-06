'use strict';

/**
 * Database schema for the accounts / RBAC / metadata / sharing / audit layer.
 *
 * Each entry is an idempotent `CREATE TABLE IF NOT EXISTS` (plus a few seed rows),
 * applied in order by `db.init()`. Adding a table here is the migration — existing
 * tables are never altered destructively. All tables use InnoDB + utf8mb4 so paths,
 * names and comments are full-Unicode and foreign keys work.
 *
 * The filesystem remains the source of truth for bytes; these tables are metadata
 * and access-control ONLY. A DB outage degrades features but never loses masters —
 * indexing writes are best-effort (see fileindex.js).
 *
 * Table map:
 *   roles / users / user_roles / sessions / api_tokens   — identity + RBAC
 *   folders / files / file_versions / tags / file_tags   — content metadata
 *   shares / comments                                     — collaboration
 *   audit_log                                             — security audit trail
 */

const STATEMENTS = [
  // ── Identity & access ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS roles (
     id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name          VARCHAR(64) NOT NULL,
     description   VARCHAR(255) NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_roles_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `INSERT IGNORE INTO roles (name, description) VALUES
     ('admin',  'Full administrative access'),
     ('editor', 'Upload, edit and manage own and shared files'),
     ('viewer', 'Read-only access to permitted files')`,

  `CREATE TABLE IF NOT EXISTS users (
     id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     email              VARCHAR(255) NOT NULL,
     username           VARCHAR(100) NOT NULL,
     display_name       VARCHAR(255) NULL,
     password_hash      VARCHAR(255) NOT NULL,
     status             ENUM('active','disabled') NOT NULL DEFAULT 'active',
     mfa_enabled        TINYINT(1) NOT NULL DEFAULT 0,
     mfa_secret         VARCHAR(128) NULL,
     storage_quota_bytes BIGINT UNSIGNED NULL,
     created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_users_email (email),
     UNIQUE KEY uq_users_username (username)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS user_roles (
     user_id  BIGINT UNSIGNED NOT NULL,
     role_id  INT UNSIGNED NOT NULL,
     PRIMARY KEY (user_id, role_id),
     KEY idx_user_roles_role (role_id),
     CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
     CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Sessions store only a sha256 of the bearer token, so a DB leak can't be replayed.
  `CREATE TABLE IF NOT EXISTS sessions (
     id           CHAR(64) NOT NULL,
     user_id      BIGINT UNSIGNED NOT NULL,
     created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     expires_at   DATETIME NOT NULL,
     ip           VARCHAR(64) NULL,
     user_agent   VARCHAR(255) NULL,
     PRIMARY KEY (id),
     KEY idx_sessions_user (user_id),
     KEY idx_sessions_expires (expires_at),
     CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Long-lived API tokens for integrations (REST/WebDAV/etc.); also stored hashed.
  `CREATE TABLE IF NOT EXISTS api_tokens (
     id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id      BIGINT UNSIGNED NOT NULL,
     name         VARCHAR(120) NOT NULL,
     token_hash   CHAR(64) NOT NULL,
     scopes       VARCHAR(255) NULL,
     created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     last_used_at DATETIME NULL,
     expires_at   DATETIME NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_api_tokens_hash (token_hash),
     KEY idx_api_tokens_user (user_id),
     CONSTRAINT fk_api_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One-time MFA recovery codes. Stored hashed, exactly like every other credential
  // here, and consumed on use rather than deleted so an audit still shows it was spent.
  `CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id    BIGINT UNSIGNED NOT NULL,
     code_hash  CHAR(64) NOT NULL,
     used_at    DATETIME NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_mfa_codes (user_id, code_hash),
     KEY idx_mfa_codes_user (user_id),
     CONSTRAINT fk_mfa_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Failed-login accounting. `audit_log` records that a login failed, but it is an
  // append-only trail with no index shaped for "how many failures for this account
  // in the last N minutes" — asking that question of it on every login would scan.
  // This table is small, self-pruning (the sweep job) and indexed for exactly that.
  `CREATE TABLE IF NOT EXISTS login_attempts (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     login      VARCHAR(255) NULL,
     ip         VARCHAR(64) NULL,
     ok         TINYINT(1) NOT NULL DEFAULT 0,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_login_attempts_login (login, created_at),
     KEY idx_login_attempts_ip (ip, created_at),
     KEY idx_login_attempts_created (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Content metadata ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS folders (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     path          VARCHAR(1024) NOT NULL,
     name          VARCHAR(255) NOT NULL,
     parent_id     BIGINT UNSIGNED NULL,
     owner_user_id BIGINT UNSIGNED NULL,
     created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_folders_path (path(255)),
     KEY idx_folders_parent (parent_id),
     KEY idx_folders_owner (owner_user_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One row per master. `path` mirrors the on-disk relative path (the URL key).
  //
  // Uniqueness is on `path_hash` (sha256 of the FULL path), not on the path column.
  // A prefix index — `UNIQUE KEY (path(255))` — treats two distinct paths sharing a
  // 255-char prefix as the same row, and `recordPut`'s ON DUPLICATE KEY UPDATE then
  // silently overwrites the other file's metadata. `path` keeps a plain (non-unique)
  // prefix index so `WHERE path = ?` lookups stay fast.
  //
  // `volume_id` records WHICH volume holds the bytes, so a read can stat one place
  // instead of walking every mount, and the scanner can reconcile per volume.
  `CREATE TABLE IF NOT EXISTS files (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     path            VARCHAR(1024) NOT NULL,
     path_hash       CHAR(64) NOT NULL,
     name            VARCHAR(255) NOT NULL,
     ext             VARCHAR(32) NULL,
     mime            VARCHAR(128) NULL,
     size_bytes      BIGINT UNSIGNED NOT NULL DEFAULT 0,
     volume_id       VARCHAR(64) NULL,
     mtime_ms        BIGINT UNSIGNED NULL,
     checksum_sha256 CHAR(64) NULL,
     width           INT UNSIGNED NULL,
     height          INT UNSIGNED NULL,
     visibility      ENUM('public','private') NOT NULL DEFAULT 'public',
     status          ENUM('active','trashed','missing') NOT NULL DEFAULT 'active',
     owner_user_id   BIGINT UNSIGNED NULL,
     folder_id       BIGINT UNSIGNED NULL,
     last_scan_id    BIGINT UNSIGNED NULL,
     created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     trashed_at      DATETIME NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_files_path_hash (path_hash),
     KEY idx_files_path (path(255)),
     KEY idx_files_owner (owner_user_id),
     KEY idx_files_folder (folder_id),
     KEY idx_files_status (status),
     KEY idx_files_checksum (checksum_sha256),
     KEY idx_files_volume (volume_id),
     KEY idx_files_scan (last_scan_id),
     FULLTEXT KEY ft_files_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Prior bytes retained for version control / restore. Without this a PUT over an
  // existing master destroyed the previous bytes outright; now the outgoing copy is
  // moved aside (same discipline as the trash) before the new one lands.
  `CREATE TABLE IF NOT EXISTS file_versions (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     file_id       BIGINT UNSIGNED NOT NULL,
     version_no    INT UNSIGNED NOT NULL,
     size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
     mime          VARCHAR(128) NULL,
     checksum_sha256 CHAR(64) NULL,
     stored_path   VARCHAR(1024) NOT NULL,
     created_by    BIGINT UNSIGNED NULL,
     created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_file_versions (file_id, version_no),
     KEY idx_file_versions_file (file_id, version_no),
     CONSTRAINT fk_file_versions_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Extracted media metadata (EXIF for images, plus decoded dimensions/format).
  // One row per file; the full parsed blob lives in `raw`, common fields are
  // promoted to columns for filtering/sorting.
  `CREATE TABLE IF NOT EXISTS file_metadata (
     file_id       BIGINT UNSIGNED NOT NULL,
     format        VARCHAR(32) NULL,
     color_space   VARCHAR(32) NULL,
     width         INT UNSIGNED NULL,
     height        INT UNSIGNED NULL,
     has_alpha     TINYINT(1) NULL,
     orientation   TINYINT NULL,
     density       INT UNSIGNED NULL,
     camera_make   VARCHAR(128) NULL,
     camera_model  VARCHAR(128) NULL,
     lens          VARCHAR(191) NULL,
     taken_at      DATETIME NULL,
     iso           INT UNSIGNED NULL,
     exposure      VARCHAR(32) NULL,
     f_number      DECIMAL(5,2) NULL,
     focal_length  DECIMAL(7,2) NULL,
     gps_lat       DECIMAL(10,7) NULL,
     gps_lng       DECIMAL(10,7) NULL,
     raw           JSON NULL,
     PRIMARY KEY (file_id),
     KEY idx_file_metadata_taken (taken_at),
     CONSTRAINT fk_file_metadata_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS tags (
     id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     name  VARCHAR(120) NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_tags_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS file_tags (
     file_id BIGINT UNSIGNED NOT NULL,
     tag_id  BIGINT UNSIGNED NOT NULL,
     PRIMARY KEY (file_id, tag_id),
     KEY idx_file_tags_tag (tag_id),
     CONSTRAINT fk_file_tags_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
     CONSTRAINT fk_file_tags_tag  FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Library organization ───────────────────────────────────────────────────
  // Collections: cross-cutting sets independent of path — a campaign, a client, a
  // release. The organizing primitive folders cannot express, because an asset
  // lives in exactly one folder and belongs to any number of collections.
  `CREATE TABLE IF NOT EXISTS collections (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     name          VARCHAR(191) NOT NULL,
     description   TEXT NULL,
     owner_user_id BIGINT UNSIGNED NULL,
     created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_collections_name (name),
     KEY idx_collections_owner (owner_user_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS collection_files (
     collection_id BIGINT UNSIGNED NOT NULL,
     file_id       BIGINT UNSIGNED NOT NULL,
     position      INT UNSIGNED NULL,
     added_by      BIGINT UNSIGNED NULL,
     added_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (collection_id, file_id),
     KEY idx_collection_files_file (file_id),
     CONSTRAINT fk_collection_files_collection FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
     CONSTRAINT fk_collection_files_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Custom metadata: per-installation field definitions attached to assets. What
  // turns "a file server with tags" into a catalog an organization can model its own
  // taxonomy in — and the write target for AI-suggested values.
  `CREATE TABLE IF NOT EXISTS metadata_fields (
     id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     field_key    VARCHAR(64) NOT NULL,
     label        VARCHAR(191) NOT NULL,
     type         ENUM('text','number','date','enum','multi','bool') NOT NULL DEFAULT 'text',
     options      JSON NULL,
     required     TINYINT(1) NOT NULL DEFAULT 0,
     position     INT NOT NULL DEFAULT 0,
     created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_metadata_fields_key (field_key)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One row per (file, field). The value is written to the column matching the
  // field's type as well as `value_text`, so filtering can use a real index and an
  // ordering that means something — "date after X" on a text column does not.
  `CREATE TABLE IF NOT EXISTS file_field_values (
     file_id    BIGINT UNSIGNED NOT NULL,
     field_id   BIGINT UNSIGNED NOT NULL,
     value_text TEXT NULL,
     value_num  DECIMAL(20,6) NULL,
     value_date DATETIME NULL,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (file_id, field_id),
     KEY idx_ffv_field_num (field_id, value_num),
     KEY idx_ffv_field_date (field_id, value_date),
     KEY idx_ffv_field_text (field_id, value_text(191)),
     CONSTRAINT fk_ffv_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
     CONSTRAINT fk_ffv_field FOREIGN KEY (field_id) REFERENCES metadata_fields(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Named renditions: "web-hero" instead of "?w=1600&h=900&fit=cover&q=82&fm=webp".
  // Pure metadata over the resize engine that already exists — downstream teams ask
  // for a rendition and the definition can change without touching their URLs.
  `CREATE TABLE IF NOT EXISTS renditions (
     id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     name        VARCHAR(64) NOT NULL,
     width       INT UNSIGNED NULL,
     height      INT UNSIGNED NULL,
     fit         VARCHAR(16) NULL,
     format      VARCHAR(16) NULL,
     quality     INT UNSIGNED NULL,
     description VARCHAR(255) NULL,
     created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_renditions_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // A filter set worth keeping. Also the input to a bulk operation, so "everything
  // matching this" is one saved thing rather than a query retyped each time.
  `CREATE TABLE IF NOT EXISTS saved_searches (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     name          VARCHAR(191) NOT NULL,
     query         JSON NOT NULL,
     owner_user_id BIGINT UNSIGNED NULL,
     shared        TINYINT(1) NOT NULL DEFAULT 0,
     created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_saved_searches (owner_user_id, name),
     KEY idx_saved_searches_shared (shared)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Collaboration ──────────────────────────────────────────────────────────
  // Shareable links (optionally password-protected / expiring / download-capped).
  `CREATE TABLE IF NOT EXISTS shares (
     id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     token          CHAR(32) NOT NULL,
     file_id        BIGINT UNSIGNED NULL,
     folder_id      BIGINT UNSIGNED NULL,
     permission     ENUM('view','download') NOT NULL DEFAULT 'view',
     password_hash  VARCHAR(255) NULL,
     expires_at     DATETIME NULL,
     max_downloads  INT UNSIGNED NULL,
     download_count INT UNSIGNED NOT NULL DEFAULT 0,
     created_by     BIGINT UNSIGNED NULL,
     created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_shares_token (token),
     KEY idx_shares_file (file_id),
     KEY idx_shares_folder (folder_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Threaded comments per asset. `parent_id` makes a reply a reply; `resolved_at`
  // lets a review thread be closed without deleting the conversation.
  `CREATE TABLE IF NOT EXISTS comments (
     id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     file_id     BIGINT UNSIGNED NOT NULL,
     user_id     BIGINT UNSIGNED NULL,
     parent_id   BIGINT UNSIGNED NULL,
     body        TEXT NOT NULL,
     resolved_at DATETIME NULL,
     created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_comments_file (file_id),
     KEY idx_comments_parent (parent_id),
     CONSTRAINT fk_comments_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // In-app notifications. Delivery beyond the console (email, webhooks) is a separate
  // decision; this is the durable record either way.
  `CREATE TABLE IF NOT EXISTS notifications (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id    BIGINT UNSIGNED NOT NULL,
     kind       VARCHAR(64) NOT NULL,
     body       VARCHAR(1024) NOT NULL,
     file_id    BIGINT UNSIGNED NULL,
     actor_id   BIGINT UNSIGNED NULL,
     read_at    DATETIME NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_notifications_user (user_id, read_at),
     CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
     CONSTRAINT fk_notifications_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Background work ────────────────────────────────────────────────────────
  // The single queue every asynchronous feature rides on: filesystem scans,
  // metadata extraction, transcodes, AI enrichment, integrity scrubs, purges.
  //
  // A worker claims a job by writing a unique `lease_owner` under an atomic
  // conditional UPDATE, so several processes can share one queue safely. A crashed
  // worker's job returns to `queued` when its `lease_until` passes. `dedupe_key` is
  // unique among LIVE jobs and cleared on completion, so "one scan at a time" needs
  // no coordination beyond the insert.
  `CREATE TABLE IF NOT EXISTS jobs (
     id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     type         VARCHAR(64) NOT NULL,
     payload      JSON NULL,
     state        ENUM('queued','running','done','failed','cancelled') NOT NULL DEFAULT 'queued',
     priority     TINYINT NOT NULL DEFAULT 5,
     attempts     INT UNSIGNED NOT NULL DEFAULT 0,
     max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
     run_after    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     lease_until  DATETIME NULL,
     lease_owner  VARCHAR(80) NULL,
     dedupe_key   VARCHAR(191) NULL,
     progress     JSON NULL,
     result       JSON NULL,
     error        TEXT NULL,
     created_by   BIGINT UNSIGNED NULL,
     created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     started_at   DATETIME NULL,
     finished_at  DATETIME NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_jobs_dedupe (dedupe_key),
     KEY idx_jobs_claim (state, run_after, priority),
     KEY idx_jobs_type (type),
     KEY idx_jobs_lease (lease_until)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Audit trail ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS audit_log (
     id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id     BIGINT UNSIGNED NULL,
     action      VARCHAR(64) NOT NULL,
     target_path VARCHAR(1024) NULL,
     ip          VARCHAR(64) NULL,
     user_agent  VARCHAR(255) NULL,
     meta        JSON NULL,
     created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_audit_user (user_id),
     KEY idx_audit_action (action),
     KEY idx_audit_created (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/**
 * Migrations for databases created by an EARLIER version of the schema above.
 * `CREATE TABLE IF NOT EXISTS` cannot reshape a table that already exists, so each
 * entry states a condition and the statements to run when it holds. Conditions are
 * read from information_schema, which makes every migration idempotent and safe to
 * re-run on every boot (db.init applies them in order).
 *
 * Conditions:
 *   columnMissing:  [table, column]          — column is not there yet
 *   indexMissing:   [table, index]           — index is not there yet
 *   indexPresent:   [table, index]           — index IS there (used for drops)
 *   columnTypeLacks:[table, column, token]   — the column's type doesn't contain the
 *                                              token (e.g. a new ENUM member)
 */
const MIGRATIONS = [
  // 2.5 — replace the prefix-based uniqueness on `path` with a real one on the full
  // path's sha256. Order matters: add + backfill the column, add the unique key,
  // then drop the old one (so uniqueness is never unenforced in between).
  {
    id: 'files.path_hash',
    if: { columnMissing: ['files', 'path_hash'] },
    sql: [
      'ALTER TABLE files ADD COLUMN path_hash CHAR(64) NULL AFTER path',
      'UPDATE files SET path_hash = SHA2(path, 256) WHERE path_hash IS NULL',
    ],
  },
  {
    id: 'files.uq_path_hash',
    if: { indexMissing: ['files', 'uq_files_path_hash'] },
    sql: ['ALTER TABLE files ADD UNIQUE KEY uq_files_path_hash (path_hash)'],
  },
  {
    id: 'files.idx_path',
    if: { indexMissing: ['files', 'idx_files_path'] },
    sql: ['ALTER TABLE files ADD KEY idx_files_path (path(255))'],
  },
  {
    id: 'files.drop_uq_path',
    if: { indexPresent: ['files', 'uq_files_path'] },
    sql: ['ALTER TABLE files DROP INDEX uq_files_path'],
  },
  // 2.4 — record where the bytes live (plus mtime, for scanner drift detection).
  {
    id: 'files.volume_id',
    if: { columnMissing: ['files', 'volume_id'] },
    sql: [
      'ALTER TABLE files ADD COLUMN volume_id VARCHAR(64) NULL AFTER size_bytes',
      'ALTER TABLE files ADD KEY idx_files_volume (volume_id)',
    ],
  },
  {
    id: 'files.mtime_ms',
    if: { columnMissing: ['files', 'mtime_ms'] },
    sql: ['ALTER TABLE files ADD COLUMN mtime_ms BIGINT UNSIGNED NULL AFTER volume_id'],
  },
  // 2.2 — the scanner's generation marker, and the state it puts a vanished file in.
  {
    id: 'files.last_scan_id',
    if: { columnMissing: ['files', 'last_scan_id'] },
    sql: [
      'ALTER TABLE files ADD COLUMN last_scan_id BIGINT UNSIGNED NULL AFTER folder_id',
      'ALTER TABLE files ADD KEY idx_files_scan (last_scan_id)',
    ],
  },
  {
    id: 'files.status_missing',
    if: { columnTypeLacks: ['files', 'status', 'missing'] },
    sql: ["ALTER TABLE files MODIFY COLUMN status ENUM('active','trashed','missing') NOT NULL DEFAULT 'active'"],
  },
  // 4.7 — comments were laid down flat; threading and resolution came later.
  {
    id: 'comments.parent_id',
    if: { columnMissing: ['comments', 'parent_id'] },
    sql: [
      'ALTER TABLE comments ADD COLUMN parent_id BIGINT UNSIGNED NULL AFTER user_id',
      'ALTER TABLE comments ADD KEY idx_comments_parent (parent_id)',
    ],
  },
  {
    id: 'comments.resolved_at',
    if: { columnMissing: ['comments', 'resolved_at'] },
    sql: [
      'ALTER TABLE comments ADD COLUMN resolved_at DATETIME NULL',
      'ALTER TABLE comments ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    ],
  },
  // 4.1 — a version needs to record the mime it was, not just its bytes.
  {
    id: 'file_versions.mime',
    if: { columnMissing: ['file_versions', 'mime'] },
    sql: ['ALTER TABLE file_versions ADD COLUMN mime VARCHAR(128) NULL AFTER size_bytes'],
  },
];

module.exports = { STATEMENTS, MIGRATIONS };
