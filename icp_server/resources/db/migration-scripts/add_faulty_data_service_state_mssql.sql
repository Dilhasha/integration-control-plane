-- Migration: Faulty data service tracking (Microsoft SQL Server)
-- Adds mi_data_service_artifacts.error_message - populated by the runtime bridge
-- in the heartbeat when a data service fails to deploy (state = 'Faulty').
-- Canonicalize deployed services to Active and restrict the public state contract
-- (the old contract was 'enabled'/'disabled'). Both the inline CHECK and DEFAULT
-- on state are auto-named on fresh installs, so they are looked up dynamically.
-- Idempotent - safe to re-run. Fresh installs get this from mssql_init.sql.
-- Run once against the main ICP DB.

-- 1. error_message column
IF COL_LENGTH('mi_data_service_artifacts', 'error_message') IS NULL
    ALTER TABLE mi_data_service_artifacts ADD error_message NVARCHAR(MAX) NULL;
GO

-- 2. Drop every CHECK currently guarding state (fresh installs name it
--    automatically, and more than one may exist) so the legacy 'enabled'/'disabled'
--    values can be canonicalized.
DECLARE @cn NVARCHAR(256);
SELECT @cn = MIN(name) FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('mi_data_service_artifacts') AND definition LIKE '%state%';
WHILE @cn IS NOT NULL
BEGIN
    EXEC('ALTER TABLE mi_data_service_artifacts DROP CONSTRAINT [' + @cn + ']');
    SELECT @cn = MIN(name) FROM sys.check_constraints
        WHERE parent_object_id = OBJECT_ID('mi_data_service_artifacts') AND definition LIKE '%state%';
END
GO

-- 3. Drop the auto-named DEFAULT on state so it can be reset to 'Active'.
DECLARE @dn NVARCHAR(256);
SELECT @dn = dc.name FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('mi_data_service_artifacts') AND c.name = 'state';
IF @dn IS NOT NULL
    EXEC('ALTER TABLE mi_data_service_artifacts DROP CONSTRAINT [' + @dn + ']');
GO

-- 4. Canonicalize every deployed service to Active (only Faulty is preserved),
--    now that the old CHECK is gone.
UPDATE mi_data_service_artifacts SET state = 'Active' WHERE LOWER(state) <> 'faulty';
GO

-- 5. Re-add the DEFAULT and CHECK matching the fresh-init Active/Faulty contract.
ALTER TABLE mi_data_service_artifacts ADD CONSTRAINT df_mi_ds_state DEFAULT 'Active' FOR state;
GO
ALTER TABLE mi_data_service_artifacts ADD CONSTRAINT ck_mi_ds_state CHECK (state IN ('Active', 'Faulty'));
GO
