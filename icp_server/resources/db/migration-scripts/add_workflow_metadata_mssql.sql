-- Migration: workflow metadata in the full heartbeat (Microsoft SQL Server)
-- Adds the bi_workflow_metadata table for BI runtimes whose ICP bridge publishes the
-- workflow metadata document (definitions, human tasks, activities, agents — with JSON
-- schemas) and advertised capabilities via the full heartbeat's optional
-- workflowMetadata/capabilities fields.
-- Idempotent - safe to re-run. Fresh installs get this from mssql_init.sql.
-- Run once against the main ICP DB.
-- IMPORTANT: apply BEFORE upgrading the ICP server — heartbeat processing writes this
-- table unconditionally, so a missing table fails every full heartbeat transaction.

IF OBJECT_ID('bi_workflow_metadata', 'U') IS NULL
BEGIN
    CREATE TABLE bi_workflow_metadata (
        runtime_id CHAR(36) NOT NULL,
        metadata NVARCHAR (MAX) NOT NULL,
        capabilities NVARCHAR (512),
        created_at DATETIME2 NOT NULL DEFAULT GETDATE (),
        updated_at DATETIME2 NOT NULL DEFAULT GETDATE (),
        PRIMARY KEY (runtime_id),
        CONSTRAINT fk_bi_workflow_metadata_runtime FOREIGN KEY (runtime_id) REFERENCES runtimes (runtime_id) ON DELETE CASCADE
    );
END
GO

DROP TRIGGER IF EXISTS trg_bi_workflow_metadata_updated_at;
GO

CREATE TRIGGER trg_bi_workflow_metadata_updated_at
ON bi_workflow_metadata
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE bi_workflow_metadata
    SET updated_at = GETDATE()
    FROM bi_workflow_metadata t
    INNER JOIN inserted i ON t.runtime_id = i.runtime_id;
END;
GO
