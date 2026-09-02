-- Migration: request cache tables (MySQL 8+)
--
-- Two generic tables the control plane uses to answer read requests without holding one open
-- and to queue the operations that change something: cache_entry and cache_operation_outbox.
-- Neither knows what a workflow is - `kind` says what a row is about and `data` carries the
-- rest.
--
-- The `cache_` prefix is the contract: DERIVED state. These tables may be dropped and
-- recreated on any upgrade and nothing needs migrating - losing a row costs one refetch, or
-- one caller being told their operation was never confirmed. That is also why this script
-- only creates them.
--
-- Idempotent - safe to re-run. Fresh installs get all of this from mysql_init.sql.
-- MySQL has no CREATE INDEX IF NOT EXISTS, so the indexes are declared in the tables.

CREATE TABLE IF NOT EXISTS cache_entry (
    cache_key VARCHAR(64) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    owner VARCHAR(200) NOT NULL,
    token VARCHAR(36),
    status VARCHAR(16) NOT NULL,
    expires_at BIGINT NOT NULL,
    claimed_at BIGINT,
    data LONGTEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (cache_key),
    KEY idx_cache_entry_claim (owner, token, claimed_at),
    KEY idx_cache_entry_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cache_operation_outbox (
    operation_id VARCHAR(100) NOT NULL,
    target VARCHAR(36) NOT NULL,
    owner VARCHAR(200) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    issued_at BIGINT NOT NULL,
    deadline BIGINT NOT NULL,
    delivered_at BIGINT,
    completed_at BIGINT,
    data LONGTEXT NOT NULL,
    result LONGTEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operation_id),
    KEY idx_cache_outbox_delivery (target, status, issued_at),
    KEY idx_cache_outbox_cleanup (status, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
