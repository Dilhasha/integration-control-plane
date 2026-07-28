-- Migration: integration types on components (MySQL / MariaDB)
-- Adds the two columns that record an integration's type, encoded the same way
-- as devant:
--   1. components.display_type       - the type itself, e.g. 'ballerinaService',
--                                      'miApiService', 'scheduledTask', 'miCronjob'
--   2. components.component_sub_type - discriminates types that share a generic
--                                      service display_type (AI Agent, MCP Server,
--                                      File Integration); NULL for the rest
-- Existing rows backfill to 'service', which is what the server previously
-- reported for every component, so nothing changes for them.
-- Idempotent - safe to re-run. Fresh installs get this from mysql_init.sql.
-- Run once against the main ICP DB.

-- 1. display_type
--    (MySQL has no ADD COLUMN IF NOT EXISTS, so guard via information_schema)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'components' AND COLUMN_NAME = 'display_type');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE components ADD display_type VARCHAR(50) NOT NULL DEFAULT ''service''', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. component_sub_type
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'components' AND COLUMN_NAME = 'component_sub_type');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE components ADD component_sub_type VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
