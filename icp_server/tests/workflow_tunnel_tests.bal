// Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com) All Rights Reserved.
//
// WSO2 LLC. licenses this file to you under the Apache License,
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

import icp_server.storage;
import icp_server.types;

import ballerina/test;

// The stateless tunnel, tested against the database it actually uses. These replace the
// unit tests of the in-memory queue that this design removed: the behaviour that matters
// now is what two ICP nodes see in shared tables, and that cannot be tested in memory.
//
// The seeded sample-integration runtime supplies a real scope, since delivery resolves a
// runtime's component and environment from the runtimes table.

const string WF_TUNNEL_RUNTIME_ID = "880e8400-e29b-41d4-a716-446655440001";
const string WF_TUNNEL_COMPONENT_ID = "640e8400-e29b-41d4-a716-446655440001";
const string WF_TUNNEL_ENVIRONMENT_ID = "750e8400-e29b-41d4-a716-446655440001";
final string WF_TUNNEL_SCOPE = WF_TUNNEL_COMPONENT_ID + ":" + WF_TUNNEL_ENVIRONMENT_ID;

isolated function tunnelRequest(string operation) returns string =>
    {operation: operation, params: {}, identity: {userId: "alice", roles: ["APPROVER"]}}
        .toJsonString();

// ── Coalescing ───────────────────────────────────────────────────────────────

@test:Config {groups: ["workflow_tunnel"]}
function testConcurrentReadsCoalesceOntoOneFetch() returns error? {
    string cacheKey = "coalesce-" + storage:wfNowEpoch().toString();
    int expiresAt = storage:wfNowEpoch() + 60;

    boolean first = check storage:startWorkflowCacheFetch(cacheKey, WF_TUNNEL_SCOPE,
            tunnelRequest("humanTasks.list"), "fetch-1", expiresAt);
    test:assertTrue(first, "The first request must own the fetch");

    // A second request for the same key - from this node or any other - must not issue a
    // second command. The primary key is what makes that true, with no lock and no
    // read-then-write window.
    boolean second = check storage:startWorkflowCacheFetch(cacheKey, WF_TUNNEL_SCOPE,
            tunnelRequest("humanTasks.list"), "fetch-2", expiresAt);
    test:assertFalse(second, "A concurrent identical request must attach to the running fetch");

    types:WorkflowCacheRow? row = check storage:getWorkflowCacheRow(cacheKey);
    test:assertTrue(row is types:WorkflowCacheRow, "The row must exist");
    if row is types:WorkflowCacheRow {
        test:assertEquals(row.fetchId, "fetch-1", "The first attempt must still own the fetch");
        test:assertEquals(row.status, types:WF_CACHE_FETCHING);
    }
}

// ── Fencing ──────────────────────────────────────────────────────────────────

@test:Config {groups: ["workflow_tunnel"]}
function testResultFromASupersededAttemptIsDiscarded() returns error? {
    string cacheKey = "fence-" + storage:wfNowEpoch().toString();
    int now = storage:wfNowEpoch();
    _ = check storage:startWorkflowCacheFetch(cacheKey, WF_TUNNEL_SCOPE,
            tunnelRequest("instances.list"), "attempt-old", now + 60);

    // The attempt that is current wins.
    boolean stored = check storage:completeWorkflowCacheFetch(cacheKey, "attempt-old",
            "{\"body\":\"first\"}", now + 60);
    test:assertTrue(stored, "The current attempt's result must be stored");

    // A late answer from an attempt the row no longer holds describes a world that has
    // moved on. Storing it is how a completed task reappears and sticks for a whole TTL.
    boolean late = check storage:completeWorkflowCacheFetch(cacheKey, "attempt-old",
            "{\"body\":\"stale\"}", now + 60);
    test:assertFalse(late, "A result whose attempt is no longer current must be discarded");

    types:WorkflowCacheRow? row = check storage:getWorkflowCacheRow(cacheKey);
    if row is types:WorkflowCacheRow {
        test:assertEquals(row.payload, "{\"body\":\"first\"}",
            "The stored payload must not be overwritten by a superseded attempt");
        test:assertEquals(row.fetchId, (), "A completed fetch must leave no attempt in flight");
    }
}

@test:Config {groups: ["workflow_tunnel"]}
function testFailedRefreshKeepsTheLastGoodPayload() returns error? {
    string cacheKey = "failkeep-" + storage:wfNowEpoch().toString();
    int now = storage:wfNowEpoch();
    _ = check storage:startWorkflowCacheFetch(cacheKey, WF_TUNNEL_SCOPE,
            tunnelRequest("instances.list"), "attempt-1", now + 60);
    _ = check storage:completeWorkflowCacheFetch(cacheKey, "attempt-1", "{\"body\":\"good\"}",
            now + 60);

    boolean claimed = check storage:claimWorkflowCacheRefresh(cacheKey, "attempt-2",
            tunnelRequest("instances.list"), now + 60);
    test:assertTrue(claimed, "A row with nothing in flight must be claimable for refresh");

    _ = check storage:failWorkflowCacheFetch(cacheKey, "attempt-2", "{\"error\":\"boom\"}",
            now + 15);
    types:WorkflowCacheRow? row = check storage:getWorkflowCacheRow(cacheKey);
    if row is types:WorkflowCacheRow {
        test:assertEquals(row.payload, "{\"body\":\"good\"}",
            "A failed refresh must keep serving the last good answer");
        test:assertEquals(row.status, types:WF_CACHE_READY);
    }
}

@test:Config {groups: ["workflow_tunnel"]}
function testOnlyOneRefreshRunsAtATime() returns error? {
    string cacheKey = "onerefresh-" + storage:wfNowEpoch().toString();
    int now = storage:wfNowEpoch();
    _ = check storage:startWorkflowCacheFetch(cacheKey, WF_TUNNEL_SCOPE,
            tunnelRequest("workItems.list"), "attempt-1", now + 60);
    _ = check storage:completeWorkflowCacheFetch(cacheKey, "attempt-1", "{\"body\":\"x\"}", now);

    test:assertTrue(check storage:claimWorkflowCacheRefresh(cacheKey, "refresh-1",
            tunnelRequest("workItems.list"), now + 60));
    test:assertFalse(check storage:claimWorkflowCacheRefresh(cacheKey, "refresh-2",
            tunnelRequest("workItems.list"), now + 60),
        "A second reader must not start a competing refresh");
}

// ── Invalidation ─────────────────────────────────────────────────────────────

@test:Config {groups: ["workflow_tunnel"]}
function testMutationStalesLiveEntriesAndSparesTerminalOnes() returns error? {
    int now = storage:wfNowEpoch();
    string liveKey = "live-" + now.toString();
    string terminalKey = "terminal-" + now.toString();

    _ = check storage:startWorkflowCacheFetch(liveKey, WF_TUNNEL_SCOPE,
            tunnelRequest("humanTasks.list"), "live-attempt", now + 60);
    _ = check storage:completeWorkflowCacheFetch(liveKey, "live-attempt", "{\"body\":1}", now + 60);

    // A closed instance's views cannot be falsified by anything, so they carry a long TTL
    // and must survive invalidation - that is what keeps finished work readable while the
    // runtime is down.
    _ = check storage:startWorkflowCacheFetch(terminalKey, WF_TUNNEL_SCOPE,
            tunnelRequest("instances.get"), "terminal-attempt", now + 60);
    _ = check storage:completeWorkflowCacheFetch(terminalKey, "terminal-attempt",
            "{\"body\":2}", now + 86400);

    int marked = check storage:staleWorkflowCacheScope(WF_TUNNEL_SCOPE, 3600);
    test:assertTrue(marked >= 1, "The live entry must be marked stale");

    types:WorkflowCacheRow? live = check storage:getWorkflowCacheRow(liveKey);
    types:WorkflowCacheRow? terminal = check storage:getWorkflowCacheRow(terminalKey);
    if live is types:WorkflowCacheRow {
        test:assertTrue(live.expiresAt <= now + 1, "The live entry must now be stale");
        test:assertEquals(live.payload, "{\"body\":1}",
            "Invalidation must mark, not delete: a stale entry is still served while it refreshes");
    }
    if terminal is types:WorkflowCacheRow {
        test:assertTrue(terminal.expiresAt > now + 3600,
            "A terminal entry must not be invalidated by a mutation");
    }
}

// ── Delivery bounds ──────────────────────────────────────────────────────────

@test:Config {groups: ["workflow_tunnel"]}
function testReadClaimIsBoundedAndNotReofferedImmediately() returns error? {
    int now = storage:wfNowEpoch();
    string scope = "claimscope-" + now.toString();
    foreach int i in 0 ..< 5 {
        _ = check storage:startWorkflowCacheFetch(string `claim-${now}-${i}`, scope,
                tunnelRequest("humanTasks.list"), string `attempt-${i}`, now + 60);
    }

    types:WorkflowPendingRead[] firstBatch = check storage:claimWorkflowCacheReads(scope, 2);
    test:assertEquals(firstBatch.length(), 2,
        "A heartbeat must never carry more than the cap, whatever the backlog");

    // Already-claimed reads are not offered again on the next heartbeat a second later;
    // without that a boosted runtime would be sent the same in-flight read every second.
    types:WorkflowPendingRead[] secondBatch = check storage:claimWorkflowCacheReads(scope, 5);
    test:assertEquals(secondBatch.length(), 3,
        "Only unclaimed reads may be delivered again this soon");
}

// ── Mutations ────────────────────────────────────────────────────────────────

@test:Config {groups: ["workflow_tunnel"]}
function testIdempotencyKeyPreventsADuplicateOperation() returns error? {
    int now = storage:wfNowEpoch();
    types:WorkflowOutboxRow operation = {
        operationId: "wfo-idem-" + now.toString(),
        runtimeId: WF_TUNNEL_RUNTIME_ID,
        scopeKey: WF_TUNNEL_SCOPE,
        status: types:WF_OP_PENDING,
        issuedAt: now,
        deadline: now + 1800,
        payload: tunnelRequest("humanTasks.complete")
    };
    test:assertTrue(check storage:enqueueWorkflowOperation(operation),
        "The first submission must be queued");
    test:assertFalse(check storage:enqueueWorkflowOperation(operation),
        "A resubmitted click must not become a second operation");
}

@test:Config {groups: ["workflow_tunnel"]}
function testOutcomeIsRecordedExactlyOnce() returns error? {
    int now = storage:wfNowEpoch();
    string operationId = "wfo-once-" + now.toString();
    _ = check storage:enqueueWorkflowOperation({
        operationId: operationId,
        runtimeId: WF_TUNNEL_RUNTIME_ID,
        scopeKey: WF_TUNNEL_SCOPE,
        status: types:WF_OP_PENDING,
        issuedAt: now,
        deadline: now + 1800,
        payload: tunnelRequest("instances.terminate")
    });

    types:WorkflowOutboxRow[] claimed =
        check storage:claimWorkflowOperations(WF_TUNNEL_RUNTIME_ID, 10);
    test:assertTrue(claimed.length() >= 1, "The queued mutation must be claimable");

    // Whichever node wins this write is the node that raises the notification or writes the
    // audit record, so a redelivered result cannot double-report an outcome.
    test:assertTrue(check storage:completeWorkflowOperation(operationId, types:WF_OP_COMPLETED,
            "{\"httpStatus\":200}"), "The first result must be recorded");
    test:assertFalse(check storage:completeWorkflowOperation(operationId, types:WF_OP_COMPLETED,
            "{\"httpStatus\":200}"), "A duplicate result must record nothing");

    types:WorkflowOutboxRow? stored = check storage:getWorkflowOperation(operationId);
    if stored is types:WorkflowOutboxRow {
        test:assertEquals(stored.status, types:WF_OP_COMPLETED);
    }
}

@test:Config {groups: ["workflow_tunnel"]}
function testMutationClaimIsAddressedAndBounded() returns error? {
    int now = storage:wfNowEpoch();
    // Addressed to a runtime that is not the seeded one: claiming for that runtime must
    // return nothing. The bridge's replay cache is per process, so a mutation reaching a
    // second runtime of the same integration would execute twice.
    _ = check storage:enqueueWorkflowOperation({
        operationId: "wfo-addressed-" + now.toString(),
        runtimeId: "990e8400-e29b-41d4-a716-4466554400ff",
        scopeKey: WF_TUNNEL_SCOPE,
        status: types:WF_OP_PENDING,
        issuedAt: now,
        deadline: now + 1800,
        payload: tunnelRequest("humanTasks.fail")
    });
    types:WorkflowOutboxRow[] claimed =
        check storage:claimWorkflowOperations(WF_TUNNEL_RUNTIME_ID, 10);
    foreach types:WorkflowOutboxRow operation in claimed {
        test:assertEquals(operation.runtimeId, WF_TUNNEL_RUNTIME_ID,
            "A mutation must only ever be claimed by the runtime it was addressed to");
    }
}

@test:Config {groups: ["workflow_tunnel"]}
function testDeadlineExpiresAnUnconfirmedMutation() returns error? {
    int now = storage:wfNowEpoch();
    string operationId = "wfo-expire-" + now.toString();
    _ = check storage:enqueueWorkflowOperation({
        operationId: operationId,
        runtimeId: WF_TUNNEL_RUNTIME_ID,
        scopeKey: WF_TUNNEL_SCOPE,
        status: types:WF_OP_PENDING,
        issuedAt: now - 3600,
        deadline: now - 60,
        payload: tunnelRequest("instances.suspend")
    });

    // A past deadline must also make the row undeliverable, not merely sweepable: this is
    // what stops a backlog being handed to a runtime that comes back after an outage.
    types:WorkflowOutboxRow[] claimed =
        check storage:claimWorkflowOperations(WF_TUNNEL_RUNTIME_ID, 10);
    foreach types:WorkflowOutboxRow operation in claimed {
        test:assertNotEquals(operation.operationId, operationId,
            "An expired mutation must never be delivered");
    }

    types:WorkflowOutboxRow[] expired = check storage:sweepWorkflowTunnel(2100, 300);
    // The sweeper must name what it expired: an unconfirmed mutation nobody can name is one
    // nobody can be told about.
    boolean named = false;
    foreach types:WorkflowOutboxRow row in expired {
        if row.operationId == operationId {
            named = true;
        }
    }
    test:assertTrue(named, "The sweeper must report the operation it expired");
    types:WorkflowOutboxRow? swept = check storage:getWorkflowOperation(operationId);
    if swept is types:WorkflowOutboxRow {
        test:assertEquals(swept.status, types:WF_OP_EXPIRED,
            "An unconfirmed mutation must end EXPIRED so it can be surfaced, not dropped");
    }
}

// ── Boost ────────────────────────────────────────────────────────────────────

@test:Config {groups: ["workflow_tunnel"]}
function testBoostWindowIsSharedThroughTheDatabase() returns error? {
    int until = storage:wfNowEpoch() + 30;
    check storage:boostWorkflowScope(WF_TUNNEL_COMPONENT_ID, WF_TUNNEL_ENVIRONMENT_ID, until);
    // Any node answering this runtime's heartbeat reads the same window, which is the point:
    // an in-memory window would boost only the node that served the user's request.
    int remaining = check storage:workflowBoostRemaining(WF_TUNNEL_RUNTIME_ID);
    test:assertTrue(remaining > 0 && remaining <= 30,
        "The boost window must be visible to every node, got: " + remaining.toString());
}
