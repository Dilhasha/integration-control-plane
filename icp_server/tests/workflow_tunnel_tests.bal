// Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
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
import ballerina/jwt;
import ballerina/io;
import ballerina/lang.runtime as langRuntime;
import ballerina/test;
import ballerina/time;

// Workflow command tunnel tests: the request→operation mapping, the queue/waiter
// correlation, boost tracking, and one full end-to-end round trip over real HTTP —
// frontend request → command in a heartbeat response → simulated bridge posts the
// result → frontend response carries the runtime's byte-identical body.
//
// Uses Component 1 / Prod so the proxy tests (Component 1 / Dev, callback-URL path)
// and the metadata tests (Component 2 / Prod) stay undisturbed.

const string WF_TUNNEL_RUNTIME_ID = "aa000002-test-test-test-000000000005";

// ── Request → operation mapping ────────────────────────────────────────────────

@test:Config {groups: ["workflow-tunnel"]}
function testTunnelOperationMapping() {
    // Reads
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["definitions"], {}, {}),
        <[string, map<json>]>["definitions.list", {}]);
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["workflows"], {status: "RUNNING", 'limit: 20}, {}),
        <[string, map<json>]>["instances.list", {status: "RUNNING", 'limit: 20}]);
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["workflows", "wf-1"], {}, {}),
        <[string, map<json>]>["instances.get", {workflowId: "wf-1"}]);
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["workflows", "wf-1", "history"], {}, {}),
        <[string, map<json>]>["instances.history", {workflowId: "wf-1"}]);
    // A third segment that is not a known subresource is an exact run ID.
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["workflows", "wf-1", "run-9"], {}, {}),
        <[string, map<json>]>["instances.get", {workflowId: "wf-1", runId: "run-9"}]);
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["workflows", "wf-1", "run-9", "execution-graph"], {}, {}),
        <[string, map<json>]>["instances.executionGraph", {workflowId: "wf-1", runId: "run-9"}]);
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["human-tasks", "pending-count"], {}, {}),
        <[string, map<json>]>["humanTasks.pendingCount", {}]);
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["human-tasks", "task-1"], {}, {}),
        <[string, map<json>]>["humanTasks.get", {taskId: "task-1"}]);

    // Mutations
    [string, map<json>]? startOp = mapWorkflowRequestToOperation("POST", ["workflows"], {},
        {workflowType: "expenseApproval", input: {amount: 5}});
    if startOp is () {
        test:assertFail("POST workflows must map to instances.start");
    }
    test:assertEquals(startOp[0], "instances.start");
    test:assertTrue(startOp[1]["workflowId"] is string,
        "The ICP must fill workflowId so a retried start is idempotent");
    test:assertEquals(mapWorkflowRequestToOperation("POST", ["workflows", "wf-1", "terminate"], {}, {reason: "ops"}),
        <[string, map<json>]>["instances.terminate", {workflowId: "wf-1", reason: "ops"}]);
    test:assertEquals(mapWorkflowRequestToOperation("POST", ["human-tasks", "task-1", "complete"], {},
        {result: {approved: true}}),
        <[string, map<json>]>["humanTasks.complete", {taskId: "task-1", result: {approved: true}}]);
    test:assertEquals(mapWorkflowRequestToOperation("POST",
        ["review-activities", "task-2", "proceed-with-input"], {}, {input: {amount: 9}}),
        <[string, map<json>]>["reviewActivities.decide",
            {taskId: "task-2", action: "proceed-with-input", input: {amount: 9}}]);

    // Outside the vocabulary → () (falls back to the legacy proxy)
    test:assertEquals(mapWorkflowRequestToOperation("GET", ["retry-tasks"], {}, {}), ());
    test:assertEquals(mapWorkflowRequestToOperation("POST", ["workflows", "wf-1", "wake"], {}, {}), ());
}

// ── Queue / waiter / boost ─────────────────────────────────────────────────────

@test:Config {groups: ["workflow-tunnel"]}
function testTunnelQueueAndWaiter() returns error? {
    types:ControlCommand command = {
        commandId: "wfc-unit-1",
        runtimeId: "unit-runtime",
        targetArtifact: {name: "workflow"},
        action: types:WORKFLOW_MGMT,
        issuedAt: time:utcNow(),
        status: types:PENDING,
        payload: "{}"
    };
    enqueueWorkflowCommand("unit-runtime", command);

    // Delivery drains the queue exactly once.
    types:ControlCommand[] delivered = takePendingWorkflowCommands("unit-runtime");
    test:assertEquals(delivered.length(), 1);
    test:assertEquals(delivered[0].commandId, "wfc-unit-1");
    test:assertEquals(takePendingWorkflowCommands("unit-runtime").length(), 0);

    // A result for a waited command is accepted and unblocks the waiter.
    test:assertTrue(completeWorkflowCommand({
        runtimeId: "unit-runtime", commandId: "wfc-unit-1",
        status: "COMPLETED", httpStatus: 200, body: {ok: true}
    }));
    types:WorkflowCommandResult? result = awaitWorkflowCommandResult("wfc-unit-1", "unit-runtime", 1);
    if result is () {
        test:assertFail("The waiter must receive the completed result");
    }
    test:assertEquals(result.httpStatus, 200);

    // A result for an unknown (or already collected) commandId is dropped.
    test:assertFalse(completeWorkflowCommand({
        runtimeId: "unit-runtime", commandId: "wfc-unit-1",
        status: "COMPLETED", httpStatus: 200, body: {}
    }));
}

@test:Config {groups: ["workflow-tunnel"]}
function testResultFromAnotherRuntimeIsRefused() {
    // Every runtime agent in the organization authenticates the same way, so a commandId
    // alone must not be enough to answer a command queued for a different runtime: that
    // answer is relayed to the console as the operation's own result.
    types:ControlCommand command = {
        commandId: "wfc-unit-crossruntime",
        runtimeId: "unit-runtime-owner",
        targetArtifact: {name: "workflow"},
        action: types:WORKFLOW_MGMT,
        issuedAt: time:utcNow(),
        status: types:PENDING,
        payload: "{}"
    };
    enqueueWorkflowCommand("unit-runtime-owner", command);

    test:assertFalse(completeWorkflowCommand({
        runtimeId: "unit-runtime-intruder", commandId: "wfc-unit-crossruntime",
        status: "COMPLETED", httpStatus: 200, body: {hijacked: true}
    }), "A result from a runtime the command was not issued to must be refused");

    test:assertTrue(completeWorkflowCommand({
        runtimeId: "unit-runtime-owner", commandId: "wfc-unit-crossruntime",
        status: "COMPLETED", httpStatus: 200, body: {ok: true}
    }), "The runtime the command was issued to must still be able to answer it");

    types:WorkflowCommandResult? result = awaitWorkflowCommandResult(
            "wfc-unit-crossruntime", "unit-runtime-owner", 1);
    if result is () {
        test:assertFail("The owning runtime's result must reach the waiter");
    }
    test:assertEquals(result.body, {ok: true}, "The refused result must not have been stored");
    _ = takePendingWorkflowCommands("unit-runtime-owner");
}

@test:Config {groups: ["workflow-tunnel"]}
function testTunnelWaiterTimeoutCleansQueue() {
    types:ControlCommand command = {
        commandId: "wfc-unit-timeout",
        runtimeId: "unit-runtime-2",
        targetArtifact: {name: "workflow"},
        action: types:WORKFLOW_MGMT,
        issuedAt: time:utcNow(),
        status: types:PENDING,
        payload: "{}"
    };
    enqueueWorkflowCommand("unit-runtime-2", command);

    types:WorkflowCommandResult? result = awaitWorkflowCommandResult("wfc-unit-timeout", "unit-runtime-2", 0.3);
    test:assertTrue(result is (), "An unanswered command must time out");
    test:assertEquals(takePendingWorkflowCommands("unit-runtime-2").length(), 0,
        "A timed-out command must be removed from its runtime's queue");
    test:assertFalse(completeWorkflowCommand({
        runtimeId: "unit-runtime-2", commandId: "wfc-unit-timeout",
        status: "COMPLETED", httpStatus: 200, body: {}
    }), "A result arriving after the timeout must be dropped");
}

@test:Config {groups: ["workflow-tunnel"]}
function testTunnelBoostWindow() {
    test:assertTrue(workflowBoostHint("unit-runtime-3") is (), "Unboosted runtimes get no hint");
    boostWorkflowRuntime("unit-runtime-3");
    test:assertEquals(workflowBoostHint("unit-runtime-3"), 1);
}

// The cadence must decay as the runtime goes idle: a runtime that served one workflow
// request must not be asked for a heartbeat every second from then on. Idle time is set
// directly rather than waited out, so the whole ramp is checked without sleeping.
@test:Config {groups: ["workflow-tunnel"]}
function testTunnelBoostRampDecaysToTheRuntimeInterval() {
    string runtimeId = "unit-runtime-ramp";
    [int, int?][] expected = [
        [0, 1],     // just requested — fastest cadence
        [4, 1],     // still inside the first step
        [5, 2],     // first step over
        [9, 2],
        [10, 5],
        [19, 5],
        [20, 10],
        [29, 10],
        [30, ()],   // ramp exhausted — back to the runtime's own interval
        [120, ()]   // and it stays there
    ];
    foreach [int, int?] [idleSeconds, cadence] in expected {
        lock {
            workflowTunnel.boostedAt[runtimeId] = nowUnixSeconds() - idleSeconds;
        }
        test:assertEquals(workflowBoostHint(runtimeId), cadence,
                string `A runtime idle for ${idleSeconds}s must be asked for cadence ${cadence.toString()}`);
    }

    // A new request restarts the ramp, so an active user keeps the fastest cadence.
    boostWorkflowRuntime(runtimeId);
    test:assertEquals(workflowBoostHint(runtimeId), 1, "A workflow request must restart the ramp");
}

// ── End-to-end round trip over real HTTP ──────────────────────────────────────

final http:Client wfRuntimeIcpClient = check new ("https://localhost:9445/icp",
    secureSocket = {
        cert: {
            path: truststorePath,
            password: truststorePassword
        }
    }
);

// Mints a runtime JWT the way the ICP bridge does: HS256 over the org-secret key
// material, keyId in the header, runtime_agent scope.
function issueRuntimeToken(string keyId, string keyMaterial) returns string|error {
    jwt:IssuerConfig issuerConfig = {
        issuer: jwtIssuer,
        audience: jwtAudience,
        expTime: 600,
        keyId: keyId,
        customClaims: {"scope": "runtime_agent"},
        signatureConfig: {algorithm: jwt:HS256, config: keyMaterial}
    };
    return jwt:issue(issuerConfig);
}

// alwaysRun: a failure here would otherwise leave WF_TUNNEL_RUNTIME_ID registered, and it
// advertises workflowCommands for Component 1 / Prod — changing which runtime later tests
// see selected. The org secret the end-to-end test binds is revoked here for the same
// reason: every run would otherwise leave another active secret row behind.
@test:AfterGroups {value: ["workflow-tunnel"], alwaysRun: true}
function cleanupWorkflowTunnelTests() {
    cleanupRuntime(WF_TUNNEL_RUNTIME_ID);
    string issuedKeyId;
    lock {
        issuedKeyId = tunnelTestKeyId;
    }
    if issuedKeyId != "" {
        error? revoked = storage:revokeOrgSecret(issuedKeyId);
        if revoked is error {
            io:println("Failed to revoke the workflow-tunnel test org secret: ", revoked.message());
        }
    }
}

// The key ID the end-to-end test issues, so the teardown can revoke it even if that test
// fails partway through.
isolated string tunnelTestKeyId = "";

// Full tunnel round trip: a frontend request for a tunnel-capable runtime is answered
// by a simulated bridge that receives the WORKFLOW_MGMT command in a (boosted)
// heartbeat response and posts its result to /icp/commandResult.
@test:Config {groups: ["workflow-tunnel"]}
function testWorkflowTunnelEndToEnd() returns error? {
    cleanupRuntime(WF_TUNNEL_RUNTIME_ID);

    // A RUNNING runtime on Component 1 / Prod that published metadata and the
    // workflowCommands capability (making it the tunnel target for that scope).
    types:Heartbeat heartbeat = buildWorkflowHeartbeat(WF_TUNNEL_RUNTIME_ID, "wf-tunnel-test-runtime",
            COMPONENT_1_ID, WF_PROD_ENV_ID);
    heartbeat.workflowMetadata = WF_META_DOCUMENT.clone();
    heartbeat.capabilities = ["workflowCommands"];
    types:HeartbeatResponse registered = check storage:processHeartbeat(heartbeat, preResolved = true);
    test:assertTrue(registered.acknowledged);

    // Bind an org secret so the simulated bridge can authenticate like a real one.
    string orgSecret = check storage:createOrgSecret(WF_PROD_ENV_ID, WF_ADMIN_USER_ID);
    int? dotIdx = orgSecret.indexOf(".");
    if dotIdx is () {
        return error("createOrgSecret returned an unexpected secret format");
    }
    string keyId = orgSecret.substring(0, dotIdx);
    string keyMaterial = orgSecret.substring(dotIdx + 1);
    lock {
        tunnelTestKeyId = keyId;
    }
    check storage:updateRuntimeKeyId(WF_TUNNEL_RUNTIME_ID, keyId);
    // Bind the secret the way a real first full heartbeat would — the delta-heartbeat
    // handler short-circuits (fullHeartbeatRequired) for unbound keys, before any
    // command delivery.
    check storage:bindOrgSecret(keyId, PROJECT_1_ID, COMPONENT_1_ID,
            "wf-tunnel-project", "wf-tunnel-component", "BI");
    string runtimeToken = check issueRuntimeToken(keyId, keyMaterial);
    string adminToken = check generateV2Token(WF_ADMIN_USER_ID, "admin", []);

    // Fire the frontend request; it blocks server-side until the bridge answers.
    future<http:Response|error> pendingRequest = start wfProxyGet(
            string `/${COMPONENT_1_ID}/${WF_PROD_ENV_ID}/human-tasks/pending-count`, adminToken);

    // Simulated bridge: poll delta heartbeats until the command arrives, then post
    // the result the runtime's management API would have produced.
    types:DeltaHeartbeat deltaHeartbeat = {
        runtimeId: WF_TUNNEL_RUNTIME_ID,
        runtimeHash: "wf-test-hash-" + WF_TUNNEL_RUNTIME_ID,
        timestamp: time:utcNow()
    };
    map<string> runtimeAuth = {"Authorization": "Bearer " + runtimeToken};
    boolean answered = false;
    boolean sawBoostHint = false;
    foreach int attempt in 0 ..< 60 {
        json deltaResponse = check wfRuntimeIcpClient->post("/deltaHeartbeat", deltaHeartbeat, runtimeAuth);
        json|error hint = deltaResponse.nextHeartbeatInSeconds;
        if hint is int && hint == 1 {
            sawBoostHint = true;
        }
        json|error commandsJson = deltaResponse.commands;
        if commandsJson is json[] {
            foreach json commandJson in commandsJson {
                json|error action = commandJson.action;
                if action is string && action == "WORKFLOW_MGMT" {
                    json|error payloadText = commandJson.payload;
                    if payloadText !is string {
                        return error("WORKFLOW_MGMT command without a payload");
                    }
                    json payload = check payloadText.fromJsonString();
                    test:assertEquals(check payload.operation, "humanTasks.pendingCount");
                    test:assertEquals(check payload.identity.userId, WF_ADMIN_USER_ID);
                    string commandId = check payload.commandId;
                    http:Response accepted = check wfRuntimeIcpClient->post("/commandResult", {
                        runtimeId: WF_TUNNEL_RUNTIME_ID,
                        commandId: commandId,
                        status: "COMPLETED",
                        httpStatus: 200,
                        body: {count: 7}
                    }, runtimeAuth);
                    test:assertEquals(accepted.statusCode, 202);
                    answered = true;
                }
            }
        }
        if answered {
            break;
        }
        langRuntime:sleep(0.2);
    }
    if !answered {
        // Surface what the frontend request actually got — the command never reaching
        // the bridge usually means the request took another path (403/503/proxy).
        http:Response|error early = wait pendingRequest;
        if early is http:Response {
            json|error earlyBody = early.getJsonPayload();
            test:assertFail(string `The simulated bridge never received the tunneled command; ` +
                    string `the frontend request returned ${early.statusCode}: ` +
                    (earlyBody is json ? earlyBody.toJsonString() : "<no body>"));
        }
        test:assertFail("The simulated bridge never received the tunneled command; " +
                "the frontend request failed: " + early.message());
    }
    test:assertTrue(sawBoostHint, "Heartbeat responses must carry the boost hint while a workflow request is active");

    http:Response frontendResponse = check wait pendingRequest;
    test:assertEquals(frontendResponse.statusCode, 200);
    test:assertEquals(check frontendResponse.getJsonPayload(), <json>{count: 7},
        "The frontend response must carry the runtime's result body byte-identically");
}
