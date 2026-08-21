-- Migration: request cache tables (Oracle 19c+)
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
-- Idempotent - safe to re-run. Fresh installs get all of this from oracle_init.sql.
--    (ORA-00955 = object name already used; ignored for idempotency)

DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE TABLE cache_entry (
    cache_key VARCHAR2(64 CHAR) NOT NULL,
    kind VARCHAR2(64 CHAR) NOT NULL,
    owner VARCHAR2(200 CHAR) NOT NULL,
    token VARCHAR2(36 CHAR),
    status VARCHAR2(16 CHAR) NOT NULL,
    expires_at NUMBER(19) NOT NULL,
    claimed_at NUMBER(19),
    data CLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (cache_key)
)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE INDEX idx_cache_entry_claim ON cache_entry (owner, token, claimed_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/
DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE INDEX idx_cache_entry_expiry ON cache_entry (expires_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE TABLE cache_operation_outbox (
    operation_id VARCHAR2(100 CHAR) NOT NULL,
    target VARCHAR2(36 CHAR) NOT NULL,
    owner VARCHAR2(200 CHAR) NOT NULL,
    kind VARCHAR2(64 CHAR) NOT NULL,
    status VARCHAR2(16 CHAR) NOT NULL,
    issued_at NUMBER(19) NOT NULL,
    deadline NUMBER(19) NOT NULL,
    delivered_at NUMBER(19),
    completed_at NUMBER(19),
    data CLOB NOT NULL,
    result CLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (operation_id)
)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE INDEX idx_cache_outbox_delivery ON cache_operation_outbox (target, status, issued_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/
DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE INDEX idx_cache_outbox_cleanup ON cache_operation_outbox (status, completed_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/
