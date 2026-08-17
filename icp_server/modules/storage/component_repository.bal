// Copyright (c) 2025, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
//
// WSO2 Inc. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//  http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

import icp_server.types as types;

import ballerina/log;
import ballerina/sql;
import ballerina/time;
import ballerina/uuid;

// Integration types ICP records, encoded as devant encodes them, keyed by the
// runtime that produces them — an integration type is always expressed in terms of
// one runtime, so a BI integration cannot carry an MI display_type. `service` is
// the legacy value written before integrations carried a type and predates the
// distinction, so it is accepted for either. Adding an integration type means
// adding its value under every runtime that offers it; a type one runtime cannot
// run is simply absent there, as Workflow is for MI.
final readonly & map<string[]> SUPPORTED_DISPLAY_TYPES_BY_RUNTIME = {
    // The workflow engine and its management API are Ballerina-only, so
    // `ballerinaWorkflow` has no MI counterpart.
    "BI": ["service", "ballerinaService", "scheduledTask", "ballerinaEventHandler", "ballerinaWorkflow"],
    "MI": ["service", "miApiService", "miCronjob", "miEventHandler"]
};

// Subtypes for the integration types that share a generic service display_type and
// cannot be told apart by it alone. File Integration is runtime-specific; AI Agent
// and MCP Server are not.
final readonly & map<string[]> SUPPORTED_SUB_TYPES_BY_RUNTIME = {
    "BI": ["ballerinaFileIntegration", "aiAgent", "MCP"],
    "MI": ["miFileIntegration", "aiAgent", "MCP"]
};

// display_types a subtype may accompany. A subtype exists only to disambiguate a
// generic service, so pairing one with e.g. `scheduledTask` is contradictory.
final readonly & map<string[]> SUB_TYPED_DISPLAY_TYPES_BY_RUNTIME = {
    "BI": ["service", "ballerinaService"],
    "MI": ["service", "miApiService"]
};

// The columns only constrain length, so reject values that could not have come
// from a real choice before they are persisted and later render as the wrong
// integration type. Validating against the runtime also rules out mismatches the
// length constraint cannot see, such as `miApiService` on a BI integration or
// `miApiService` paired with `ballerinaFileIntegration`.
isolated function validateIntegrationMetadata(string componentType, string displayType, string? componentSubType) returns error? {
    string[]? allowedDisplayTypes = SUPPORTED_DISPLAY_TYPES_BY_RUNTIME[componentType];
    if allowedDisplayTypes is () {
        return error(string `Unsupported runtime: ${componentType}`);
    }
    if allowedDisplayTypes.indexOf(displayType) is () {
        return error(string `Unsupported integration type ${displayType} for a ${componentType} integration`);
    }
    if componentSubType is string {
        string[] allowedSubTypes = SUPPORTED_SUB_TYPES_BY_RUNTIME[componentType] ?: [];
        if allowedSubTypes.indexOf(componentSubType) is () {
            return error(string `Unsupported integration subtype ${componentSubType} for a ${componentType} integration`);
        }
        string[] subTypedDisplayTypes = SUB_TYPED_DISPLAY_TYPES_BY_RUNTIME[componentType] ?: [];
        if subTypedDisplayTypes.indexOf(displayType) is () {
            return error(string `Integration subtype ${componentSubType} is not valid for integration type ${displayType}`);
        }
    }
    return ();
}

// Runtime recorded for a component. Integration metadata is validated against the
// persisted runtime on update, not against anything the caller supplies, since the
// runtime of an existing integration is not editable.
isolated function getComponentRuntimeType(string componentId) returns string|error {
    stream<record {|string component_type;|}, sql:Error?> componentStream = dbClient->query(`
        SELECT component_type FROM components WHERE component_id = ${componentId}
    `);

    record {|string component_type;|}[] componentRecords = check from record {|string component_type;|} component in componentStream
        select component;

    if componentRecords.length() == 0 {
        return error(string `Component with ID ${componentId} not found`);
    }
    return componentRecords[0].component_type;
}

// Create a new component
public isolated function createComponent(types:ComponentInput component) returns types:Component|error? {
    string componentId = uuid:createType1AsString();
    string componentTypeValue = (component?.componentType ?: types:BI).toString();

    // Use displayName if provided, otherwise fall back to name
    string displayName = component?.displayName ?: component.name;

    // "service" keeps pre-integration-type clients (and the DB default) working:
    // a component created without an explicit type is a plain service.
    string displayType = component?.displayType ?: "service";
    string? componentSubType = component?.componentSubType;

    check validateIntegrationMetadata(componentTypeValue, displayType, componentSubType);

    sql:ParameterizedQuery insertQuery = `INSERT INTO components (component_id, project_id, name, display_name, description, component_type, display_type, component_sub_type, created_by)
                                          VALUES (${componentId}, ${component.projectId}, ${component.name}, ${displayName}, ${component.description}, ${componentTypeValue}, ${displayType}, ${componentSubType}, ${component.createdBy})`;
    var result = dbClient->execute(insertQuery);
    if result is sql:Error {
        log:printError(string `Failed to create component: ${component.name}`, 'error = result);
        match classifySqlError(result) {
            DUPLICATE_KEY => { return error("A component with this name already exists in this project", result); }
            VALUE_TOO_LONG => { return error("The provided value exceeds the maximum allowed length", result); }
            FOREIGN_KEY_VIOLATION => { return error("The specified project does not exist", result); }
            _ => { return error("An unexpected error occurred. Please contact your administrator.", result); }
        }
    }
    return getComponentById(componentId);
}

// Check if a project has any components
public isolated function hasProjectComponents(string projectId) returns boolean|error {
    sql:ParameterizedQuery query = `SELECT COUNT(*) as component_count FROM components WHERE project_id = ${projectId}`;
    stream<record {int component_count;}, sql:Error?> resultStream = dbClient->query(query);

    record {|record {int component_count;} value;|}? streamResult = check resultStream.next();
    check resultStream.close();

    if streamResult is record {|record {int component_count;} value;|} {
        return streamResult.value.component_count > 0;
    }
    return false;
}

// Get all components with optional project filter
public isolated function getComponents(string? projectId, types:ComponentOptionsInput? options = ()) returns types:Component[]|error {
    types:Component[] components = [];
    sql:ParameterizedQuery whereClause = ` WHERE 1=1 `;
    sql:ParameterizedQuery whereConditions = ` `;

    if projectId is string {
        whereConditions = sql:queryConcat(whereConditions, ` AND c.project_id = ${projectId} `);
    }

    sql:ParameterizedQuery selectClause = `SELECT c.component_id, c.project_id, c.name as component_name, c.display_name as component_display_name, c.description as component_description, 
                                                  c.component_type, c.display_type as component_display_type, c.component_sub_type,
                                                  c.created_by as component_created_by, c.created_at as component_created_at, c.updated_at as component_updated_at,
                                                  c.updated_by as component_updated_by,
                                                  p.org_id as project_org_id, p.name as project_name, p.version as project_version, 
                                                  p.created_date as project_created_date, p.handler as project_handler, p.region as project_region,
                                                  p.description as project_description, p.default_deployment_pipeline_id as project_default_deployment_pipeline_id,
                                                  p.deployment_pipeline_ids as project_deployment_pipeline_ids, p.type as project_type,
                                                  p.git_provider as project_git_provider, p.git_organization as project_git_organization,
                                                  p.repository as project_repository, p.branch as project_branch, p.secret_ref as project_secret_ref,
                                                  p.created_by as project_created_by, p.updated_at as project_updated_at, p.updated_by as project_updated_by
                                           FROM components c 
                                           JOIN projects p ON c.project_id = p.project_id `;
    sql:ParameterizedQuery orderByClause = ` ORDER BY c.name ASC `;
    sql:ParameterizedQuery query = sql:queryConcat(selectClause, whereClause, whereConditions, orderByClause);

    stream<types:ComponentInDB, sql:Error?> componentStream = dbClient->query(query);

    check from types:ComponentInDB component in componentStream
        do {
            components.push(mapToComponent(component));
        };
    return components;
}

// Get all components for multiple projects (RBAC-aware batch query)
public isolated function getComponentsByProjectIds(string[] projectIds, types:ComponentOptionsInput? options = ()) returns types:Component[]|error {
    if projectIds.length() == 0 {
        return [];
    }

    types:Component[] components = [];

    sql:ParameterizedQuery selectClause = `SELECT c.component_id, c.project_id, c.name as component_name, c.display_name as component_display_name, c.description as component_description, 
                                                  c.component_type, c.display_type as component_display_type, c.component_sub_type,
                                                  c.created_by as component_created_by, c.created_at as component_created_at, c.updated_at as component_updated_at,
                                                  c.updated_by as component_updated_by,
                                                  p.org_id as project_org_id, p.name as project_name, p.version as project_version, 
                                                  p.created_date as project_created_date, p.handler as project_handler, p.region as project_region,
                                                  p.description as project_description, p.default_deployment_pipeline_id as project_default_deployment_pipeline_id,
                                                  p.deployment_pipeline_ids as project_deployment_pipeline_ids, p.type as project_type,
                                                  p.git_provider as project_git_provider, p.git_organization as project_git_organization,
                                                  p.repository as project_repository, p.branch as project_branch, p.secret_ref as project_secret_ref,
                                                  p.created_by as project_created_by, p.updated_at as project_updated_at, p.updated_by as project_updated_by
                                           FROM components c 
                                           JOIN projects p ON c.project_id = p.project_id 
                                           WHERE c.project_id IN (`;

    sql:ParameterizedQuery inClause = ``;
    foreach int i in 0 ..< projectIds.length() {
        if i > 0 {
            inClause = sql:queryConcat(inClause, `, `);
        }
        inClause = sql:queryConcat(inClause, `${projectIds[i]}`);
    }

    sql:ParameterizedQuery orderByClause = `) ORDER BY c.name ASC`;
    sql:ParameterizedQuery query = sql:queryConcat(selectClause, inClause, orderByClause);

    stream<types:ComponentInDB, sql:Error?> componentStream = dbClient->query(query);

    check from types:ComponentInDB component in componentStream
        do {
            components.push(mapToComponent(component));
        };

    return components;
}

// Get components by component IDs (integration IDs) using SQL IN clause
public isolated function getComponentsByIds(string[] componentIds) returns types:Component[]|error {
    if componentIds.length() == 0 {
        return [];
    }

    // Log warning for large lists (similar to getProjectsByIds)
    if componentIds.length() > 5000 {
        log:printWarn(string `Large component ID list: ${componentIds.length()} components`);
    }

    types:Component[] components = [];

    sql:ParameterizedQuery selectClause = `SELECT c.component_id, c.project_id, c.name as component_name, c.display_name as component_display_name, c.description as component_description, 
                                                  c.component_type, c.display_type as component_display_type, c.component_sub_type,
                                                  c.created_by as component_created_by, c.created_at as component_created_at, c.updated_at as component_updated_at,
                                                  c.updated_by as component_updated_by,
                                                  p.org_id as project_org_id, p.name as project_name, p.version as project_version, 
                                                  p.created_date as project_created_date, p.handler as project_handler, p.region as project_region,
                                                  p.description as project_description, p.default_deployment_pipeline_id as project_default_deployment_pipeline_id,
                                                  p.deployment_pipeline_ids as project_deployment_pipeline_ids, p.type as project_type,
                                                  p.git_provider as project_git_provider, p.git_organization as project_git_organization,
                                                  p.repository as project_repository, p.branch as project_branch, p.secret_ref as project_secret_ref,
                                                  p.created_by as project_created_by, p.updated_at as project_updated_at, p.updated_by as project_updated_by
                                           FROM components c 
                                           JOIN projects p ON c.project_id = p.project_id 
                                           WHERE c.component_id IN (`;

    sql:ParameterizedQuery inClause = ``;
    foreach int i in 0 ..< componentIds.length() {
        if i > 0 {
            inClause = sql:queryConcat(inClause, `, `);
        }
        inClause = sql:queryConcat(inClause, `${componentIds[i]}`);
    }

    sql:ParameterizedQuery orderByClause = `) ORDER BY c.name ASC`;
    sql:ParameterizedQuery query = sql:queryConcat(selectClause, inClause, orderByClause);

    stream<types:ComponentInDB, sql:Error?> componentStream = dbClient->query(query);

    check from types:ComponentInDB component in componentStream
        do {
            components.push(mapToComponent(component));
        };

    return components;
}

// Get project ID for a given component ID (lightweight query for access control)
public isolated function getProjectIdByComponentId(string componentId) returns string|error {
    stream<record {|string project_id;|}, sql:Error?> resultStream =
        dbClient->query(`SELECT project_id FROM components WHERE component_id = ${componentId}`);

    record {|string project_id;|}[] results =
        check from record {|string project_id;|} result in resultStream
        select result;

    if results.length() == 0 {
        return error(string `Component with id ${componentId} not found`);
    }

    return results[0].project_id;
}

// Get a specific component by ID
public isolated function getComponentById(string componentId) returns types:Component|error {
    stream<types:ComponentInDB, sql:Error?> componentStream =
        dbClient->query(`SELECT c.component_id, c.project_id, c.name as component_name, c.display_name as component_display_name, c.description as component_description, 
                                c.component_type, c.display_type as component_display_type, c.component_sub_type,
                                c.created_by as component_created_by, c.created_at as component_created_at, c.updated_at as component_updated_at,
                                c.updated_by as component_updated_by,
                                p.org_id as project_org_id, p.name as project_name, p.version as project_version, 
                                p.created_date as project_created_date, p.handler as project_handler, p.region as project_region,
                                p.description as project_description, p.default_deployment_pipeline_id as project_default_deployment_pipeline_id,
                                p.deployment_pipeline_ids as project_deployment_pipeline_ids, p.type as project_type,
                                p.git_provider as project_git_provider, p.git_organization as project_git_organization,
                                p.repository as project_repository, p.branch as project_branch, p.secret_ref as project_secret_ref,
                                p.created_by as project_created_by, p.updated_at as project_updated_at, p.updated_by as project_updated_by
                         FROM components c 
                         JOIN projects p ON c.project_id = p.project_id 
                         WHERE c.component_id = ${componentId}`);

    types:ComponentInDB[] componentRecords =
        check from types:ComponentInDB component in componentStream
        select component;

    if componentRecords.length() == 0 {
        log:printError(string `Component with id ${componentId} not found`);
        return error(string `Component with id ${componentId} not found`);
    }

    return mapToComponent(componentRecords[0]);
}

// Get component ID by name
public isolated function getComponentIdByName(string componentName) returns string|error {
    stream<record {|string component_id;|}, sql:Error?> componentStream = dbClient->query(`
        SELECT component_id FROM components WHERE name = ${componentName}
    `);

    record {|string component_id;|}[] componentRecords = check from record {|string component_id;|} component in componentStream
        select component;

    if componentRecords.length() == 0 {
        return error(string `Component ${componentName} not found.`);
    }
    return componentRecords[0].component_id;
}

// Get component name by component ID
public isolated function getComponentNameById(string componentId) returns string|error {
    stream<record {|string name;|}, sql:Error?> componentStream = dbClient->query(`
        SELECT name FROM components WHERE component_id = ${componentId}
    `);

    record {|string name;|}[] componentRecords = check from record {|string name;|} component in componentStream
        select component;

    if componentRecords.length() == 0 {
        return error(string `Component with ID ${componentId} not found`);
    }
    return componentRecords[0].name;
}

// Get a component by project ID and handler (component name)
public isolated function getComponentByProjectAndHandler(string projectId, string handler) returns types:Component?|error {
    stream<types:ComponentInDB, sql:Error?> componentStream =
        dbClient->query(`SELECT c.component_id, c.project_id, c.name as component_name, c.display_name as component_display_name, c.description as component_description,
                                c.component_type, c.display_type as component_display_type, c.component_sub_type,
                                c.created_by as component_created_by, c.created_at as component_created_at, c.updated_at as component_updated_at,
                                c.updated_by as component_updated_by,
                                p.org_id as project_org_id, p.name as project_name, p.version as project_version,
                                p.created_date as project_created_date, p.handler as project_handler, p.region as project_region,
                                p.description as project_description, p.default_deployment_pipeline_id as project_default_deployment_pipeline_id,
                                p.deployment_pipeline_ids as project_deployment_pipeline_ids, p.type as project_type,
                                p.git_provider as project_git_provider, p.git_organization as project_git_organization,
                                p.repository as project_repository, p.branch as project_branch, p.secret_ref as project_secret_ref,
                                p.created_by as project_created_by, p.updated_at as project_updated_at, p.updated_by as project_updated_by
                         FROM components c
                         JOIN projects p ON c.project_id = p.project_id
                         WHERE c.project_id = ${projectId} AND c.name = ${handler}`);

    types:ComponentInDB[] componentRecords =
        check from types:ComponentInDB component in componentStream
        select component;

    if componentRecords.length() == 0 {
        return ();
    }

    return mapToComponent(componentRecords[0]);
}

// Retrieve whether the Moesif metrics dashboards have been created for a
// component. Returns false when the component does not exist or the flag is unset.
public isolated function getComponentMoesifDashboardsCreated(string componentId) returns boolean|error {
    sql:ParameterizedQuery selectQuery =
        `SELECT dashboards_created FROM component_moesif_config WHERE component_id = ${componentId}`;
    boolean|sql:Error result = dbClient->queryRow(selectQuery);
    if result is sql:NoRowsError {
        return false;
    }
    if result is sql:Error {
        return result;
    }
    return result;
}

// Records whether the Moesif metrics dashboards have been created for a
// component. Upserts into component_moesif_config. Returns the number of affected rows.
public isolated function updateComponentMoesifDashboardsCreated(string componentId, boolean created) returns int|error {
    sql:ExecutionResult result;
    if dbType == MSSQL {
        result = check dbClient->execute(`
            MERGE INTO component_moesif_config AS target
            USING (VALUES (${componentId}, ${created}))
                   AS source (component_id, dashboards_created)
            ON (target.component_id = source.component_id)
            WHEN MATCHED THEN
                UPDATE SET dashboards_created = source.dashboards_created, updated_at = GETDATE()
            WHEN NOT MATCHED THEN
                INSERT (component_id, dashboards_created)
                VALUES (source.component_id, source.dashboards_created);
        `);
    } else if dbType == ORACLE {
        result = check dbClient->execute(`
            MERGE INTO component_moesif_config target
            USING (SELECT ${componentId} AS component_id, ${created} AS dashboards_created FROM dual) source
            ON (target.component_id = source.component_id)
            WHEN MATCHED THEN
                UPDATE SET dashboards_created = source.dashboards_created, updated_at = CURRENT_TIMESTAMP
            WHEN NOT MATCHED THEN
                INSERT (component_id, dashboards_created)
                VALUES (source.component_id, source.dashboards_created)
        `);
    } else if dbType == POSTGRESQL {
        result = check dbClient->execute(`
            INSERT INTO component_moesif_config (component_id, dashboards_created)
            VALUES (${componentId}, ${created})
            ON CONFLICT (component_id) DO UPDATE SET
                dashboards_created = EXCLUDED.dashboards_created,
                updated_at = CURRENT_TIMESTAMP
        `);
    } else {
        result = check dbClient->execute(`
            INSERT INTO component_moesif_config (component_id, dashboards_created)
            VALUES (${componentId}, ${created})
            ON DUPLICATE KEY UPDATE
                dashboards_created = VALUES(dashboards_created),
                updated_at = CURRENT_TIMESTAMP
        `);
    }
    return result.affectedRowCount ?: 0;
}

// Persist the Moesif embed details against a component after the metrics
// workspace is created: the workspace id (used to build the embed URL and mint
// workspace access tokens) and the Management API key (used to mint short-lived
// workspace access tokens on demand). Also flips dashboards_created to TRUE.
// Upserts into component_moesif_config. Returns the number of affected rows.
public isolated function updateComponentMoesifDashboardDetails(string componentId, string workspaceId,
        string managementKey) returns int|error {
    sql:ExecutionResult result;
    if dbType == MSSQL {
        result = check dbClient->execute(`
            MERGE INTO component_moesif_config AS target
            USING (VALUES (${componentId}, ${workspaceId}, ${managementKey}, ${true}))
                   AS source (component_id, workspace_id, management_key, dashboards_created)
            ON (target.component_id = source.component_id)
            WHEN MATCHED THEN
                UPDATE SET workspace_id = source.workspace_id, management_key = source.management_key,
                    dashboards_created = source.dashboards_created, updated_at = GETDATE()
            WHEN NOT MATCHED THEN
                INSERT (component_id, workspace_id, management_key, dashboards_created)
                VALUES (source.component_id, source.workspace_id, source.management_key, source.dashboards_created);
        `);
    } else if dbType == ORACLE {
        result = check dbClient->execute(`
            MERGE INTO component_moesif_config target
            USING (SELECT ${componentId} AS component_id, ${workspaceId} AS workspace_id,
                          ${managementKey} AS management_key, ${true} AS dashboards_created FROM dual) source
            ON (target.component_id = source.component_id)
            WHEN MATCHED THEN
                UPDATE SET workspace_id = source.workspace_id, management_key = source.management_key,
                    dashboards_created = source.dashboards_created, updated_at = CURRENT_TIMESTAMP
            WHEN NOT MATCHED THEN
                INSERT (component_id, workspace_id, management_key, dashboards_created)
                VALUES (source.component_id, source.workspace_id, source.management_key, source.dashboards_created)
        `);
    } else if dbType == POSTGRESQL {
        result = check dbClient->execute(`
            INSERT INTO component_moesif_config (component_id, workspace_id, management_key, dashboards_created)
            VALUES (${componentId}, ${workspaceId}, ${managementKey}, ${true})
            ON CONFLICT (component_id) DO UPDATE SET
                workspace_id = EXCLUDED.workspace_id,
                management_key = EXCLUDED.management_key,
                dashboards_created = EXCLUDED.dashboards_created,
                updated_at = CURRENT_TIMESTAMP
        `);
    } else {
        result = check dbClient->execute(`
            INSERT INTO component_moesif_config (component_id, workspace_id, management_key, dashboards_created)
            VALUES (${componentId}, ${workspaceId}, ${managementKey}, ${true})
            ON DUPLICATE KEY UPDATE
                workspace_id = VALUES(workspace_id),
                management_key = VALUES(management_key),
                dashboards_created = VALUES(dashboards_created),
                updated_at = CURRENT_TIMESTAMP
        `);
    }
    return result.affectedRowCount ?: 0;
}

// Retrieve the Moesif workspace id + Management API key stored against a
// component so a caller can mint a workspace access token and build the embed
// URL. Returns () for either field when it has not been set.
public isolated function getComponentMoesifEmbedDetails(string componentId)
        returns record {|string? workspaceId; string? managementKey;|}?|error {
    sql:ParameterizedQuery selectQuery =
        `SELECT workspace_id, management_key FROM component_moesif_config WHERE component_id = ${componentId}`;
    record {|string? workspace_id; string? management_key;|}|sql:Error result = dbClient->queryRow(selectQuery);
    if result is sql:NoRowsError {
        return ();
    }
    if result is sql:Error {
        return result;
    }
    return {workspaceId: result.workspace_id, managementKey: result.management_key};
}

// Delete a component by ID
public isolated function deleteComponent(string componentId) returns error? {
    // Revoke all org secrets bound to this component (detaches runtimes + deletes secrets).
    check revokeAllSecretsForComponent(componentId);

    // Explicitly delete dependent mi_runtime_control_commands rows.
    // Required for MSSQL where ON DELETE CASCADE is not used (multiple cascade path restriction);
    // safe to do unconditionally for all other dialects as well.
    sql:ParameterizedQuery deleteCmdQuery = `DELETE FROM mi_runtime_control_commands WHERE component_id = ${componentId}`;
    var cmdResult = dbClient->execute(deleteCmdQuery);
    if cmdResult is sql:Error {
        log:printError(string `Failed to delete mi_runtime_control_commands for component ${componentId}`, 'error = cmdResult);
        return error("An unexpected error occurred. Please contact your administrator.", cmdResult);
    }

    // Explicitly delete group_role_mapping rows scoped to this integration (component).
    // Required for MSSQL where fk_grp_role_integration is ON DELETE NO ACTION (multiple
    // cascade path restriction); safe to do unconditionally for all other dialects as well.
    sql:ParameterizedQuery deleteRoleMappingQuery = `DELETE FROM group_role_mapping WHERE integration_uuid = ${componentId}`;
    var roleMappingResult = dbClient->execute(deleteRoleMappingQuery);
    if roleMappingResult is sql:Error {
        log:printError(string `Failed to delete group role mappings for component ${componentId}`, 'error = roleMappingResult);
        return error("An unexpected error occurred. Please contact your administrator.", roleMappingResult);
    }
    log:printInfo(string `Removed all role mappings scoped to component`, componentId = componentId);

    sql:ParameterizedQuery deleteQuery = `DELETE FROM components WHERE component_id = ${componentId}`;
    var result = dbClient->execute(deleteQuery);
    if result is sql:Error {
        log:printError(string `Failed to delete component ${componentId}`, 'error = result);
        match classifySqlError(result) {
            FOREIGN_KEY_VIOLATION => { return error("Cannot delete component because it has dependent resources", result); }
            _ => { return error("An unexpected error occurred. Please contact your administrator.", result); }
        }
    }
    log:printInfo(string `Successfully deleted component ${componentId}`);
    return ();
}

// Update component name and/or description
// `displayType` and `componentSubType` are written as a pair: a subtype only
// qualifies a display_type, so passing a displayType clears any stale subtype when
// componentSubType is nil. Passing displayType as nil leaves both columns alone.
public isolated function updateComponent(string componentId, string? name, string? displayName, string? description, string updatedBy,
        string? displayType = (), string? componentSubType = ()) returns error? {
    sql:ParameterizedQuery whereClause = ` WHERE component_id = ${componentId} `;
    sql:ParameterizedQuery updateFields = ` SET updated_at = CURRENT_TIMESTAMP, updated_by = ${updatedBy} `;

    if name is string {
        updateFields = sql:queryConcat(updateFields, `, name = ${name} `);
    }
    if displayName is string {
        updateFields = sql:queryConcat(updateFields, `, display_name = ${displayName} `);
    }
    if description is string {
        updateFields = sql:queryConcat(updateFields, `, description = ${description} `);
    }
    if displayType is string {
        // The persisted runtime, not the caller's — technology is not editable.
        string runtimeType = check getComponentRuntimeType(componentId);
        check validateIntegrationMetadata(runtimeType, displayType, componentSubType);
        updateFields = sql:queryConcat(updateFields, `, display_type = ${displayType}, component_sub_type = ${componentSubType} `);
    }

    sql:ParameterizedQuery updateQuery = sql:queryConcat(`UPDATE components `, updateFields, whereClause);
    var result = dbClient->execute(updateQuery);
    if result is sql:Error {
        log:printError(string `Failed to update component ${componentId}`, 'error = result);
        match classifySqlError(result) {
            DUPLICATE_KEY => { return error("A component with this name already exists in this project", result); }
            VALUE_TOO_LONG => { return error("The provided value exceeds the maximum allowed length", result); }
            _ => { return error("An unexpected error occurred. Please contact your administrator.", result); }
        }
    }
    log:printInfo(string `Successfully updated component ${componentId}`);

    if name is string {
        error? cascadeErr = updateOrgSecretsComponentName(componentId, name);
        if cascadeErr is error {
            log:printError(string `Failed to cascade component name change to org_secrets for ${componentId}`, 'error = cascadeErr);
        }
    }

    return ();
}

// Get component deployment information from runtimes table
public isolated function getComponentDeployment(string componentId, string environmentId, string versionId) returns types:ComponentDeployment?|error {
    log:printDebug(string `Fetching deployment info for component: ${componentId}, environment: ${environmentId}`);

    sql:ParameterizedQuery query = `
        SELECT runtime_id, runtime_type, status, environment_id, project_id, component_id, version,
               platform_name, platform_version, platform_home, os_name, os_version,
               registration_time, last_heartbeat
        FROM runtimes
        WHERE component_id = ${componentId} AND environment_id = ${environmentId}
        ORDER BY last_heartbeat DESC
    `;

    query = appendLimitClause(query, 1);

    stream<types:RuntimeDBRecord, sql:Error?> runtimeStream = dbClient->query(query);

    types:RuntimeDBRecord[] runtimeRecords = check from types:RuntimeDBRecord runtimeRecord in runtimeStream
        select runtimeRecord;

    if runtimeRecords.length() == 0 {
        log:printDebug(string `No runtime found for component ${componentId} in environment ${environmentId}`);
        return ();
    }

    types:RuntimeDBRecord runtime = runtimeRecords[0];
    types:Component component = check getComponentById(componentId);

    int configCount = 0;
    types:Service[] services = check getServicesForRuntime(runtime.runtime_id);
    types:Listener[] listeners = check getListenersForRuntime(runtime.runtime_id);
    configCount = services.length() + listeners.length();

    types:BuildInfo buildInfo = {
        buildId: runtime.runtime_id,
        deployedAt: runtime?.last_heartbeat is time:Utc ? time:utcToString(<time:Utc>runtime?.last_heartbeat) : (),
        'commit: (),
        sourceConfigMigrationStatus: (),
        runId: runtime.runtime_id
    };

    types:ComponentDeployment deployment = {
        environmentId: environmentId,
        configCount: configCount,
        apiId: component?.apiId,
        releaseId: runtime.runtime_id,
        apiRevision: (),
        build: buildInfo,
        imageUrl: "",
        invokeUrl: "",
        versionId: versionId,
        deploymentStatus: runtime.status,
        deploymentStatusV2: runtime.status,
        version: runtime?.version,
        cron: (),
        cronTimezone: ()
    };

    log:printDebug(string `Retrieved deployment info for component ${componentId}`,
            status = runtime.status,
            configCount = configCount);

    return deployment;
}

// Get artifact types for a component
public isolated function getArtifactTypesForComponent(string componentId, types:RuntimeType componentType, string? environmentId = ()) returns types:ArtifactTypeCount[]|error {
    types:ArtifactTypeCount[] artifactTypes = [];

    sql:ParameterizedQuery runtimeQuery = `SELECT DISTINCT runtime_id FROM runtimes WHERE component_id = ${componentId}`;
    if environmentId is string {
        runtimeQuery = sql:queryConcat(runtimeQuery, ` AND environment_id = ${environmentId}`);
    }
    stream<record {|string runtime_id;|}, sql:Error?> runtimeStream = dbClient->query(runtimeQuery);

    string[] runtimeIds = [];
    check from record {|string runtime_id;|} runtime in runtimeStream
        do {
            runtimeIds.push(runtime.runtime_id);
        };

    if runtimeIds.length() == 0 {
        return [];
    }

    sql:ParameterizedQuery runtimeInClause = ` WHERE runtime_id IN (`;
    foreach int i in 0 ..< runtimeIds.length() {
        if i > 0 {
            runtimeInClause = sql:queryConcat(runtimeInClause, `, `);
        }
        runtimeInClause = sql:queryConcat(runtimeInClause, `${runtimeIds[i]}`);
    }
    runtimeInClause = sql:queryConcat(runtimeInClause, `) `);

    sql:ParameterizedQuery countQuery = `SELECT COUNT(*) as count FROM `;

    int serviceCount = check getCount(sql:queryConcat(countQuery, `bi_service_artifacts `, runtimeInClause));
    if serviceCount > 0 {
        artifactTypes.push({artifactType: types:SERVICE, artifactCount: serviceCount});
    }

    int listenerCount = check getCount(sql:queryConcat(countQuery, `bi_runtime_listener_artifacts `, runtimeInClause));
    if listenerCount > 0 {
        artifactTypes.push({artifactType: types:LISTENER, artifactCount: listenerCount});
    }

    if componentType == types:MI {
        int apiCount = check getCount(sql:queryConcat(countQuery, `mi_api_artifacts `, runtimeInClause));
        if apiCount > 0 {
            artifactTypes.push({artifactType: types:RESTAPI, artifactCount: apiCount});
        }

        int proxyCount = check getCount(sql:queryConcat(countQuery, `mi_proxy_service_artifacts `, runtimeInClause));
        if proxyCount > 0 {
            artifactTypes.push({artifactType: types:PROXYSERVICE, artifactCount: proxyCount});
        }

        int endpointCount = check getCount(sql:queryConcat(countQuery, `mi_endpoint_artifacts `, runtimeInClause));
        if endpointCount > 0 {
            artifactTypes.push({artifactType: types:ENDPOINT, artifactCount: endpointCount});
        }

        int inboundCount = check getCount(sql:queryConcat(countQuery, `mi_inbound_endpoint_artifacts `, runtimeInClause));
        if inboundCount > 0 {
            artifactTypes.push({artifactType: types:INBOUNDENDPOINT, artifactCount: inboundCount});
        }

        int sequenceCount = check getCount(sql:queryConcat(countQuery, `mi_sequence_artifacts `, runtimeInClause));
        if sequenceCount > 0 {
            artifactTypes.push({artifactType: types:SEQUENCE, artifactCount: sequenceCount});
        }

        int taskCount = check getCount(sql:queryConcat(countQuery, `mi_task_artifacts `, runtimeInClause));
        if taskCount > 0 {
            artifactTypes.push({artifactType: types:TASK, artifactCount: taskCount});
        }

        int templateCount = check getCount(sql:queryConcat(countQuery, `mi_template_artifacts `, runtimeInClause));
        if templateCount > 0 {
            artifactTypes.push({artifactType: types:TEMPLATE, artifactCount: templateCount});
        }

        int storeCount = check getCount(sql:queryConcat(countQuery, `mi_message_store_artifacts `, runtimeInClause));
        if storeCount > 0 {
            artifactTypes.push({artifactType: types:MESSAGESTORE, artifactCount: storeCount});
        }

        int processorCount = check getCount(sql:queryConcat(countQuery, `mi_message_processor_artifacts `, runtimeInClause));
        if processorCount > 0 {
            artifactTypes.push({artifactType: types:MESSAGEPROCESSOR, artifactCount: processorCount});
        }

        int entryCount = check getCount(sql:queryConcat(countQuery, `mi_local_entry_artifacts `, runtimeInClause));
        if entryCount > 0 {
            artifactTypes.push({artifactType: types:LOCALENTRY, artifactCount: entryCount});
        }

        int dataServiceCount = check getCount(sql:queryConcat(countQuery, `mi_data_service_artifacts `, runtimeInClause));
        if dataServiceCount > 0 {
            artifactTypes.push({artifactType: types:DATASERVICE, artifactCount: dataServiceCount});
        }

        int appCount = check getCount(sql:queryConcat(countQuery, `mi_composite_app_artifacts `, runtimeInClause));
        if appCount > 0 {
            artifactTypes.push({artifactType: types:COMPOSITEAPP, artifactCount: appCount});
        }

        int sourceCount = check getCount(sql:queryConcat(countQuery, `mi_data_source_artifacts `, runtimeInClause));
        if sourceCount > 0 {
            artifactTypes.push({artifactType: types:DATASOURCE, artifactCount: sourceCount});
        }

        int connectorCount = check getCount(sql:queryConcat(countQuery, `mi_connector_artifacts `, runtimeInClause));
        if connectorCount > 0 {
            artifactTypes.push({artifactType: types:CONNECTOR, artifactCount: connectorCount});
        }

        int resourceCount = check getCount(sql:queryConcat(countQuery, `mi_registry_resource_artifacts `, runtimeInClause));
        if resourceCount > 0 {
            artifactTypes.push({artifactType: types:REGISTRYRESOURCE, artifactCount: resourceCount});
        }
    }

    return artifactTypes;
}

// Helper function to map database record to Component type
isolated function mapToComponent(types:ComponentInDB component) returns types:Component {
    return {
        id: component.component_id,
        projectId: component.project_id,
        orgHandler: component.project_handler,
        orgId: component.project_org_id,
        name: component.component_name,
        handler: component.component_name,
        displayName: component.component_display_name ?: component.component_name,
        displayType: component.component_display_type ?: "service",
        description: component.component_description,
        status: "active",
        initStatus: "completed",
        version: "v1.0.0",
        createdAt: component.component_created_at ?: "",
        lastBuildDate: component.component_updated_at,
        updatedAt: component.component_updated_at,
        componentSubType: component.component_sub_type,
        componentType: component.component_type == "MI" ? types:MI : types:BI,
        labels: (),
        isSystemComponent: false,
        apiVersions: [],
        deploymentTracks: [],
        gitProvider: component.project_git_provider,
        gitOrganization: component.project_git_organization,
        gitRepository: component.project_repository,
        branch: component.project_branch,
        endpoints: [],
        environmentVariables: [],
        secrets: [],
        componentId: component.component_id,
        project: {
            id: component.project_id,
            orgId: component.project_org_id,
            name: component.project_name,
            version: component.project_version,
            createdDate: component.project_created_date,
            handler: component.project_handler,
            region: component.project_region,
            description: component.project_description,
            'type: component.project_type,
            gitProvider: component.project_git_provider,
            gitOrganization: component.project_git_organization,
            repository: component.project_repository,
            branch: component.project_branch,
            secretRef: component.project_secret_ref,
            createdBy: component.project_created_by,
            updatedAt: component.project_updated_at,
            updatedBy: component.project_updated_by
        },
        createdBy: getDisplayNameById(component.component_created_by),
        updatedBy: getDisplayNameById(component.component_updated_by)
    };
}
