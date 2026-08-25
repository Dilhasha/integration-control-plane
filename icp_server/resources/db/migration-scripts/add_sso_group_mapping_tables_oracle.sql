-- Migration: SSO group mapping / federated RBAC (Oracle 19c+)
-- Adds everything an existing deployment needs for SSO-driven group membership:
--   1. sso_group_mappings           - IdP claim value -> ICP group (with optional
--                                     project / integration scope)
--   2. federated_group_user_mapping - SSO-owned group memberships, kept separate
--                                     from the manual ones in group_user_mapping
--   3. v_effective_group_user_mapping - UNION of manual + SSO-owned memberships
--   4. rebinds v_user_project_access, v_user_integration_access and
--      v_user_environment_access onto the new view, so permission resolution
--      honours federated memberships
-- Idempotent - safe to re-run. Fresh installs get all of this from oracle_init.sql.
-- Run once against the main ICP DB (as the ICP schema owner).
--
-- Oracle support shipped before this feature, so deployments created from the
-- original oracle_init.sql have the three access views reading group_user_mapping
-- directly. Step 4 is what those deployments need: without it the new tables are
-- populated but every permission check still ignores federated memberships.
--
-- Idempotency checks the specific expected object in the data dictionary before
-- creating it. A name collision with a DIFFERENT object type is NOT swallowed:
-- the CREATE then raises ORA-00955 so incompatible schema state surfaces.

-- ============================================================================
-- 1. SSO group mappings (IdP claim value -> ICP group)
-- ============================================================================

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'SSO_GROUP_MAPPINGS';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE TABLE sso_group_mappings (
            mapping_id VARCHAR2(36 CHAR) PRIMARY KEY,
            org_uuid NUMBER(10) DEFAULT 1 NOT NULL,
            issuer VARCHAR2(255 CHAR) NOT NULL,
            claim_name VARCHAR2(128 CHAR) NOT NULL,
            claim_value VARCHAR2(255 CHAR) NOT NULL,
            group_id VARCHAR2(36 CHAR) NOT NULL,
            project_uuid CHAR(36) NULL,
            integration_uuid CHAR(36) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_sso_group_mapping_org FOREIGN KEY (org_uuid) REFERENCES organizations (org_id) ON DELETE CASCADE,
            CONSTRAINT fk_sso_group_mapping_group FOREIGN KEY (group_id) REFERENCES user_groups (group_id) ON DELETE CASCADE,
            CONSTRAINT fk_sso_group_mapping_project FOREIGN KEY (project_uuid) REFERENCES projects (project_id) ON DELETE CASCADE,
            CONSTRAINT fk_sso_group_mapping_integration FOREIGN KEY (integration_uuid) REFERENCES components (component_id) ON DELETE CASCADE,
            CONSTRAINT chk_sso_mapping_integration_requires_project
                CHECK (integration_uuid IS NULL OR project_uuid IS NOT NULL),
            CONSTRAINT unique_sso_group_mapping UNIQUE (org_uuid, issuer, claim_name, claim_value, group_id)
        )';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_SGM_ORG_UUID';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_sgm_org_uuid ON sso_group_mappings (org_uuid)';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_SGM_ISSUER_CLAIM';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_sgm_issuer_claim ON sso_group_mappings (issuer, claim_name, claim_value)';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_SGM_GROUP_ID';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_sgm_group_id ON sso_group_mappings (group_id)';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_SGM_PROJECT_UUID';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_sgm_project_uuid ON sso_group_mappings (project_uuid)';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_SGM_INTEGRATION_UUID';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_sgm_integration_uuid ON sso_group_mappings (integration_uuid)';
    END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_sso_group_mappings_updated_at
BEFORE UPDATE ON sso_group_mappings
FOR EACH ROW
BEGIN
    :NEW.updated_at := CURRENT_TIMESTAMP;
END;
/

-- ============================================================================
-- 2. Federated group-user mappings (SSO-owned memberships)
-- ============================================================================

-- user_uuid is CHAR(36) to match users.user_id (Oracle FKs require matching
-- column types, ORA-02267) and to keep the UNION in
-- v_effective_group_user_mapping type-compatible with group_user_mapping.
DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'FEDERATED_GROUP_USER_MAPPING';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE TABLE federated_group_user_mapping (
            id NUMBER(19) GENERATED BY DEFAULT ON NULL AS IDENTITY PRIMARY KEY,
            org_uuid NUMBER(10) DEFAULT 1 NOT NULL,
            issuer VARCHAR2(255 CHAR) NOT NULL,
            user_uuid CHAR(36) NOT NULL,
            group_id VARCHAR2(36 CHAR) NOT NULL,
            claim_name VARCHAR2(128 CHAR) NOT NULL,
            claim_value VARCHAR2(255 CHAR) NOT NULL,
            last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_fed_group_user_org FOREIGN KEY (org_uuid) REFERENCES organizations (org_id) ON DELETE CASCADE,
            CONSTRAINT fk_fed_group_user_user FOREIGN KEY (user_uuid) REFERENCES users (user_id) ON DELETE CASCADE,
            CONSTRAINT fk_fed_group_user_group FOREIGN KEY (group_id) REFERENCES user_groups (group_id) ON DELETE CASCADE,
            CONSTRAINT unique_fed_group_user_claim UNIQUE (org_uuid, issuer, user_uuid, group_id, claim_name, claim_value)
        )';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_FGUM_USER_UUID';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_fgum_user_uuid ON federated_group_user_mapping (user_uuid)';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_FGUM_GROUP_ID';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_fgum_group_id ON federated_group_user_mapping (group_id)';
    END IF;
END;
/

DECLARE
    v_exists NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_exists FROM user_indexes WHERE index_name = 'IDX_FGUM_ISSUER_CLAIM';
    IF v_exists = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX idx_fgum_issuer_claim ON federated_group_user_mapping (issuer, claim_name, claim_value)';
    END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_fed_group_user_updated_at
BEFORE UPDATE ON federated_group_user_mapping
FOR EACH ROW
BEGIN
    :NEW.updated_at := CURRENT_TIMESTAMP;
END;
/

-- ============================================================================
-- 3. Effective membership view
-- ============================================================================
-- Must be created before the access views below, which reference it.
-- CREATE OR REPLACE is idempotent, so no drops are needed here (unlike H2 and
-- MSSQL, which have no CREATE OR REPLACE VIEW and must drop in dependency order).

-- View: Effective user group memberships from manual and SSO-owned sources
CREATE OR REPLACE VIEW v_effective_group_user_mapping AS
SELECT user_uuid, group_id
FROM group_user_mapping
UNION
SELECT user_uuid, group_id
FROM federated_group_user_mapping;

-- ============================================================================
-- 4. Rebind the access views onto the effective membership view
-- ============================================================================
-- Column lists are unchanged; only the membership source differs. Definitions
-- are kept identical to oracle_init.sql so a migrated schema matches a fresh one.

-- View: User's accessible projects
CREATE OR REPLACE VIEW v_user_project_access AS
-- Direct project-level access
SELECT DISTINCT
    gum.user_uuid,
    grm.project_uuid,
    p.name AS project_name,
    p.org_id AS org_uuid,
    grm.role_id,
    'project' AS access_level
FROM v_effective_group_user_mapping gum
INNER JOIN group_role_mapping grm ON gum.group_id = grm.group_id
INNER JOIN projects p ON grm.project_uuid = p.project_id
WHERE grm.project_uuid IS NOT NULL AND grm.integration_uuid IS NULL
UNION
-- Org-level access (inherits all projects)
SELECT DISTINCT
    gum.user_uuid,
    p.project_id AS project_uuid,
    p.name AS project_name,
    p.org_id AS org_uuid,
    grm.role_id,
    'org' AS access_level
FROM v_effective_group_user_mapping gum
INNER JOIN group_role_mapping grm ON gum.group_id = grm.group_id
INNER JOIN projects p ON grm.org_uuid = p.org_id
WHERE grm.org_uuid IS NOT NULL
  AND grm.project_uuid IS NULL
  AND grm.integration_uuid IS NULL
UNION
-- Integration-level access (project must be visible for navigation)
SELECT DISTINCT
    gum.user_uuid,
    grm.project_uuid,
    p.name AS project_name,
    p.org_id AS org_uuid,
    grm.role_id,
    'integration' AS access_level
FROM v_effective_group_user_mapping gum
INNER JOIN group_role_mapping grm ON gum.group_id = grm.group_id
INNER JOIN projects p ON grm.project_uuid = p.project_id
WHERE grm.integration_uuid IS NOT NULL;

-- View: User's accessible integrations
CREATE OR REPLACE VIEW v_user_integration_access AS
-- Direct integration-level access
SELECT DISTINCT
    gum.user_uuid,
    grm.integration_uuid,
    c.name AS integration_name,
    c.project_id AS project_uuid,
    grm.env_uuid,
    grm.role_id,
    'integration' AS access_level
FROM v_effective_group_user_mapping gum
INNER JOIN group_role_mapping grm ON gum.group_id = grm.group_id
INNER JOIN components c ON grm.integration_uuid = c.component_id
WHERE grm.integration_uuid IS NOT NULL
UNION
-- Project-level access (inherits all integrations in project)
SELECT DISTINCT
    gum.user_uuid,
    c.component_id AS integration_uuid,
    c.name AS integration_name,
    c.project_id AS project_uuid,
    grm.env_uuid,
    grm.role_id,
    'project' AS access_level
FROM v_effective_group_user_mapping gum
INNER JOIN group_role_mapping grm ON gum.group_id = grm.group_id
INNER JOIN components c ON grm.project_uuid = c.project_id
WHERE grm.project_uuid IS NOT NULL
  AND grm.integration_uuid IS NULL
UNION
-- Org-level access (inherits all integrations in all projects)
SELECT DISTINCT
    gum.user_uuid,
    c.component_id AS integration_uuid,
    c.name AS integration_name,
    c.project_id AS project_uuid,
    grm.env_uuid,
    grm.role_id,
    'org' AS access_level
FROM v_effective_group_user_mapping gum
INNER JOIN group_role_mapping grm ON gum.group_id = grm.group_id
INNER JOIN projects p ON grm.org_uuid = p.org_id
INNER JOIN components c ON p.project_id = c.project_id
WHERE grm.org_uuid IS NOT NULL
  AND grm.project_uuid IS NULL
  AND grm.integration_uuid IS NULL;

-- View: User's environment access/restrictions
CREATE OR REPLACE VIEW v_user_environment_access AS
SELECT DISTINCT
    gum.user_uuid,
    grm.env_uuid,
    grm.project_uuid,
    grm.integration_uuid,
    grm.role_id,
    CASE
        WHEN grm.integration_uuid IS NOT NULL THEN 'integration'
        WHEN grm.project_uuid IS NOT NULL THEN 'project'
        ELSE 'org'
    END AS scope_level
FROM v_effective_group_user_mapping gum
INNER JOIN group_role_mapping grm ON gum.group_id = grm.group_id
WHERE grm.env_uuid IS NOT NULL OR grm.org_uuid IS NOT NULL;
