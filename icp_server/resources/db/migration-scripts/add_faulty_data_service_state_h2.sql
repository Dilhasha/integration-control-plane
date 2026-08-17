-- Migration: Faulty data service tracking (H2)
-- Adds mi_data_service_artifacts.error_message - populated by the runtime bridge
-- in the heartbeat when a data service fails to deploy (state = 'Faulty').
-- Canonicalize deployed services to Active and restrict the public state contract.
-- Idempotent - safe to re-run. Fresh installs get this from h2_init.sql.
-- Run once against the main ICP DB.

ALTER TABLE mi_data_service_artifacts ADD COLUMN IF NOT EXISTS error_message CLOB;
ALTER TABLE mi_data_service_artifacts DROP CONSTRAINT IF EXISTS ck_mi_ds_state;
UPDATE mi_data_service_artifacts SET state = 'Active' WHERE LOWER(state) <> 'faulty';
ALTER TABLE mi_data_service_artifacts ALTER COLUMN state SET DEFAULT 'Active';
ALTER TABLE mi_data_service_artifacts ADD CONSTRAINT ck_mi_ds_state CHECK (state IN ('Active', 'Faulty'));
