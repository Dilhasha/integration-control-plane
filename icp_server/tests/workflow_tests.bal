// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import icp_server.storage;
import icp_server.types;

import ballerina/http;
import ballerina/test;
import ballerina/time;

// =============================================================================
// Workflow support tests
// =============================================================================
// Workflow management runs over the heartbeat command tunnel (workflow_tunnel.bal);
// this file covers the parts around it:
//   1. Unit — escapeRoleName injection guard (role names travel escaped in the
//      tunneled command identity).
//   2. Service — /icp/workflow auth, RBAC, and the 503 when no tunnel-capable
//      runtime serves the component+environment.
//   3. GraphQL — workflowsByEnvironmentAndComponent resolver reading definitions
//      from the workflow metadata stored off heartbeats.
// The positive tunnel path (command delivery, identity propagation, result relay)
// is covered end to end in workflow_tunnel_tests.bal.
//
// Seed data used (h2_test_data.sql / mysql_test_data_init.sql):
//   - Project 1 / Component 1 / Dev env — RUNNING runtime without workflow support.
//   - Project 1 / Component 2 / Prod env — FAILED runtime (no usable target).
//   - orgdev (Developer, org scope)     → view_workflows, view/manage_human_tasks
//   - projectadmin (Admin, Project 1)   → manage_workflows
//   - readonlyviewer (Viewer, Comp 1)   → view_human_tasks only
// =============================================================================

// Runtime registered with workflow metadata (but no command capability) for the
// GraphQL definitions test. Unique name so it never collides with seeded runtimes.
const string WF_RUNTIME_ID = "aa000002-test-test-test-000000000001";

const string WF_COMPONENT_2_ID = "640e8400-e29b-41d4-a716-446655440002";
const string WF_PROD_ENV_ID = "750e8400-e29b-41d4-a716-446655440002";

// Seeded super admin — used as created_by for org secrets (FK to users).
const string WF_ADMIN_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
// Seeded Viewer-role user scoped to Component 1 (view_human_tasks only).
const string WF_VIEWER_USER_ID = "770e8400-e29b-41d4-a716-446655440005";

// Token for readonlyviewer — permissions are resolved from the DB, not the token.
string wfViewerToken = "";

// =============================================================================
// Helpers / fixtures
// =============================================================================

// HTTP client hitting the real workflow service on the shared TLS listener.
final http:Client wfProxyClient = check new ("https://localhost:9446/icp/workflow",
    secureSocket = {
        cert: {
            path: truststorePath,
            password: truststorePassword
        }
    }
);

function buildWorkflowHeartbeat(string runtimeId, string runtimeName, string componentId,
        string environmentId) returns types:Heartbeat {
    return {
        runtimeId: runtimeId,
        runtime: runtimeName,
        runtimeType: "BI",
        status: "RUNNING",
        environment: environmentId,
        project: PROJECT_1_ID,
        component: componentId,
        version: "1.0.0",
        nodeInfo: {platformName: "ballerina"},
        artifacts: {},
        runtimeHash: "wf-test-hash-" + runtimeId,
        timestamp: time:utcNow()
    };
}

@test:BeforeGroups {value: ["workflow"]}
function setupWorkflowTests() returns error? {
    wfViewerToken = check generateV2Token(WF_VIEWER_USER_ID, "readonlyviewer", []);
}

@test:AfterGroups {value: ["workflow"], alwaysRun: true}
function teardownWorkflowTests() {
    cleanupRuntime(WF_RUNTIME_ID);
}

function wfProxyGet(string path, string? token) returns http:Response|error {
    if token is () {
        return wfProxyClient->get(path);
    }
    return wfProxyClient->get(path, {"Authorization": createAuthHeader(token)});
}

// =============================================================================
// 1. Unit test — role-name escaping for the tunneled command identity
// =============================================================================

@test:Config {
    groups: ["workflow"]
}
function testEscapeRoleName() {
    test:assertEquals(escapeRoleName("Developer"), "Developer", "Names without commas pass through unchanged");
    test:assertEquals(escapeRoleName("Foo,admin"), "Foo%2Cadmin", "Commas must be escaped to prevent role injection");
    test:assertEquals(escapeRoleName(",,"), "%2C%2C", "Every comma occurrence must be escaped");
}

// =============================================================================
// 2. Service tests — /icp/workflow auth, RBAC, and availability
// =============================================================================
// None of the targeted components have a tunnel-capable runtime, so requests that
// pass RBAC end in the 503 "no runtime" answer — which is exactly what these tests
// need: they prove where each request stops.

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowServiceRejectsMissingToken() returns error? {
    http:Response resp = check wfProxyGet(string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/definitions`, ());
    assertStatusCode(resp.statusCode, 401, "Request without a bearer token must be rejected by listener auth");
}

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowServiceDeniesUserWithoutPermissions() returns error? {
    http:Response resp = check wfProxyGet(string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/definitions`, slNoPermToken);
    assertStatusCode(resp.statusCode, 403, "User without workflow permissions must get 403");
}

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowServiceUnknownComponentReturns404() returns error? {
    http:Response resp = check wfProxyGet(
            string `/00000000-0000-0000-0000-00000000dead/${DEV_ENV_ID}/definitions`, orgDevToken);
    assertStatusCode(resp.statusCode, 404, "Unknown component must return 404");
}

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowServiceReturns503WithoutCapableRuntime() returns error? {
    // Component 2 / Prod only has a FAILED seeded runtime — nothing can execute
    // workflow commands there.
    http:Response resp = check wfProxyGet(
            string `/${WF_COMPONENT_2_ID}/${WF_PROD_ENV_ID}/definitions`, project1AdminToken);
    assertStatusCode(resp.statusCode, 503, "No tunnel-capable runtime must yield 503");
}

// Mutation RBAC: Developer (view only) is denied before any runtime resolution;
// Project Admin (manage_workflows) passes RBAC and stops at the 503 instead.
@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowServiceMutationRequiresManagePermission() returns error? {
    string path = string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/workflows/wf-instance-1/suspend`;

    http:Response denied = check wfProxyClient->post(path, {reason: "test"},
            {"Authorization": createAuthHeader(orgDevToken)});
    assertStatusCode(denied.statusCode, 403, "view_workflows alone must not allow workflow mutations");

    http:Response allowed = check wfProxyClient->post(path, {reason: "test"},
            {"Authorization": createAuthHeader(project1AdminToken)});
    assertStatusCode(allowed.statusCode, 503,
            "manage_workflows passes RBAC; without a capable runtime the request ends in 503");
}

// Human-task split: the Viewer role has view_human_tasks but not view_workflows —
// human-task paths pass RBAC (ending in 503 here), workflows paths stay 403.
@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowServiceHumanTaskPermissionSplit() returns error? {
    http:Response humanTasks = check wfProxyGet(
            string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/human-tasks`, wfViewerToken);
    assertStatusCode(humanTasks.statusCode, 503,
            "view_human_tasks passes RBAC for human-task paths (503 without a capable runtime)");

    http:Response definitions = check wfProxyGet(
            string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/definitions`, wfViewerToken);
    assertStatusCode(definitions.statusCode, 403, "view_human_tasks alone must not allow the workflows paths");
}

// =============================================================================
// 3. GraphQL tests — workflowsByEnvironmentAndComponent
// =============================================================================

@test:Config {
    groups: ["workflow", "workflow-graphql"]
}
function testWorkflowsByEnvironmentAndComponent() returns error? {
    cleanupRuntime(WF_RUNTIME_ID);

    // A RUNNING runtime whose heartbeat carried workflow metadata (two definitions).
    types:Heartbeat heartbeat = buildWorkflowHeartbeat(WF_RUNTIME_ID, "wf-graphql-test-runtime",
            COMPONENT_1_ID, DEV_ENV_ID);
    heartbeat.workflowMetadata = {
        metadataVersion: "1.0",
        definitions: [
            {workflowType: "orderApproval", kind: "WORKFLOW", inputSchema: "{\"type\":\"object\"}"},
            {workflowType: "leaveRequest", kind: "WORKFLOW", inputSchema: ()}
        ],
        humanTasks: [],
        activities: [],
        reviewActions: ["proceed", "proceed-with-input", "reject"],
        agents: []
    };
    _ = check storage:processHeartbeat(heartbeat, preResolved = true);

    string query = string `
        query {
            workflowsByEnvironmentAndComponent(environmentId: "${DEV_ENV_ID}", componentId: "${COMPONENT_1_ID}") {
                items { name isActive workerCount state runtimes { runtimeId status } }
                pageInfo { total limit offset }
            }
        }
    `;

    json response = check executeGraphQL(query, orgDevToken);
    test:assertFalse(response.errors is json, "Developer should be able to query workflows: " + response.toString());

    json data = check response.data;
    json page = check data.workflowsByEnvironmentAndComponent;
    json[] items = check page.items.ensureType();
    test:assertEquals(items.length(), 2, "Both definitions from the stored metadata must be mapped to artifacts");

    foreach json item in items {
        test:assertEquals(check item.isActive, true,
                "A stored definition comes from a RUNNING runtime's registry, so it is active");
        test:assertEquals(check item.workerCount, 1, "One RUNNING runtime declares each definition");
        string state = check (check item.state).ensureType();
        test:assertEquals(state.toLowerAscii(), "enabled");
        // The component+environment's runtimes are attached to every definition.
        json[] runtimes = check item.runtimes.ensureType();
        test:assertTrue(runtimes.length() >= 2, "Seeded runtime and the workflow test runtime must be attached");
    }

    cleanupRuntime(WF_RUNTIME_ID);
}

@test:Config {
    groups: ["workflow", "workflow-graphql"]
}
function testWorkflowsQueryDeniedWithoutPermission() returns error? {
    string query = string `
        query {
            workflowsByEnvironmentAndComponent(environmentId: "${DEV_ENV_ID}", componentId: "${COMPONENT_1_ID}") {
                items { name }
                pageInfo { total limit offset }
            }
        }
    `;

    json response = check executeGraphQL(query, slNoPermToken);
    test:assertFalse(response.errors is json, "Permission denial must yield an empty page, not an error");

    json data = check response.data;
    json page = check data.workflowsByEnvironmentAndComponent;
    json[] items = check page.items.ensureType();
    test:assertEquals(items.length(), 0, "User without workflow permissions must see no workflows");
    int total = check (check page.pageInfo.total).ensureType();
    test:assertEquals(total, 0, "Total must be 0 for a user without workflow permissions");
}
