-- Migration: request cache tables (MSSQL 2019+)
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
-- Idempotent - safe to re-run. Fresh installs get all of this from mssql_init.sql.

IF OBJECT_ID('cache_entry', 'U') IS NULL
CREATE TABLE cache_entry (
    cache_key NVARCHAR(64) NOT NULL,
    kind NVARCHAR(64) NOT NULL,
    owner NVARCHAR(200) NOT NULL,
    token NVARCHAR(36),
    status NVARCHAR(16) NOT NULL,
    expires_at BIGINT NOT NULL,
    claimed_at BIGINT,
    data NVARCHAR(MAX),
    created_at DATETIME2 NOT NULL DEFAULT GETDATE(),
    PRIMARY KEY (cache_key)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_cache_entry_claim' AND object_id = OBJECT_ID('cache_entry'))
CREATE INDEX idx_cache_entry_claim ON cache_entry (owner, token, claimed_at);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_cache_entry_expiry' AND object_id = OBJECT_ID('cache_entry'))
CREATE INDEX idx_cache_entry_expiry ON cache_entry (expires_at);
GO

IF OBJECT_ID('cache_operation_outbox', 'U') IS NULL
CREATE TABLE cache_operation_outbox (
    operation_id NVARCHAR(100) NOT NULL,
    target NVARCHAR(36) NOT NULL,
    owner NVARCHAR(200) NOT NULL,
    kind NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    issued_at BIGINT NOT NULL,
    deadline BIGINT NOT NULL,
    delivered_at BIGINT,
    completed_at BIGINT,
    data NVARCHAR(MAX) NOT NULL,
    result NVARCHAR(MAX),
    created_at DATETIME2 NOT NULL DEFAULT GETDATE(),
    PRIMARY KEY (operation_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_cache_outbox_delivery' AND object_id = OBJECT_ID('cache_operation_outbox'))
CREATE INDEX idx_cache_outbox_delivery ON cache_operation_outbox (target, status, issued_at);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_cache_outbox_cleanup' AND object_id = OBJECT_ID('cache_operation_outbox'))
CREATE INDEX idx_cache_outbox_cleanup ON cache_operation_outbox (status, completed_at);
