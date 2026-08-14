-- Migration: workflow metadata in the full heartbeat (Oracle 19c+)
-- Adds the bi_workflow_metadata table for BI runtimes whose ICP bridge publishes the
-- workflow metadata document (definitions, human tasks, activities, agents — with JSON
-- schemas) and advertised capabilities via the full heartbeat's optional
-- workflowMetadata/capabilities fields.
-- Idempotent - safe to re-run. Fresh installs get this from oracle_init.sql.
-- Run once against the main ICP DB (as the ICP schema owner).
-- IMPORTANT: apply BEFORE upgrading the ICP server — heartbeat processing writes this
-- table unconditionally, so a missing table fails every full heartbeat transaction.

-- ORA-00955 = name already used by an existing object; ignored for idempotency
DECLARE
    e_object_exists EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_object_exists, -955);
BEGIN
    EXECUTE IMMEDIATE '
        CREATE TABLE bi_workflow_metadata (
          runtime_id   CHAR(36) NOT NULL,
          metadata     CLOB NOT NULL,
          capabilities VARCHAR2(512 CHAR),
          created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
          updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
          PRIMARY KEY (runtime_id),
          CONSTRAINT fk_bi_workflow_metadata_runtime FOREIGN KEY (runtime_id) REFERENCES runtimes (runtime_id) ON DELETE CASCADE
        )';
EXCEPTION
    WHEN e_object_exists THEN NULL;
END;
/

CREATE OR REPLACE TRIGGER trg_bi_workflow_metadata_updated
BEFORE UPDATE ON bi_workflow_metadata
FOR EACH ROW
BEGIN
    :NEW.updated_at := CURRENT_TIMESTAMP;
END;
/
