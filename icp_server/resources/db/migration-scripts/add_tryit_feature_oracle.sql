-- Migration: Try-It proxy support (Oracle 19c+)
-- Adds runtimes.try_it_host - the bare, reachable host/IP for this runtime process
-- (self-reported by icp-runtime-bridge in the heartbeat), used by the Try-It proxy
-- (tryit_proxy_service.bal) to resolve where to forward "Try it out" requests.
-- Idempotent - safe to re-run. Fresh installs get this from oracle_init.sql.
-- Run once against the main ICP DB (as the ICP schema owner).

-- ORA-01430 = column being added already exists; ignored for idempotency.
DECLARE
    e_col_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_col_exists, -1430);
BEGIN
    EXECUTE IMMEDIATE 'ALTER TABLE runtimes ADD (try_it_host VARCHAR2(255 CHAR))';
EXCEPTION
    WHEN e_col_exists THEN NULL;
END;
/
