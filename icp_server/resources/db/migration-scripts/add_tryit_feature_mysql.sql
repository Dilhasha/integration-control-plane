-- Migration: Try-It proxy support (MySQL / MariaDB)
-- Adds runtimes.try_it_host - the bare, reachable host/IP for this runtime process
-- (self-reported by icp-runtime-bridge in the heartbeat), used by the Try-It proxy
-- (tryit_proxy_service.bal) to resolve where to forward "Try it out" requests.
-- Idempotent - safe to re-run. Fresh installs get this from mysql_init.sql.
-- Run once against the main ICP DB.

-- MySQL has no ADD COLUMN IF NOT EXISTS, so guard via information_schema.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'runtimes' AND COLUMN_NAME = 'try_it_host');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE runtimes ADD try_it_host VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
