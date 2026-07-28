-- Migration: integration types on components (PostgreSQL)
-- Adds the two columns that record an integration's type, encoded the same way
-- as devant:
--   1. components.display_type       - the type itself, e.g. 'ballerinaService',
--                                      'miApiService', 'scheduledTask', 'miCronjob'
--   2. components.component_sub_type - discriminates types that share a generic
--                                      service display_type (AI Agent, MCP Server,
--                                      File Integration); NULL for the rest
-- Existing rows backfill to 'service', which is what the server previously
-- reported for every component, so nothing changes for them.
-- Idempotent - safe to re-run. Fresh installs get this from postgresql_init.sql.
-- Run once against the main ICP DB.

ALTER TABLE components ADD COLUMN IF NOT EXISTS display_type VARCHAR(50) NOT NULL DEFAULT 'service';

ALTER TABLE components ADD COLUMN IF NOT EXISTS component_sub_type VARCHAR(50) NULL;
