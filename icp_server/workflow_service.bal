// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import icp_server.auth;
import icp_server.storage;
import icp_server.types;

import ballerina/http;
import ballerina/log;

// ── Workflow management service ──────────────────────────────────────────────
// Serves the frontend's workflow management requests over the heartbeat command
// tunnel (workflow_tunnel.bal): each request is mapped to a management operation,
// queued for the component+environment's leader runtime — a RUNNING runtime that
// advertised the workflowCommands capability — executed in-process by the
// runtime's ICP bridge, and answered with the result posted back on
// POST /icp/commandResult. No network path into the integration or its Temporal
// server exists: the runtime exposes no management port and needs no API key.
//
// Frontend → GET/POST https://<icp>/icp/workflow/{componentId}/{environmentId}/<wf-path>
//          → tunneled as {operation, params, identity} to the leader runtime
//
// The caller's identity travels in the command: the user id plus the ICP role
// names (each escaped, see escapeRoleName, plus a synthetic `admin` role for
// super-admins) so the workflow runtime can do its own human-task authorization.

// Resolves workflow definitions for the given component+environment from the workflow
// metadata stored off heartbeats (bi_workflow_metadata) and maps them to the Workflow
// artifact shape used by the frontend — no call into the integration, and definitions
// stay available as long as any RUNNING runtime of the component reported metadata.
// Returns [] when none has. Used by the GraphQL `workflowsByEnvironmentAndComponent`
// resolver.
isolated function fetchWorkflowDefinitions(string componentId, string environmentId) returns types:Workflow[]|error {
    types:Workflow[]? stored = check workflowDefinitionsFromStoredMetadata(componentId, environmentId);
    return stored ?: [];
}

// Builds the Workflow artifact list from the stored workflow metadata, or () when no
// RUNNING runtime of the component+environment has published metadata. Definitions are
// deduped across runtimes by workflow type; a definition's worker count is the number
// of RUNNING runtimes whose metadata declares it.
isolated function workflowDefinitionsFromStoredMetadata(string componentId, string environmentId)
        returns types:Workflow[]?|error {
    types:WorkflowMetadataRecord[] metadataRecords =
        check storage:getWorkflowMetadataForComponentEnv(componentId, environmentId);
    if metadataRecords.length() == 0 {
        return ();
    }

    // workflowType → [inputSchema, workerCount]
    map<[string?, int]> definitionsByType = {};
    foreach types:WorkflowMetadataRecord metadataRecord in metadataRecords {
        json|error document = metadataRecord.metadata.fromJsonString();
        if document is error {
            log:printWarn(string `Ignoring unparseable workflow metadata of runtime ${metadataRecord.runtimeId}`,
                    'error = document);
            continue;
        }
        json|error definitionsJson = document.definitions;
        if definitionsJson !is json[] {
            continue;
        }
        foreach json definitionJson in definitionsJson {
            types:WorkflowDefinition|error def = definitionJson.cloneWithType();
            if def is error {
                continue;
            }
            [string?, int]? existing = definitionsByType[def.workflowType];
            if existing is [string?, int] {
                definitionsByType[def.workflowType] = [existing[0], existing[1] + 1];
            } else {
                definitionsByType[def.workflowType] = [def?.inputSchema, 1];
            }
        }
    }
    if definitionsByType.length() == 0 {
        return ();
    }

    // Definitions are shared across the component+environment's runtimes; attach them for the UI.
    types:Runtime[] runtimes = check storage:getRuntimes((), (), environmentId, (), componentId);
    types:ArtifactRuntimeInfo[] runtimeInfos = from var r in runtimes
        select {runtimeId: r.runtimeId, runtimeName: r?.runtimeName, status: r.status};

    types:Workflow[] result = [];
    foreach [string, [string?, int]] [workflowType, [inputSchema, workerCount]] in definitionsByType.entries() {
        // A stored definition comes from a RUNNING runtime's registry, so it is active.
        result.push({
            name: workflowType,
            isActive: true,
            workerCount: workerCount,
            inputSchema: inputSchema,
            state: types:ENABLED,
            runtimes: runtimeInfos
        });
    }
    return result;
}

// Escapes a role name for the comma-joined role list in the tunneled command identity
// (`,` → `%2C`). Role names are user-created, so a literal comma would otherwise let a
// role like `Foo,admin` inject the synthetic `admin` role when the runtime splits the
// joined list. Names without commas pass through unchanged, so runtime-side role
// matching is unaffected. The frontend reverses this for display (unescapeRoleName in
// workflow/helpers.ts).
isolated function escapeRoleName(string roleName) returns string {
    return re `,`.replaceAll(roleName, "%2C");
}

isolated function workflowErrorResponse(int statusCode, string message) returns http:Response {
    http:Response res = new;
    res.statusCode = statusCode;
    res.setJsonPayload({"error": {"message": message}});
    return res;
}

// Performs auth, leader resolution, and tunneled execution for one workflow management
// request; returns the response to relay to the caller.
function handleWorkflowRequest(string componentId, string environmentId, string[] wfPath, http:Request req) returns http:Response {
    // 1. Identify the caller from the (already JWT-validated) Authorization header.
    string|http:HeaderNotFoundError authHeader = req.getHeader("Authorization");
    if authHeader is http:HeaderNotFoundError {
        return workflowErrorResponse(401, "Authorization header missing");
    }
    types:UserContextV2|error userContext = auth:extractUserContextV2(authHeader);
    if userContext is error {
        return workflowErrorResponse(401, "Invalid token: " + userContext.message());
    }

    // 2. Authorize with the dedicated workflow permissions (scoped to the integration).
    //    - human-tasks: browsing needs view_human_tasks; acting needs manage_human_tasks.
    //    - everything else (workflows lifecycle, definitions, review-activities):
    //      browsing needs view_workflows; any mutation needs manage_workflows.
    string|error projectId = storage:getProjectIdByComponentId(componentId);
    if projectId is error {
        return workflowErrorResponse(404, "Component not found: " + componentId);
    }
    types:AccessScope scope = {
        orgUuid: 1,
        projectUuid: projectId,
        integrationUuid: componentId,
        envUuid: environmentId
    };
    string method = req.method;
    string firstSeg = wfPath.length() > 0 ? wfPath[0] : "";
    string[] allowedPermissions;
    if firstSeg == "human-tasks" {
        allowedPermissions = method == http:GET
            ? [auth:PERMISSION_WORKFLOW_VIEW_HUMAN_TASKS, auth:PERMISSION_WORKFLOW_MANAGE_HUMAN_TASKS]
            : [auth:PERMISSION_WORKFLOW_MANAGE_HUMAN_TASKS];
    } else {
        allowedPermissions = method == http:GET
            ? [auth:PERMISSION_WORKFLOW_VIEW_WORKFLOWS, auth:PERMISSION_WORKFLOW_MANAGE_WORKFLOWS]
            : [auth:PERMISSION_WORKFLOW_MANAGE_WORKFLOWS];
    }
    boolean|error permitted = auth:hasAnyPermission(userContext.userId, allowedPermissions, scope);
    if permitted is error {
        return workflowErrorResponse(500, "Authorization check failed: " + permitted.message());
    }
    if !permitted {
        log:printWarn("Workflow request access denied", userId = userContext.userId, componentId = componentId, method = method);
        return workflowErrorResponse(403, "Access denied");
    }

    // 3. Resolve the caller's role names — tunneled in the command identity (each
    //    escaped, see escapeRoleName) with the synthetic admin role for super admins.
    string[]|error roleNames = storage:getAllUserRoleNames(userContext.userId);
    if roleNames is error {
        return workflowErrorResponse(500, "Failed to resolve user roles: " + roleNames.message());
    }
    string[] escapedRoles = roleNames.map(escapeRoleName);
    boolean|error superAdmin = auth:isSuperAdmin(userContext.userId);
    if superAdmin is boolean && superAdmin {
        escapedRoles.push("admin");
    }

    // 4. Map the request to a management operation and tunnel it to the leader
    //    runtime — a RUNNING runtime of this component+environment that advertised
    //    the workflowCommands capability.
    string?|error tunnelTarget = selectWorkflowCommandTarget(componentId, environmentId);
    if tunnelTarget is error {
        return workflowErrorResponse(500, "Failed to resolve workflow runtime: " + tunnelTarget.message());
    }
    if tunnelTarget is () {
        return workflowErrorResponse(503, "No running workflow runtime can serve this environment's workflow requests");
    }
    map<json> body = {};
    if method == http:POST {
        json|error rawBody = req.getJsonPayload();
        if rawBody is map<json> {
            body = rawBody;
        }
    }
    [string, map<json>]? operation = mapWorkflowRequestToOperation(
            method, wfPath, workflowQueryParams(req.getQueryParams()), body);
    if operation is () {
        return workflowErrorResponse(404, "Unknown workflow operation: " + string:'join("/", ...wfPath));
    }
    return executeTunneledWorkflowCommand(tunnelTarget, operation[0], operation[1],
            userContext.userId, escapedRoles);
}

@http:ServiceConfig {
    auth: [
        {
            jwtValidatorConfig: {
                issuer: frontendJwtIssuer,
                audience: frontendJwtAudience,
                signatureConfig: {
                    secret: resolvedFrontendJwtHMACSecret
                }
            }
        }
    ],
    cors: {
        allowOrigins: normalizedCorsAllowedOrigins,
        allowHeaders: ["Content-Type", "Authorization"]
    }
}
service /icp/workflow on httpListener {

    function init() {
        log:printInfo("Workflow management service started at " + serverHost + ":" + serverPort.toString());
    }

    // {componentId}/{environmentId} pin the target scope; the remaining segments and
    // query map to the tunneled management operation. Explicit get/post accessors
    // (not 'default) so CORS preflight OPTIONS is auto-handled by the listener and not
    // subjected to service auth. The workflow management API only uses GET and POST.
    resource function get [string componentId]/[string environmentId]/[string... wfPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(handleWorkflowRequest(componentId, environmentId, wfPath, req));
    }

    resource function post [string componentId]/[string environmentId]/[string... wfPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(handleWorkflowRequest(componentId, environmentId, wfPath, req));
    }
}
