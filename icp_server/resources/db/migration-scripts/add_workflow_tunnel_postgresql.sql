-- Migration: stateless workflow command tunnel (PostgreSQL 13+)
-- Replaces the in-memory tunnel state with two shared tables, so any ICP node can
-- serve any request and the node that accepts a request need not be the node that
-- delivers it (see docs: stateless multi-node tunnel).
--   1. wf_read_cache       - materialized read results, keyed by request+roles
--   2. wf_operation_outbox - user-initiated mutations awaiting delivery
-- Idempotent - safe to re-run. Fresh installs get all of this from postgresql_init.sql.
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
CREATE TABLE IF NOT EXISTS wf_read_cache (
    cache_key   VARCHAR(64)  NOT NULL,
    scope_key   VARCHAR(200) NOT NULL,
    request     TEXT         NOT NULL,
    fetch_id    VARCHAR(36),
    status      VARCHAR(16)  NOT NULL,
    expires_at  BIGINT       NOT NULL,
    claimed_at  BIGINT,
    payload     TEXT,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (cache_key)
);

CREATE INDEX IF NOT EXISTS idx_wfrc_claim ON wf_read_cache (status, scope_key, expires_at);
CREATE INDEX IF NOT EXISTS idx_wfrc_expiry ON wf_read_cache (expires_at);

-- 2. Mutation outbox. operation_id IS the caller's idempotency key, so a repeated
--    submission is a primary-key conflict rather than a second operation.
--
--    No foreign key to runtimes, deliberately: a K8S deployment DELETEs runtime rows
--    when they go offline (runtime_repository.bal), and ON DELETE CASCADE would take the
--    record of an unconfirmed mutation with it - exactly the evidence needed to tell a
--    user their action may never have run. Same reasoning for the caller identity, which
--    lives in the payload rather than as a users FK.
CREATE TABLE IF NOT EXISTS wf_operation_outbox (
    operation_id  VARCHAR(100) NOT NULL,
    runtime_id    CHAR(36)     NOT NULL,
    scope_key     VARCHAR(200) NOT NULL,
    status        VARCHAR(16)  NOT NULL,
    issued_at     BIGINT       NOT NULL,
    deadline      BIGINT       NOT NULL,
    delivered_at  BIGINT,
    completed_at  BIGINT,
    payload       TEXT         NOT NULL,
    result        TEXT,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operation_id)
);

CREATE INDEX IF NOT EXISTS idx_wfoo_delivery ON wf_operation_outbox (runtime_id, status, issued_at);
CREATE INDEX IF NOT EXISTS idx_wfoo_cleanup ON wf_operation_outbox (status, completed_at);

-- 3. Boost window: while someone is working with workflow views for this runtime's
--    scope, ask it to heartbeat faster. Epoch seconds; NULL or past means no boost.
ALTER TABLE runtimes ADD COLUMN IF NOT EXISTS wf_boosted_until BIGINT;
