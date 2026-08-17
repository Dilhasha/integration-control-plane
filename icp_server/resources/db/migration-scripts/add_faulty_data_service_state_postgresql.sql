-- Migration: Faulty data service tracking (PostgreSQL)
-- Adds mi_data_service_artifacts.error_message - populated by the runtime bridge
-- in the heartbeat when a data service fails to deploy (state = 'Faulty').
-- Canonicalize deployed services to Active and restrict the public state contract
-- (the old contract was 'enabled'/'disabled').
-- Idempotent - safe to re-run. Fresh installs get this from postgresql_init.sql.
-- Run once against the main ICP DB.

ALTER TABLE mi_data_service_artifacts ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE mi_data_service_artifacts DROP CONSTRAINT IF EXISTS mi_data_service_artifacts_state_check;
UPDATE mi_data_service_artifacts SET state = 'Active' WHERE LOWER(state) <> 'faulty';
ALTER TABLE mi_data_service_artifacts ALTER COLUMN state SET DEFAULT 'Active';
ALTER TABLE mi_data_service_artifacts ADD CONSTRAINT mi_data_service_artifacts_state_check CHECK (state IN ('Active', 'Faulty'));
