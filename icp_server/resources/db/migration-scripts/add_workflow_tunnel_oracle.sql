-- Migration: stateless workflow command tunnel (Oracle 19c+)
-- Replaces the in-memory tunnel state with two shared tables, so any ICP node can
-- serve any request and the node that accepts a request need not be the node that
-- delivers it (see docs: stateless multi-node tunnel).
--   1. wf_read_cache       - materialized read results, keyed by request+roles
--   2. wf_operation_outbox - user-initiated mutations awaiting delivery
-- Idempotent - safe to re-run. Fresh installs get all of this from oracle_init.sql.
-- Run once against the main ICP DB.

-- 1. Read cache. One row per (scope, operation, params, caller role set); the response
--    is an opaque blob, and only what a WHERE clause needs is a column.
--
--    expires_at is epoch SECONDS, not a TIMESTAMP: every read, claim and sweep compares
--    it, and epoch integers compare identically on all five engines while timestamp
--    arithmetic does not (see storage/database_dialect.bal for how much it varies).
--
--    Two blobs, deliberately: `request` is what to execute - written when the row is
--    created and read by whichever heartbeat claims it - and `payload` is the result,
--    written when it comes back. One blob cannot be both: the claim needs the request
--    before any result exists.
--
--    Three states, and the middle one is why stale rows are kept: FETCHING (a command is
--    in flight), READY (payload usable; still served after expiry while a refresh runs),
--    FAILED (the reason is in the payload).
--    (ORA-00955 = object name already used; ignored for idempotency)
DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE TABLE wf_read_cache (
          cache_key   VARCHAR2(64 CHAR)  NOT NULL,
          scope_key   VARCHAR2(200 CHAR) NOT NULL,
          request     CLOB         NOT NULL,
          fetch_id    VARCHAR2(36 CHAR),
          status      VARCHAR2(16 CHAR)  NOT NULL,
          expires_at  NUMBER(19)         NOT NULL,
          claimed_at  NUMBER(19),
          payload     CLOB,
          created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    EXECUTE IMMEDIATE 'CREATE INDEX idx_wfrc_claim ON wf_read_cache (status, scope_key, expires_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE 'CREATE INDEX idx_wfrc_expiry ON wf_read_cache (expires_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

-- 2. Mutation outbox. operation_id IS the caller's idempotency key, so a repeated
--    submission is a primary-key conflict rather than a second operation.
--
--    No foreign key to runtimes, deliberately: a K8S deployment DELETEs runtime rows
--    when they go offline (runtime_repository.bal), and ON DELETE CASCADE would take the
--    record of an unconfirmed mutation with it - exactly the evidence needed to tell a
--    user their action may never have run. Same reasoning for the caller identity, which
--    lives in the payload rather than as a users FK.
DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE TABLE wf_operation_outbox (
          operation_id  VARCHAR2(100 CHAR) NOT NULL,
          runtime_id    CHAR(36)           NOT NULL,
          scope_key     VARCHAR2(200 CHAR) NOT NULL,
          status        VARCHAR2(16 CHAR)  NOT NULL,
          issued_at     NUMBER(19)         NOT NULL,
          deadline      NUMBER(19)         NOT NULL,
          delivered_at  NUMBER(19),
          completed_at  NUMBER(19),
          payload       CLOB               NOT NULL,
          result        CLOB,
          created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    EXECUTE IMMEDIATE 'CREATE INDEX idx_wfoo_delivery ON wf_operation_outbox (runtime_id, status, issued_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE 'CREATE INDEX idx_wfoo_cleanup ON wf_operation_outbox (status, completed_at)';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

-- 3. Boost window: while someone is working with workflow views for this runtime's
--    scope, ask it to heartbeat faster. Epoch seconds; NULL or past means no boost.
--    (ORA-01430 = column already exists; ignored for idempotency)
DECLARE
    e_col_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_col_exists, -1430);
BEGIN
    EXECUTE IMMEDIATE 'ALTER TABLE runtimes ADD (wf_boosted_until NUMBER(19))';
EXCEPTION
    WHEN e_col_exists THEN NULL;
END;
/
