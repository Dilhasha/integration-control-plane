-- Migration: integration types on components (Microsoft SQL Server)
-- Adds the two columns that record an integration's type, encoded the same way
-- as devant:
--   1. components.display_type       - the type itself, e.g. 'ballerinaService',
--                                      'miApiService', 'scheduledTask', 'miCronjob'
--   2. components.component_sub_type - discriminates types that share a generic
--                                      service display_type (AI Agent, MCP Server,
--                                      File Integration); NULL for the rest
-- Existing rows backfill to 'service', which is what the server previously
-- reported for every component, so nothing changes for them.
-- Idempotent - safe to re-run. Fresh installs get this from mssql_init.sql.
-- Run once against the main ICP DB.

-- 1. display_type
IF COL_LENGTH('components', 'display_type') IS NULL
    ALTER TABLE components ADD display_type NVARCHAR(50) NOT NULL DEFAULT 'service';
GO

-- 2. component_sub_type
IF COL_LENGTH('components', 'component_sub_type') IS NULL
    ALTER TABLE components ADD component_sub_type NVARCHAR(50) NULL;
GO
