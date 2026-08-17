-- Migration: Faulty data service tracking (MySQL / MariaDB)
-- Adds mi_data_service_artifacts.error_message - populated by the runtime bridge
-- in the heartbeat when a data service fails to deploy (state = 'Faulty').
-- Canonicalize deployed services to Active and restrict the state ENUM to the
-- public contract (the old ENUM was 'enabled'/'disabled').
-- Idempotent - safe to re-run. Fresh installs get this from mysql_init.sql.
-- Run once against the main ICP DB.

-- 1. error_message column
--    (MySQL has no ADD COLUMN IF NOT EXISTS, so guard via information_schema)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mi_data_service_artifacts' AND COLUMN_NAME = 'error_message');
SET @ddl = IF(@col_exists = 0,
    'ALTER TABLE mi_data_service_artifacts ADD error_message TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Widen the ENUM to a temporary superset so existing 'enabled'/'disabled'
--    rows stay valid while they are canonicalized.
ALTER TABLE mi_data_service_artifacts
    MODIFY state ENUM('enabled', 'disabled', 'Active', 'Faulty') NOT NULL DEFAULT 'Active';

-- 3. Canonicalize every deployed service to Active (only Faulty is preserved).
UPDATE mi_data_service_artifacts SET state = 'Active' WHERE LOWER(state) <> 'faulty';

-- 4. Narrow the ENUM to the public Active/Faulty contract.
ALTER TABLE mi_data_service_artifacts
    MODIFY state ENUM('Active', 'Faulty') NOT NULL DEFAULT 'Active';
