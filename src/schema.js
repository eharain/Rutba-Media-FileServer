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
  `CREATE TABLE IF NOT EXISTS files (
     id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     path            VARCHAR(1024) NOT NULL,
     name            VARCHAR(255) NOT NULL,
     ext             VARCHAR(32) NULL,
     mime            VARCHAR(128) NULL,
     size_bytes      BIGINT UNSIGNED NOT NULL DEFAULT 0,
     checksum_sha256 CHAR(64) NULL,
     width           INT UNSIGNED NULL,
     height          INT UNSIGNED NULL,
     visibility      ENUM('public','private') NOT NULL DEFAULT 'public',
     status          ENUM('active','trashed') NOT NULL DEFAULT 'active',
     owner_user_id   BIGINT UNSIGNED NULL,
     folder_id       BIGINT UNSIGNED NULL,
     created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     trashed_at      DATETIME NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_files_path (path(255)),
     KEY idx_files_owner (owner_user_id),
     KEY idx_files_folder (folder_id),
     KEY idx_files_status (status),
     KEY idx_files_checksum (checksum_sha256),
     FULLTEXT KEY ft_files_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Prior bytes retained for version control / restore.
  `CREATE TABLE IF NOT EXISTS file_versions (
     id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     file_id       BIGINT UNSIGNED NOT NULL,
     version_no    INT UNSIGNED NOT NULL,
     size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
     checksum_sha256 CHAR(64) NULL,
     stored_path   VARCHAR(1024) NOT NULL,
     created_by    BIGINT UNSIGNED NULL,
     created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_file_versions (file_id, version_no),
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

  `CREATE TABLE IF NOT EXISTS comments (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     file_id    BIGINT UNSIGNED NOT NULL,
     user_id    BIGINT UNSIGNED NULL,
     body       TEXT NOT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_comments_file (file_id),
     CONSTRAINT fk_comments_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
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

module.exports = { STATEMENTS };
