-- Migration: Faulty data service tracking (Oracle 19c+)
-- Adds mi_data_service_artifacts.error_message - populated by the runtime bridge
-- in the heartbeat when a data service fails to deploy (state = 'Faulty').
-- Canonicalize deployed services to Active and restrict the public state contract
-- (the old contract was 'enabled'/'disabled'). The inline CHECK is auto-named on
-- fresh installs, so it is looked up dynamically.
-- Idempotent - safe to re-run. Fresh installs get this from oracle_init.sql.
-- Run once against the main ICP DB (as the ICP schema owner).

-- 1. error_message column (ORA-01430 = column being added already exists; ignored)
DECLARE
    e_col_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_col_exists, -1430);
BEGIN
    EXECUTE IMMEDIATE 'ALTER TABLE mi_data_service_artifacts ADD (error_message CLOB)';
EXCEPTION
    WHEN e_col_exists THEN NULL;
END;
/

-- 2. Drop every CHECK currently guarding state (fresh installs name it
--    automatically, and more than one may exist). The LIKE pattern requires an
--    IN (...) list, so the NOT NULL check on the same column is left alone.
BEGIN
    FOR c IN (
        SELECT constraint_name
        FROM user_constraints
        WHERE table_name = 'MI_DATA_SERVICE_ARTIFACTS'
          AND constraint_type = 'C'
          AND UPPER(search_condition_vc) LIKE '%STATE%IN%(%'
    ) LOOP
        EXECUTE IMMEDIATE 'ALTER TABLE mi_data_service_artifacts DROP CONSTRAINT "' || c.constraint_name || '"';
    END LOOP;
END;
/

-- 3. Canonicalize every deployed service to Active (only Faulty is preserved),
--    now that the old CHECK is gone.
UPDATE mi_data_service_artifacts SET state = 'Active' WHERE LOWER(state) <> 'faulty';

-- 4. Reset the default and re-add the Active/Faulty contract.
ALTER TABLE mi_data_service_artifacts MODIFY (state DEFAULT 'Active');
ALTER TABLE mi_data_service_artifacts ADD CONSTRAINT ck_mi_ds_state CHECK (state IN ('Active', 'Faulty'));

COMMIT;
