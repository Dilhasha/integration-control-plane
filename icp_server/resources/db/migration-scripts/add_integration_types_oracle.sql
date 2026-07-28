-- Migration: integration types on components (Oracle 19c+)
-- Adds the two columns that record an integration's type, encoded the same way
-- as devant:
--   1. components.display_type       - the type itself, e.g. 'ballerinaService',
--                                      'miApiService', 'scheduledTask', 'miCronjob'
--   2. components.component_sub_type - discriminates types that share a generic
--                                      service display_type (AI Agent, MCP Server,
--                                      File Integration); NULL for the rest
-- Existing rows backfill to 'service', which is what the server previously
-- reported for every component, so nothing changes for them.
-- Idempotent - safe to re-run. Fresh installs get this from oracle_init.sql.
-- Run once against the main ICP DB (as the ICP schema owner).

-- 1. display_type
--    (ORA-01430 = column being added already exists; ignored for idempotency)
DECLARE
    e_col_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_col_exists, -1430);
BEGIN
    EXECUTE IMMEDIATE 'ALTER TABLE components ADD (display_type VARCHAR2(50 CHAR) DEFAULT ''service'' NOT NULL)';
EXCEPTION
    WHEN e_col_exists THEN NULL;
END;
/

-- 2. component_sub_type
DECLARE
    e_col_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_col_exists, -1430);
BEGIN
    EXECUTE IMMEDIATE 'ALTER TABLE components ADD (component_sub_type VARCHAR2(50 CHAR) NULL)';
EXCEPTION
    WHEN e_col_exists THEN NULL;
END;
/
