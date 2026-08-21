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

import icp_server.types;

import ballerina/log;
import ballerina/sql;
import ballerina/time;

// ============================================================================
// STATELESS WORKFLOW TUNNEL — STORAGE
// ============================================================================
// Every piece of tunnel state lives in wf_read_cache and wf_operation_outbox, shared by
// all ICP nodes, because the node that takes a user's request is usually not the node
// that receives the runtime's next heartbeat. Nothing here may be cached in a
// module-level variable: that would reintroduce node affinity, and the symptom (works on
// one node, intermittently stuck on two) is expensive to diagnose.
//
// Two properties do the work that locking would otherwise be needed for:
//
//   1. Coalescing is the primary key. Concurrent identical reads race to INSERT the same
//      cache_key; the loser reads the winner's row. No SELECT-then-INSERT window.
//   2. Fencing is the fetch id. A result is only accepted by the attempt that is still
//      current, so a late answer from a superseded or invalidated fetch is discarded
//      rather than resurrecting state a mutation removed.
//
// Redelivery is safe because the bridge replays a command id it has already executed, so
// a claim does not have to be exclusive across ICP nodes — two nodes handing out the same
// row causes a replay, not a second execution.

// A read whose command was claimed but produced no result within this many seconds is
// offered again. It bounds the loss when a heartbeat response is dropped in transit,
// without a delivery-acknowledgement round trip.
const int WF_READ_REDELIVER_AFTER_SECONDS = 20;

# Current epoch seconds, the unit every time column in these two tables uses.
#
# + return - Seconds since the Unix epoch
public isolated function wfNowEpoch() returns int => time:utcNow()[0];

// ── Read cache ───────────────────────────────────────────────────────────────

# Reads one cache row.
#
# + cacheKey - The request's key: scope, operation, params and the caller's role set
# + return - The row, `()` when nothing is cached, or an error
public isolated function getWorkflowCacheRow(string cacheKey)
        returns types:WorkflowCacheRow?|error {
    types:WorkflowCacheRow|sql:Error row = dbClient->queryRow(`
        SELECT cache_key, scope_key, request, fetch_id, status, expires_at, claimed_at, payload
        FROM wf_read_cache
        WHERE cache_key = ${cacheKey}
    `);
    if row is sql:NoRowsError {
        return ();
    }
    if row is sql:Error {
        return error(string `Failed to read the workflow cache`, row);
    }
    return row;
}

# Creates a FETCHING row, claiming the right to fetch this request.
#
# The insert *is* the coalescing mechanism: when several requests for the same key arrive
# at once — on one node or on several — exactly one insert succeeds and the rest are told
# to poll instead of issuing their own command.
#
# + cacheKey - The request's key
# + scopeKey - `componentId:environmentId`; the invalidation unit, and never role-scoped,
#              since a mutation must invalidate every role set's view
# + request - What to execute: `{operation, params, identity}` as JSON
# + fetchId - This attempt's id, which becomes the command id
# + expiresAt - Epoch seconds after which an unanswered row is abandoned
# + return - `true` when this caller owns the fetch, `false` when another already does
public isolated function startWorkflowCacheFetch(string cacheKey, string scopeKey,
        string request, string fetchId, int expiresAt) returns boolean|error {
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        INSERT INTO wf_read_cache (cache_key, scope_key, request, fetch_id, status, expires_at)
        VALUES (${cacheKey}, ${scopeKey}, ${request}, ${fetchId}, ${types:WF_CACHE_FETCHING},
                ${expiresAt})
    `);
    if result is sql:Error {
        if classifySqlError(result) == DUPLICATE_KEY {
            // Another request created the row first. Both callers poll the same row.
            return false;
        }
        return error(string `Failed to start a workflow cache fetch`, result);
    }
    return true;
}

# Claims the refresh of a row that is already serving a payload.
#
# A stale row keeps its payload and its READY status while it refreshes, so the caller
# still gets data — `fetch_id` alone marks a refresh as in flight. Only the caller that
# wins this update issues a command.
#
# + cacheKey - The request's key
# + fetchId - This attempt's id, which becomes the command id
# + request - The refreshed request document, in case the earlier one is stale
# + expiresAt - New abandonment deadline for the in-flight fetch
# + return - `true` when this caller owns the refresh, `false` when one is already running
public isolated function claimWorkflowCacheRefresh(string cacheKey, string fetchId,
        string request, int expiresAt) returns boolean|error {
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        UPDATE wf_read_cache
        SET fetch_id = ${fetchId}, request = ${request}, claimed_at = NULL,
            expires_at = ${expiresAt}
        WHERE cache_key = ${cacheKey} AND fetch_id IS NULL
    `);
    if result is sql:Error {
        return error(string `Failed to claim a workflow cache refresh`, result);
    }
    int? affected = result.affectedRowCount;
    return affected is int && affected > 0;
}

# Records a fetched result, or discards it.
#
# The update is fenced on `fetch_id`: zero rows affected means the attempt was
# invalidated by a mutation or superseded by a newer attempt, so its payload describes a
# world that no longer exists and must not be stored. This is what stops a late result
# resurrecting a task somebody has completed.
#
# + cacheKey - The request's key
# + fetchId - The attempt this result belongs to
# + payload - The response document
# + expiresAt - Epoch seconds until the entry goes stale
# + return - `true` when stored, `false` when discarded as superseded, or an error
public isolated function completeWorkflowCacheFetch(string cacheKey, string fetchId,
        string payload, int expiresAt) returns boolean|error {
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        UPDATE wf_read_cache
        SET status = ${types:WF_CACHE_READY}, payload = ${payload}, expires_at = ${expiresAt},
            fetch_id = NULL, claimed_at = NULL
        WHERE cache_key = ${cacheKey} AND fetch_id = ${fetchId}
    `);
    if result is sql:Error {
        return error(string `Failed to store a workflow cache result`, result);
    }
    int? affected = result.affectedRowCount;
    boolean stored = affected is int && affected > 0;
    if !stored {
        log:printDebug("Discarded a superseded workflow cache result", cacheKey = cacheKey,
                fetchId = fetchId);
    }
    return stored;
}

# Records that a fetch failed. Fenced exactly like a success.
#
# A row that already holds a payload keeps it: a failed refresh is a reason to go on
# serving the last good answer, not to throw it away.
#
# + cacheKey - The request's key
# + fetchId - The attempt this failure belongs to
# + errorPayload - The failure as a response document
# + expiresAt - Epoch seconds until the failed entry is retried
# + return - `true` when recorded, `false` when discarded as superseded, or an error
public isolated function failWorkflowCacheFetch(string cacheKey, string fetchId,
        string errorPayload, int expiresAt) returns boolean|error {
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        UPDATE wf_read_cache
        SET status = CASE WHEN payload IS NULL THEN ${types:WF_CACHE_FAILED} ELSE status END,
            payload = CASE WHEN payload IS NULL THEN ${errorPayload} ELSE payload END,
            expires_at = ${expiresAt}, fetch_id = NULL, claimed_at = NULL
        WHERE cache_key = ${cacheKey} AND fetch_id = ${fetchId}
    `);
    if result is sql:Error {
        return error(string `Failed to record a workflow cache failure`, result);
    }
    int? affected = result.affectedRowCount;
    return affected is int && affected > 0;
}

# Marks a scope's live entries stale, without deleting them.
#
# Called when a mutation completes — never when one is submitted, because until the
# integration confirms it the world has not changed and the cached answer is still
# correct.
#
# Stale rows keep serving while they refresh, which is the point: deleting them would
# empty the cache faster than it could be rebuilt whenever several people are working in
# the same environment, and everyone would be left watching a spinner.
#
# Entries whose expiry is far in the future are the immutable ones — a closed instance's
# history cannot be falsified by anything — so they are left alone.
#
# + scopeKey - `componentId:environmentId`
# + liveHorizonSeconds - Only rows expiring within this many seconds are marked; longer
#                        TTLs identify terminal, immutable data
# + return - How many entries were marked, or an error
public isolated function staleWorkflowCacheScope(string scopeKey, int liveHorizonSeconds)
        returns int|error {
    int now = wfNowEpoch();
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        UPDATE wf_read_cache
        SET expires_at = ${now}
        WHERE scope_key = ${scopeKey}
          AND expires_at > ${now}
          AND expires_at < ${now + liveHorizonSeconds}
    `);
    if result is sql:Error {
        return error(string `Failed to invalidate the workflow cache for a scope`, result);
    }
    int? affected = result.affectedRowCount;
    return affected is int ? affected : 0;
}

# Expires one cached read on demand — the `?refresh=true` escape hatch. The entry is not
# deleted: the stale payload keeps serving (with its age shown) while the refresh the caller
# forced runs behind it. A no-op for an entry that is already stale or absent.
#
# + cacheKey - The entry to expire
# + return - An error only when the database itself failed
public isolated function expireWorkflowCacheEntry(string cacheKey) returns error? {
    int now = wfNowEpoch();
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        UPDATE wf_read_cache
        SET expires_at = ${now}
        WHERE cache_key = ${cacheKey} AND expires_at > ${now}
    `);
    if result is sql:Error {
        return error(string `Failed to expire a workflow cache entry`, result);
    }
    return ();
}

# Takes up to `count` reads a runtime should execute, oldest claim first.
#
# Rows already claimed are offered again only after `WF_READ_REDELIVER_AFTER_SECONDS`, so
# a dropped heartbeat response costs one delay rather than a stuck request. Redelivery is
# safe because the bridge replays a command id it has already executed.
#
# + scopeKey - The scope this runtime serves
# + count - Hard cap on how many reads one heartbeat may carry
# + return - The reads to send, or an error
public isolated function claimWorkflowCacheReads(string scopeKey, int count)
        returns types:WorkflowPendingRead[]|error {
    int now = wfNowEpoch();
    int redeliverBefore = now - WF_READ_REDELIVER_AFTER_SECONDS;
    sql:ParameterizedQuery query = `
        SELECT cache_key, fetch_id, request
        FROM wf_read_cache
        WHERE scope_key = ${scopeKey}
          AND fetch_id IS NOT NULL
          AND (claimed_at IS NULL OR claimed_at < ${redeliverBefore})
        ORDER BY created_at
    `;
    query = appendLimitClause(query, count);
    types:WorkflowPendingRead[] reads = [];
    do {
        stream<types:WorkflowPendingRead, sql:Error?> rows = dbClient->query(query);
        check from types:WorkflowPendingRead read in rows
            do {
                reads.push(read);
            };
    } on fail error e {
        return error("Failed to claim workflow cache reads", e);
    }
    foreach types:WorkflowPendingRead read in reads {
        // Best effort: a stamp that does not land means the read is offered once more,
        // which the bridge absorbs as a replay.
        sql:ExecutionResult|sql:Error stamp = dbClient->execute(`
            UPDATE wf_read_cache SET claimed_at = ${now}
            WHERE cache_key = ${read.cacheKey} AND fetch_id = ${read.fetchId}
        `);
        if stamp is sql:Error {
            log:printWarn("Failed to stamp a claimed workflow read", stamp,
                    cacheKey = read.cacheKey);
        }
    }
    return reads;
}

// ── Mutation outbox ──────────────────────────────────────────────────────────

# Queues a mutation for delivery to one runtime.
#
# `operationId` is the caller's idempotency key, so a resubmitted click collides on the
# primary key instead of becoming a second operation — the one duplicate the ICP can
# genuinely prevent. Two *different* users acting on the same task are two operations by
# design: one succeeds and the other must be told it lost.
#
# + operation - The row to queue, with its payload and deadline already built
# + return - `true` when queued, `false` when this idempotency key already exists
public isolated function enqueueWorkflowOperation(types:WorkflowOutboxRow operation)
        returns boolean|error {
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        INSERT INTO wf_operation_outbox (operation_id, runtime_id, scope_key, status,
                                         issued_at, deadline, payload)
        VALUES (${operation.operationId}, ${operation.runtimeId}, ${operation.scopeKey},
                ${types:WF_OP_PENDING}, ${operation.issuedAt}, ${operation.deadline},
                ${operation.payload})
    `);
    if result is sql:Error {
        if classifySqlError(result) == DUPLICATE_KEY {
            return false;
        }
        return error(string `Failed to queue a workflow operation`, result);
    }
    return true;
}

# Reads one queued or finished mutation, which is what the console polls.
#
# + operationId - The operation's id
# + return - The row, `()` when unknown, or an error
public isolated function getWorkflowOperation(string operationId)
        returns types:WorkflowOutboxRow?|error {
    types:WorkflowOutboxRow|sql:Error row = dbClient->queryRow(`
        SELECT operation_id, runtime_id, scope_key, status, issued_at, deadline,
               delivered_at, completed_at, payload, result
        FROM wf_operation_outbox
        WHERE operation_id = ${operationId}
    `);
    if row is sql:NoRowsError {
        return ();
    }
    if row is sql:Error {
        return error(string `Failed to read a workflow operation`, row);
    }
    return row;
}

# Takes up to `count` mutations addressed to this runtime, oldest first.
#
# Addressed to *this* runtime and no other: the bridge's replay cache is per process, so
# the same command reaching two runtimes of one integration would execute twice. Expired
# rows are filtered out here as well as swept, so a mutation whose deadline has passed is
# never delivered.
#
# + runtimeId - The runtime whose heartbeat is being answered
# + count - Hard cap on how many mutations one heartbeat may carry
# + return - The mutations to send, or an error
public isolated function claimWorkflowOperations(string runtimeId, int count)
        returns types:WorkflowOutboxRow[]|error {
    int now = wfNowEpoch();
    sql:ParameterizedQuery query = `
        SELECT operation_id, runtime_id, scope_key, status, issued_at, deadline,
               delivered_at, completed_at, payload, result
        FROM wf_operation_outbox
        WHERE runtime_id = ${runtimeId}
          AND status = ${types:WF_OP_PENDING}
          AND deadline > ${now}
        ORDER BY issued_at
    `;
    query = appendLimitClause(query, count);
    types:WorkflowOutboxRow[] operations = [];
    do {
        stream<types:WorkflowOutboxRow, sql:Error?> rows = dbClient->query(query);
        check from types:WorkflowOutboxRow operation in rows
            do {
                operations.push(operation);
            };
    } on fail error e {
        return error("Failed to claim workflow operations", e);
    }
    foreach types:WorkflowOutboxRow operation in operations {
        sql:ExecutionResult|sql:Error marked = dbClient->execute(`
            UPDATE wf_operation_outbox
            SET status = ${types:WF_OP_DELIVERED}, delivered_at = ${now}
            WHERE operation_id = ${operation.operationId} AND status = ${types:WF_OP_PENDING}
        `);
        if marked is sql:Error {
            log:printWarn("Failed to mark a workflow operation delivered", marked,
                    operationId = operation.operationId);
        }
    }
    return operations;
}

# Records a mutation's outcome, first write wins.
#
# Fenced on DELIVERED so a duplicate result — a redelivery the runtime replayed, or a
# result arriving at two nodes — updates nothing the second time. The caller writes the
# audit record or the notification only when this returns `true`, so an outcome is
# recorded exactly once no matter which node received it.
#
# + operationId - The operation's id
# + status - `COMPLETED` or `FAILED`
# + result - The outcome document, including the error code when it failed
# + return - `true` when this call recorded the outcome, `false` when it was already
#            recorded, or an error
public isolated function completeWorkflowOperation(string operationId, string status,
        string result) returns boolean|error {
    sql:ExecutionResult|sql:Error updated = dbClient->execute(`
        UPDATE wf_operation_outbox
        SET status = ${status}, result = ${result}, completed_at = ${wfNowEpoch()}
        WHERE operation_id = ${operationId} AND status = ${types:WF_OP_DELIVERED}
    `);
    if updated is sql:Error {
        return error(string `Failed to record a workflow operation outcome`, updated);
    }
    int? affected = updated.affectedRowCount;
    return affected is int && affected > 0;
}

// ── Sweeper ──────────────────────────────────────────────────────────────────

# Expires unconfirmed mutations and deletes what is no longer servable.
#
# Every statement is idempotent and none depends on which node runs it, so both ICP nodes
# sweeping is harmless and no leader election is needed.
#
# Order matters: mutations are expired before finished rows are deleted, so a mutation
# that timed out in this same pass still becomes a notification rather than vanishing.
#
# + staleRetentionSeconds - How long past expiry a cache row stays servable
# + completedRetentionSeconds - How long a recorded outcome stays readable by the console
# + return - The operations this pass expired, so the caller can surface each one, or an error
public isolated function sweepWorkflowTunnel(int staleRetentionSeconds,
        int completedRetentionSeconds) returns types:WorkflowOutboxRow[]|error {
    int now = wfNowEpoch();

    // Read the rows about to expire before expiring them: a caller that cannot name the
    // operations it lost cannot tell anyone about them, and an unconfirmed mutation that
    // nobody hears about is exactly the silent loss this design exists to prevent.
    types:WorkflowOutboxRow[] expiring = [];
    do {
        stream<types:WorkflowOutboxRow, sql:Error?> rows = dbClient->query(`
            SELECT operation_id, runtime_id, scope_key, status, issued_at, deadline,
                   delivered_at, completed_at, payload, result
            FROM wf_operation_outbox
            WHERE deadline < ${now}
              AND status IN (${types:WF_OP_PENDING}, ${types:WF_OP_DELIVERED})
        `);
        check from types:WorkflowOutboxRow row in rows
            do {
                expiring.push(row);
            };
    } on fail error e {
        return error("Failed to read expiring workflow operations", e);
    }

    // 1. A mutation past its deadline was never confirmed. It becomes EXPIRED so the
    //    caller can raise the notification that says so — the outcome nobody established
    //    is exactly what must not be dropped silently.
    sql:ExecutionResult|sql:Error expired = dbClient->execute(`
        UPDATE wf_operation_outbox
        SET status = ${types:WF_OP_EXPIRED}, completed_at = ${now}
        WHERE deadline < ${now}
          AND status IN (${types:WF_OP_PENDING}, ${types:WF_OP_DELIVERED})
    `);
    if expired is sql:Error {
        return error(string `Failed to expire unconfirmed workflow operations`, expired);
    }
    int? expiredCount = expired.affectedRowCount;
    if expiredCount is int && expiredCount > 0 {
        log:printWarn(string `${expiredCount} workflow operation(s) expired unconfirmed`);
    }

    // 2. Cache rows past the window in which they would still have been served.
    sql:ExecutionResult|sql:Error dropped = dbClient->execute(`
        DELETE FROM wf_read_cache WHERE expires_at < ${now - staleRetentionSeconds}
    `);
    if dropped is sql:Error {
        return error(string `Failed to sweep the workflow cache`, dropped);
    }

    // 3. Mutations whose outcome is recorded elsewhere (audit log for a success, an
    //    unresolved system event for a failure), and which the console has had time to
    //    read. FAILED and EXPIRED rows stay until their notification is resolved.
    sql:ExecutionResult|sql:Error finished = dbClient->execute(`
        DELETE FROM wf_operation_outbox
        WHERE status = ${types:WF_OP_COMPLETED}
          AND completed_at < ${now - completedRetentionSeconds}
    `);
    if finished is sql:Error {
        return error(string `Failed to sweep completed workflow operations`, finished);
    }
    return expiring;
}

// ── Boost window ─────────────────────────────────────────────────────────────
// A runtime whose scope somebody is actively working in is asked to heartbeat faster, so
// queued reads and mutations are picked up in about a second rather than on its normal
// interval. The window lives on the runtime row rather than in memory for the same reason
// everything else here does: the node that serves the user's request is usually not the
// node that answers the heartbeat, so an in-memory window would boost the wrong half of
// the time.

# Extends the boost window for every runtime in a scope.
#
# + componentId - The component whose runtimes are serving these views
# + environmentId - The environment
# + until - Epoch seconds up to which fast heartbeats are wanted
# + return - An error if the update failed
public isolated function boostWorkflowScope(string componentId, string environmentId, int until)
        returns error? {
    sql:ExecutionResult|sql:Error result = dbClient->execute(`
        UPDATE runtimes
        SET wf_boosted_until = ${until}
        WHERE component_id = ${componentId} AND environment_id = ${environmentId}
          AND (wf_boosted_until IS NULL OR wf_boosted_until < ${until})
    `);
    if result is sql:Error {
        return error(string `Failed to boost the workflow scope`, result);
    }
    return ();
}

# Reads how long a runtime's boost has left, for the heartbeat cadence hint.
#
# + runtimeId - The runtime being answered
# + return - Seconds of boost remaining (0 when not boosted), or an error
public isolated function workflowBoostRemaining(string runtimeId) returns int|error {
    record {|int? wf_boosted_until;|}|sql:Error row = dbClient->queryRow(`
        SELECT wf_boosted_until FROM runtimes WHERE runtime_id = ${runtimeId}
    `);
    if row is sql:NoRowsError {
        return 0;
    }
    if row is sql:Error {
        return error(string `Failed to read the workflow boost window`, row);
    }
    int? until = row.wf_boosted_until;
    if until is () {
        return 0;
    }
    int remaining = until - wfNowEpoch();
    return remaining > 0 ? remaining : 0;
}

# The scope a runtime serves and how much boost it has left, in ONE query.
#
# Folded together deliberately. Every heartbeat of every runtime runs this, and the pool is
# small (`maxOpenConnections` defaults to 10 per node): two queries where one will do is a
# steady multiplier on a resource whose exhaustion does not degrade gracefully - a
# transaction holding a connection while its flow waits for a second one deadlocks the pool
# rather than slowing down.
#
# A dedicated query rather than `getRuntimeById`, because the mapped `Runtime` record does
# not carry these columns and the delivery path needs nothing else.
#
# + runtimeId - The runtime being answered
# + return - `[componentId, environmentId, boostSecondsRemaining]`, `()` when the runtime is
#            unknown or has no component, or an error
public isolated function getWorkflowScopeForRuntime(string runtimeId)
        returns [string, string, int]?|error {
    record {|string? component_id; string environment_id; int? wf_boosted_until;|}|sql:Error row =
        dbClient->queryRow(`
        SELECT component_id, environment_id, wf_boosted_until
        FROM runtimes WHERE runtime_id = ${runtimeId}
    `);
    if row is sql:NoRowsError {
        return ();
    }
    if row is sql:Error {
        return error(string `Failed to read a runtime's workflow scope`, row);
    }
    string? componentId = row.component_id;
    if componentId is () {
        return ();
    }
    int? until = row.wf_boosted_until;
    int remaining = until is int ? until - wfNowEpoch() : 0;
    return [componentId, row.environment_id, remaining > 0 ? remaining : 0];
}
