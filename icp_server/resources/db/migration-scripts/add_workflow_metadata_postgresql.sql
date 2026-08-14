-- Migration: workflow metadata in the full heartbeat (PostgreSQL)
-- Adds the bi_workflow_metadata table for BI runtimes whose ICP bridge publishes the
-- workflow metadata document (definitions, human tasks, activities, agents — with JSON
-- schemas) and advertised capabilities via the full heartbeat's optional
-- workflowMetadata/capabilities fields.
-- Idempotent - safe to re-run. Fresh installs get this from postgresql_init.sql.
-- Run once against the main ICP DB.
-- IMPORTANT: apply BEFORE upgrading the ICP server — heartbeat processing writes this
-- table unconditionally, so a missing table fails every full heartbeat transaction.

CREATE TABLE IF NOT EXISTS bi_workflow_metadata (
    runtime_id CHAR(36) NOT NULL,
    metadata JSONB NOT NULL,
    capabilities VARCHAR(512),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (runtime_id),
    CONSTRAINT fk_bi_workflow_metadata_runtime FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS update_bi_workflow_metadata_updated_at ON bi_workflow_metadata;
CREATE TRIGGER update_bi_workflow_metadata_updated_at BEFORE UPDATE ON bi_workflow_metadata
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
