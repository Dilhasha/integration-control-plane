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
// Covers the workflow management feature end to end:
//   1. Storage — callback URL persistence from heartbeats and target resolution
//      (getRuntimeWorkflowTarget / getRunningWorkflowCallbackUrls).
//   2. Unit — escapeRoleName header-injection guard.
//   3. Proxy  — /icp/workflow auth, RBAC, identity-header injection, API-key
//      reconstruction and request forwarding, against a mock workflow runtime.
//   4. GraphQL — workflowsByEnvironmentAndComponent resolver (live definitions
//      fetch + artifact mapping).
//
// Seed data used (h2_test_data.sql / mysql_test_data_init.sql):
//   - Project 1 / Component 1 / Dev env — RUNNING runtime without callback URL.
//   - Project 1 / Component 2 / Prod env — FAILED runtime (no usable target).
//   - orgdev (Developer, org scope)     → view_workflows, view/manage_human_tasks
//   - projectadmin (Admin, Project 1)   → manage_workflows
//   - readonlyviewer (Viewer, Comp 1)   → view_human_tasks only
// =============================================================================

// Mock workflow runtime: stands in for the per-runtime workflow management
// REST service the proxy forwards to (base path /workflow on the runtime side).
const int WF_MOCK_PORT = 9459;
const string WF_MOCK_CALLBACK_URL = "http://localhost:9459";

// Dedicated runtime registered against Component 1 / Dev with the mock as its
// workflow callback URL. Unique name so it never collides with seeded runtimes.
const string WF_RUNTIME_ID = "aa000002-test-test-test-000000000001";
const string WF_RUNTIME_NAME = "wf-proxy-test-runtime";

// Storage-lifecycle test runtime (Component 2 / Dev — kept apart from the proxy
// tests' component so target resolution never picks the wrong row).
const string WF_ST_RUNTIME_ID = "aa000002-test-test-test-000000000002";
const string WF_ST_RUNTIME_NAME = "wf-storage-test-runtime";
const string WF_ST_CALLBACK_URL = "http://localhost:9460";
const string WF_COMPONENT_2_ID = "640e8400-e29b-41d4-a716-446655440002";
const string WF_PROD_ENV_ID = "750e8400-e29b-41d4-a716-446655440002";

// Seeded super admin — used as created_by for the org secret (FK to users).
const string WF_ADMIN_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
// Seeded Viewer-role user scoped to Component 1 (view_human_tasks only).
const string WF_VIEWER_USER_ID = "770e8400-e29b-41d4-a716-446655440005";

// Full org secret (<keyId>.<keyMaterial>) created for the proxy tests — the
// proxy must reconstruct exactly this value as the X-API-Key header.
string wfTestApiKey = "";
// Token for readonlyviewer — permissions are resolved from the DB, not the token.
string wfViewerToken = "";

// =============================================================================
// Mock workflow runtime service
// =============================================================================
// Echoes the identity/auth headers it receives so tests can assert what the
// proxy injected. The definitions payload matches the runtime's
// GET /workflow/definitions response shape consumed by fetchWorkflowDefinitions.

listener http:Listener mockWorkflowListener = new (WF_MOCK_PORT);

function wfEchoHeaders(http:Request req) returns json {
    string|http:HeaderNotFoundError userId = req.getHeader("x-user-id");
    string|http:HeaderNotFoundError roles = req.getHeader("x-user-roles");
    string|http:HeaderNotFoundError apiKey = req.getHeader("X-API-Key");
    return {
        userId: userId is string ? userId : (),
        roles: roles is string ? roles : (),
        apiKey: apiKey is string ? apiKey : (),
        hasAuthHeader: req.hasHeader("Authorization"),
        rawPath: req.rawPath
    };
}

service /workflow on mockWorkflowListener {

    resource function get definitions(http:Request req) returns json {
        return {
            definitions: [
                {workflowType: "orderApproval", isActive: true, workerCount: 2, inputSchema: "{\"type\":\"object\"}"},
                {workflowType: "leaveRequest", isActive: false}
            ],
            echo: wfEchoHeaders(req)
        };
    }

    resource function get human\-tasks(http:Request req) returns json {
        return {tasks: [], echo: wfEchoHeaders(req)};
    }

    resource function post instances/[string instanceId]/suspend(http:Request req) returns json {
        return {acknowledged: true, instanceId: instanceId, echo: wfEchoHeaders(req)};
    }
}

// =============================================================================
// Helpers / fixtures
// =============================================================================

// HTTP client hitting the real proxy service on the shared TLS listener.
final http:Client wfProxyClient = check new ("https://localhost:9446/icp/workflow",
    secureSocket = {
        cert: {
            path: truststorePath,
            password: truststorePassword
        }
    }
);

function buildWorkflowHeartbeat(string runtimeId, string runtimeName, string componentId,
        string environmentId, string? callbackUrl) returns types:Heartbeat {
    types:Heartbeat heartbeat = {
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
    if callbackUrl is string {
        heartbeat.workflowCallbackUrl = callbackUrl;
    }
    return heartbeat;
}

@test:BeforeGroups {value: ["workflow"]}
function setupWorkflowTests() returns error? {
    cleanupRuntime(WF_RUNTIME_ID);

    // Register a RUNNING runtime for Component 1 / Dev pointing at the mock.
    types:HeartbeatResponse resp = check storage:processHeartbeat(
            buildWorkflowHeartbeat(WF_RUNTIME_ID, WF_RUNTIME_NAME, COMPONENT_1_ID, DEV_ENV_ID, WF_MOCK_CALLBACK_URL),
            preResolved = true);
    test:assertTrue(resp.acknowledged, "Workflow test runtime heartbeat should be acknowledged");

    // Record an org secret on the runtime so the proxy reconstructs the API key.
    wfTestApiKey = check storage:createOrgSecret(DEV_ENV_ID, WF_ADMIN_USER_ID);
    int? dotIdx = wfTestApiKey.indexOf(".");
    if dotIdx is () {
        return error("createOrgSecret returned an unexpected secret format");
    }
    check storage:updateRuntimeKeyId(WF_RUNTIME_ID, wfTestApiKey.substring(0, dotIdx));

    wfViewerToken = check generateV2Token(WF_VIEWER_USER_ID, "readonlyviewer", []);
}

@test:AfterGroups {value: ["workflow"], alwaysRun: true}
function teardownWorkflowTests() {
    cleanupRuntime(WF_RUNTIME_ID);
    cleanupRuntime(WF_ST_RUNTIME_ID);
    int? dotIdx = wfTestApiKey.indexOf(".");
    if dotIdx is int {
        error? revoked = storage:revokeOrgSecret(wfTestApiKey.substring(0, dotIdx));
        if revoked is error {
            // Ignore — secret may have already been removed.
        }
    }
}

function wfProxyGet(string path, string? token) returns http:Response|error {
    if token is () {
        return wfProxyClient->get(path);
    }
    return wfProxyClient->get(path, {"Authorization": createAuthHeader(token)});
}

// =============================================================================
// 1. Storage tests — callback URL persistence and target resolution
// =============================================================================

@test:Config {
    groups: ["workflow", "workflow-storage"]
}
function testWorkflowTargetLifecycle() returns error? {
    cleanupRuntime(WF_ST_RUNTIME_ID);

    // Heartbeat with a callback URL → target resolvable while RUNNING.
    _ = check storage:processHeartbeat(
            buildWorkflowHeartbeat(WF_ST_RUNTIME_ID, WF_ST_RUNTIME_NAME, WF_COMPONENT_2_ID, DEV_ENV_ID, WF_ST_CALLBACK_URL),
            preResolved = true);

    types:WorkflowTarget? target = check storage:getRuntimeWorkflowTarget(WF_COMPONENT_2_ID, DEV_ENV_ID);
    if target is () {
        test:assertFail("Expected a workflow target for a RUNNING runtime with a callback URL");
    }
    test:assertEquals(target.callbackUrl, WF_ST_CALLBACK_URL, "Target should carry the heartbeat's callback URL");
    test:assertEquals(target.keyId, (), "No key id was recorded for this runtime");

    string[] liveUrls = check storage:getRunningWorkflowCallbackUrls();
    test:assertTrue(liveUrls.indexOf(WF_ST_CALLBACK_URL) is int,
            "RUNNING runtime's callback URL should be listed as live");

    // Once the runtime goes OFFLINE its callback URL must no longer be used.
    check storage:updateRuntimeStatus(WF_ST_RUNTIME_ID, "OFFLINE");

    types:WorkflowTarget? offlineTarget = check storage:getRuntimeWorkflowTarget(WF_COMPONENT_2_ID, DEV_ENV_ID);
    test:assertEquals(offlineTarget, (), "OFFLINE runtime's callback URL must not resolve as a target");

    string[] liveUrlsAfter = check storage:getRunningWorkflowCallbackUrls();
    test:assertTrue(liveUrlsAfter.indexOf(WF_ST_CALLBACK_URL) is (),
            "OFFLINE runtime's callback URL must not be listed as live");

    cleanupRuntime(WF_ST_RUNTIME_ID);
}

@test:Config {
    groups: ["workflow", "workflow-storage"]
}
function testWorkflowTargetAbsentWithoutCallbackUrl() returns error? {
    // Seeded runtime for Component 1 / Prod is RUNNING but reported no callback URL.
    types:WorkflowTarget? target = check storage:getRuntimeWorkflowTarget(COMPONENT_1_ID, WF_PROD_ENV_ID);
    test:assertEquals(target, (), "Runtime without a callback URL must not resolve as a workflow target");
}

@test:Config {
    groups: ["workflow", "workflow-storage"]
}
function testWorkflowTargetIgnoresEmptyCallbackUrl() returns error? {
    cleanupRuntime(WF_ST_RUNTIME_ID);

    // Empty-string callback URLs (runtime bridge without workflow support) are unusable.
    _ = check storage:processHeartbeat(
            buildWorkflowHeartbeat(WF_ST_RUNTIME_ID, WF_ST_RUNTIME_NAME, WF_COMPONENT_2_ID, DEV_ENV_ID, ""),
            preResolved = true);

    types:WorkflowTarget? target = check storage:getRuntimeWorkflowTarget(WF_COMPONENT_2_ID, DEV_ENV_ID);
    test:assertEquals(target, (), "Empty callback URL must not resolve as a workflow target");

    cleanupRuntime(WF_ST_RUNTIME_ID);
}

// =============================================================================
// 2. Unit test — role-name escaping for the x-user-roles header
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
// 3. Proxy tests — /icp/workflow
// =============================================================================

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowProxyRejectsMissingToken() returns error? {
    http:Response resp = check wfProxyGet(string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/definitions`, ());
    assertStatusCode(resp.statusCode, 401, "Request without a bearer token must be rejected by listener auth");
}

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowProxyDeniesUserWithoutPermissions() returns error? {
    http:Response resp = check wfProxyGet(string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/definitions`, slNoPermToken);
    assertStatusCode(resp.statusCode, 403, "User without workflow permissions must get 403");
}

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowProxyUnknownComponentReturns404() returns error? {
    http:Response resp = check wfProxyGet(
            string `/00000000-0000-0000-0000-00000000dead/${DEV_ENV_ID}/definitions`, orgDevToken);
    assertStatusCode(resp.statusCode, 404, "Unknown component must return 404");
}

@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowProxyReturns503WithoutRunningRuntime() returns error? {
    // Component 2 / Prod only has a FAILED seeded runtime — no usable target.
    http:Response resp = check wfProxyGet(
            string `/${WF_COMPONENT_2_ID}/${WF_PROD_ENV_ID}/definitions`, project1AdminToken);
    assertStatusCode(resp.statusCode, 503, "No running runtime with a callback URL must yield 503");
}

// Browse path: Developer (view_workflows) can GET; the proxy must inject the
// caller's identity headers, replace the ICP bearer token with the runtime's
// management API key, and forward the query string verbatim.
@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowProxyForwardsGetWithInjectedHeaders() returns error? {
    http:Response resp = check wfProxyGet(
            string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/definitions?status=ACTIVE&pageSize=5`, orgDevToken);
    assertStatusCode(resp.statusCode, 200, "Developer must be able to browse workflow definitions");

    json body = check resp.getJsonPayload();
    json[] definitions = check (check body.definitions).ensureType();
    test:assertEquals(definitions.length(), 2, "Mock runtime's definitions must be relayed unchanged");

    json echo = check body.echo;
    test:assertEquals(check echo.userId, "770e8400-e29b-41d4-a716-446655440001",
            "Proxy must inject the caller's user id as x-user-id");

    string roles = check (check echo.roles).ensureType();
    test:assertTrue(roles.includes("Developer"), "x-user-roles must carry the caller's ICP role names");
    test:assertFalse(roles.includes("admin"), "Non-super-admin caller must not get the synthetic admin role");

    test:assertEquals(check echo.apiKey, wfTestApiKey,
            "Proxy must reconstruct the runtime's management API key from the org secret");
    test:assertEquals(check echo.hasAuthHeader, false,
            "ICP bearer token must not be forwarded to the runtime");

    string rawPath = check (check echo.rawPath).ensureType();
    test:assertTrue(rawPath.endsWith("/workflow/definitions?status=ACTIVE&pageSize=5"),
            "Path and query string must be forwarded verbatim, got: " + rawPath);
}

// Mutation path: Developer (view only) is denied; Project Admin
// (manage_workflows) is forwarded, with method and body preserved.
@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowProxyMutationRequiresManagePermission() returns error? {
    string path = string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/instances/wf-instance-1/suspend`;

    http:Response denied = check wfProxyClient->post(path, {reason: "test"},
            {"Authorization": createAuthHeader(orgDevToken)});
    assertStatusCode(denied.statusCode, 403, "view_workflows alone must not allow workflow mutations");

    // The mock's POST resource answers 201 Created — the proxy must relay it verbatim.
    http:Response allowed = check wfProxyClient->post(path, {reason: "test"},
            {"Authorization": createAuthHeader(project1AdminToken)});
    assertStatusCode(allowed.statusCode, 201, "manage_workflows must allow workflow mutations");

    json body = check allowed.getJsonPayload();
    test:assertEquals(check body.instanceId, "wf-instance-1", "POST must be forwarded to the mock runtime");
    json echo = check body.echo;
    test:assertEquals(check echo.userId, "770e8400-e29b-41d4-a716-446655440002",
            "Proxy must inject the project admin's user id");
}

// Human-task split: the Viewer role has view_human_tasks but not view_workflows —
// browsing human tasks is allowed while the workflows paths stay forbidden.
@test:Config {
    groups: ["workflow", "workflow-proxy"]
}
function testWorkflowProxyHumanTaskPermissionSplit() returns error? {
    http:Response humanTasks = check wfProxyGet(
            string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/human-tasks`, wfViewerToken);
    assertStatusCode(humanTasks.statusCode, 200, "view_human_tasks must allow browsing human tasks");

    http:Response definitions = check wfProxyGet(
            string `/${COMPONENT_1_ID}/${DEV_ENV_ID}/definitions`, wfViewerToken);
    assertStatusCode(definitions.statusCode, 403, "view_human_tasks alone must not allow the workflows paths");
}

// =============================================================================
// 4. GraphQL tests — workflowsByEnvironmentAndComponent
// =============================================================================

@test:Config {
    groups: ["workflow", "workflow-graphql"]
}
function testWorkflowsByEnvironmentAndComponent() returns error? {
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
    test:assertEquals(items.length(), 2, "Both definitions from the runtime must be mapped to artifacts");

    json orderApproval = items[0];
    test:assertEquals(check orderApproval.name, "orderApproval", "workflowType maps to the artifact name");
    test:assertEquals(check orderApproval.isActive, true, "isActive must be carried over");
    test:assertEquals(check orderApproval.workerCount, 2, "workerCount must be carried over");
    string state = check (check orderApproval.state).ensureType();
    test:assertEquals(state.toLowerAscii(), "enabled", "Active definition maps to the enabled state");

    json leaveRequest = items[1];
    test:assertEquals(check leaveRequest.isActive, false, "Inactive definition keeps isActive=false");
    test:assertEquals(check leaveRequest.workerCount, 0, "Missing workerCount defaults to 0");
    string leaveState = check (check leaveRequest.state).ensureType();
    test:assertEquals(leaveState.toLowerAscii(), "disabled", "Inactive definition maps to the disabled state");

    // The component+environment's runtimes are attached to every definition.
    json[] runtimes = check orderApproval.runtimes.ensureType();
    test:assertTrue(runtimes.length() >= 2, "Seeded runtime and the workflow test runtime must be attached");
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
