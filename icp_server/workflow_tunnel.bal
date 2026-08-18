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

import ballerina/http;
import ballerina/lang.runtime;
import ballerina/log;
import ballerina/time;
import ballerina/uuid;

// ============================================================================
// WORKFLOW COMMAND TUNNEL
// ============================================================================
// Executes workflow management operations WITHOUT any network path into the
// integration or its Temporal server: a command is queued here, delivered to the
// target runtime inside its next heartbeat response (a WORKFLOW_MGMT control
// command), executed in-process by the runtime's ICP bridge, and its result posted
// back on POST /icp/commandResult — correlated to the waiting frontend request by
// commandId. Latency is managed with a boost hint: while a user is actively working
// with workflow views, heartbeat responses carry a nextHeartbeatInSeconds cadence so the
// bridge polls faster than its regular interval. The cadence decays back to the regular
// interval as the runtime goes idle — a runtime is not kept at one heartbeat per second
// because someone once opened a workflow view.
//
// All state is in-memory, matching the ICP's single-instance architecture (like the
// runtime hash cache): a restart loses in-flight commands, whose callers time out
// and retry.

// How long a frontend request waits for the runtime's result. Must stay inside the
// frontend's 30s request timeout.
const decimal WORKFLOW_COMMAND_WAIT_SECONDS = 25;
// Waiter poll granularity.
const decimal WORKFLOW_COMMAND_POLL_SECONDS = 0.1;
// The cadence asked of a boosted runtime, decaying back to its own interval as it goes
// idle. Each step is [seconds since the last workflow request, cadence to ask for while
// the elapsed time is below it]: one heartbeat per second while a user is likely still
// clicking, then 2s, 5s, and 10s. A flat window at 1s was the first design and cost too
// much: a runtime serving non-workflow traffic kept heartbeating every second long after
// the last workflow view was closed. Every workflow request resets the ramp, so an active
// session still gets the fastest cadence.
//
// The bridge ignores a hint that is not shorter than its own interval, so the last step is
// a no-op for a runtime already on a 10s interval and a mild speed-up for a slower one.
final readonly & [int, int][] WORKFLOW_BOOST_RAMP = [[5, 1], [10, 2], [20, 5], [30, 10]];
// The capability a runtime must have advertised to receive WORKFLOW_MGMT commands.
const string WORKFLOW_COMMANDS_CAPABILITY = "workflowCommands";

// All tunnel state in one record so a single lock covers it (a lock statement may
// access only one isolated module-level variable).
type WorkflowTunnelState record {|
    // runtimeId → commands queued for delivery in its next heartbeat response.
    map<types:ControlCommand[]> pendingCommands = {};
    // commandId → arrived result, until the waiter collects it.
    map<types:WorkflowCommandResult> results = {};
    // commandId → the runtimeId the command was issued to, for as long as a waiter is live.
    // Results for unknown ids are dropped (late arrivals), and a result from any other
    // runtime is refused: the id alone must not be enough to answer someone else's command.
    map<string> waiting = {};
    // runtimeId → unix seconds of the last workflow request for it, which is where the
    // boost ramp is measured from.
    map<int> boostedAt = {};
|};

isolated WorkflowTunnelState workflowTunnel = {};

// Queues a command for the runtime and registers its waiter.
isolated function enqueueWorkflowCommand(string runtimeId, types:ControlCommand command) {
    lock {
        types:ControlCommand[]? queue = workflowTunnel.pendingCommands[runtimeId];
        if queue is types:ControlCommand[] {
            queue.push(command.clone());
        } else {
            workflowTunnel.pendingCommands[runtimeId] = [command.clone()];
        }
        workflowTunnel.waiting[command.commandId] = runtimeId;
    }
}

// Removes and returns the commands queued for a runtime — called from the heartbeat
// and delta-heartbeat handlers so the commands ride the response.
isolated function takePendingWorkflowCommands(string runtimeId) returns types:ControlCommand[] {
    lock {
        types:ControlCommand[]? queue = workflowTunnel.pendingCommands.removeIfHasKey(runtimeId);
        return queue is types:ControlCommand[] ? queue.clone() : [];
    }
}

// Records a result posted by a runtime. Returns false for unknown/late commandIds
// (the waiter already timed out, or the id was never issued) — those are dropped.
isolated function completeWorkflowCommand(types:WorkflowCommandResult result) returns boolean {
    lock {
        string? issuedTo = workflowTunnel.waiting[result.commandId];
        if issuedTo is () {
            return false;
        }
        if issuedTo != result.runtimeId {
            // Every runtime agent in the organization authenticates the same way, so the
            // command id alone would let one of them answer a command queued for another —
            // and that answer is relayed to the console as the operation's result.
            log:printWarn(string `Refusing a workflow command result from the wrong runtime`,
                    commandId = result.commandId, issuedTo = issuedTo, reportedBy = result.runtimeId);
            return false;
        }
        workflowTunnel.results[result.commandId] = result.clone();
        return true;
    }
}

// Blocks until the command's result arrives or the wait deadline passes. On timeout
// the waiter is deregistered and, if the command was never delivered, it is removed
// from its runtime's queue so a dead runtime doesn't accumulate stale commands.
isolated function awaitWorkflowCommandResult(string commandId, string runtimeId,
        decimal waitSeconds = WORKFLOW_COMMAND_WAIT_SECONDS) returns types:WorkflowCommandResult? {
    decimal waited = 0;
    while waited <= waitSeconds {
        lock {
            types:WorkflowCommandResult? result = workflowTunnel.results.removeIfHasKey(commandId);
            if result is types:WorkflowCommandResult {
                _ = workflowTunnel.waiting.removeIfHasKey(commandId);
                return result.clone();
            }
        }
        runtime:sleep(WORKFLOW_COMMAND_POLL_SECONDS);
        waited += WORKFLOW_COMMAND_POLL_SECONDS;
    }
    lock {
        _ = workflowTunnel.waiting.removeIfHasKey(commandId);
        types:ControlCommand[]? queue = workflowTunnel.pendingCommands[runtimeId];
        if queue is types:ControlCommand[] {
            types:ControlCommand[] remaining = [];
            foreach types:ControlCommand queued in queue {
                if queued.commandId != commandId {
                    remaining.push(queued);
                }
            }
            workflowTunnel.pendingCommands[runtimeId] = remaining;
        }
    }
    return ();
}

// Merges the runtime's queued workflow commands into a heartbeat (or delta-heartbeat)
// response and stamps the boost hint when the runtime is boosted. Called from the
// runtime service for every acknowledged heartbeat.
isolated function deliverWorkflowCommands(string runtimeId, types:HeartbeatResponse heartbeatResponse) {
    types:ControlCommand[] tunnelCommands = takePendingWorkflowCommands(runtimeId);
    if tunnelCommands.length() > 0 {
        log:printDebug(string `Delivering ${tunnelCommands.length()} workflow commands to runtime ${runtimeId}`);
        types:ControlCommand[]? existing = heartbeatResponse.commands;
        if existing is types:ControlCommand[] {
            foreach types:ControlCommand command in tunnelCommands {
                existing.push(command);
            }
        } else {
            heartbeatResponse.commands = tunnelCommands;
        }
    }
    int? boostHint = workflowBoostHint(runtimeId);
    if boostHint is int {
        heartbeatResponse.nextHeartbeatInSeconds = boostHint;
    }
}

// Marks a runtime boosted, restarting the decay ramp: its heartbeat responses ask for the
// fastest cadence again. Called for every workflow request against the runtime, so an
// active user keeps it at the top of the ramp.
isolated function boostWorkflowRuntime(string runtimeId) {
    lock {
        workflowTunnel.boostedAt[runtimeId] = nowUnixSeconds();
    }
}

// The nextHeartbeatInSeconds hint for a runtime: the ramp step its idle time falls in, or
// () once the ramp has run out and the runtime should return to its own interval.
isolated function workflowBoostHint(string runtimeId) returns int? {
    lock {
        int? boostedAt = workflowTunnel.boostedAt[runtimeId];
        if boostedAt is () {
            return ();
        }
        int idleSeconds = nowUnixSeconds() - boostedAt;
        foreach [int, int] [rampUntil, cadence] in WORKFLOW_BOOST_RAMP {
            if idleSeconds < rampUntil {
                return cadence;
            }
        }
        // Ramp exhausted: stop tracking the runtime rather than re-evaluating it on every
        // heartbeat for as long as it lives.
        _ = workflowTunnel.boostedAt.removeIfHasKey(runtimeId);
        return ();
    }
}

isolated function nowUnixSeconds() returns int {
    return time:utcNow()[0];
}

// Picks the runtime that should execute tunneled workflow commands for a
// component+environment: the freshest-heartbeat RUNNING runtime that advertised the
// workflowCommands capability, or () when there is none — the caller then answers 503
// rather than serving anything stale.
isolated function selectWorkflowCommandTarget(string componentId, string environmentId)
        returns string?|error {
    types:WorkflowMetadataRecord[] metadataRecords =
        check storage:getWorkflowMetadataForComponentEnv(componentId, environmentId);
    foreach types:WorkflowMetadataRecord metadataRecord in metadataRecords {
        string? capabilities = metadataRecord.capabilities;
        if capabilities is string {
            foreach string capability in re `,`.split(capabilities) {
                if capability.trim() == WORKFLOW_COMMANDS_CAPABILITY {
                    return metadataRecord.runtimeId;
                }
            }
        }
    }
    return ();
}

// Executes one workflow management operation through the tunnel and maps the outcome to
// an HTTP response for the console: the runtime's status, and the same JSON document its
// management REST API would have returned (re-serialized, so formatting is normalized —
// the values are not).
isolated function executeTunneledWorkflowCommand(string runtimeId, string operation,
        map<json> params, string userId, string[] roles) returns http:Response {
    string commandId = "wfc-" + uuid:createType4AsString();
    time:Utc now = time:utcNow();
    map<json> payload = {
        commandId: commandId,
        operation: operation,
        params: params,
        identity: {userId: userId, roles: roles},
        deadline: time:utcToString(time:utcAddSeconds(now, WORKFLOW_COMMAND_WAIT_SECONDS))
    };
    types:ControlCommand command = {
        commandId: commandId,
        runtimeId: runtimeId,
        targetArtifact: {name: "workflow"},
        action: types:WORKFLOW_MGMT,
        issuedAt: now,
        status: types:PENDING,
        payload: payload.toJsonString()
    };
    enqueueWorkflowCommand(runtimeId, command);
    boostWorkflowRuntime(runtimeId);

    types:WorkflowCommandResult? result = awaitWorkflowCommandResult(commandId, runtimeId);
    if result is () {
        log:printWarn(string `Workflow command timed out waiting for runtime ${runtimeId}`,
                operation = operation, commandId = commandId);
        return workflowErrorResponse(504,
                "The workflow runtime did not respond in time; please retry");
    }
    if result.httpStatus < 100 || result.httpStatus > 599 {
        // The status is whatever the runtime reported; an out-of-range value would produce a
        // malformed response to the console rather than a diagnosable failure.
        log:printWarn(string `Runtime ${runtimeId} reported an invalid HTTP status`,
                operation = operation, commandId = commandId, httpStatus = result.httpStatus);
        return workflowErrorResponse(502, "The workflow runtime returned an invalid response");
    }
    http:Response response = new;
    response.statusCode = result.httpStatus;
    response.setJsonPayload(result.body);
    return response;
}

// ── Request → operation mapping ──────────────────────────────────────────────
// Maps a /icp/workflow/{componentId}/{environmentId}/{...wfPath} request to the
// dot-qualified operation vocabulary the runtime's dispatcher executes. Returns () for
// paths outside the vocabulary — including the deprecated /retry-tasks aliases, which
// used to reach the runtime through the callback-URL proxy. That proxy is gone, so those
// paths now answer 404 instead.

final string[] & readonly WF_INSTANCE_SUBRESOURCES = ["history", "activity-tree", "execution-graph"];
final string[] & readonly WF_INSTANCE_ACTIONS = ["suspend", "resume", "terminate", "cancel"];

isolated function mapWorkflowRequestToOperation(string method, string[] wfPath,
        map<json> queryParams, map<json> body) returns [string, map<json>]? {
    int segments = wfPath.length();
    if segments == 0 {
        return ();
    }
    string first = wfPath[0];

    if method == http:GET {
        match first {
            "definitions" if segments == 1 => {
                return ["definitions.list", {}];
            }
            "workflows" => {
                if segments == 1 {
                    return ["instances.list", queryParams];
                }
                string workflowId = wfPath[1];
                if segments == 2 {
                    return ["instances.get", {workflowId: workflowId}];
                }
                if segments == 3 {
                    string sub = wfPath[2];
                    if WF_INSTANCE_SUBRESOURCES.indexOf(sub) is int {
                        return [instanceSubresourceOperation(sub), {workflowId: workflowId}];
                    }
                    // Not a known subresource → an exact run: GET workflows/{id}/{runId}
                    return ["instances.get", {workflowId: workflowId, runId: sub}];
                }
                if segments == 4 && WF_INSTANCE_SUBRESOURCES.indexOf(wfPath[3]) is int {
                    return [instanceSubresourceOperation(wfPath[3]),
                        {workflowId: workflowId, runId: wfPath[2]}];
                }
            }
            "human-tasks" => {
                if segments == 1 {
                    return ["humanTasks.list", queryParams];
                }
                if segments == 2 {
                    return wfPath[1] == "pending-count"
                        ? ["humanTasks.pendingCount", {}]
                        : ["humanTasks.get", {taskId: wfPath[1]}];
                }
            }
            "review-activities" => {
                if segments == 1 {
                    return ["reviewActivities.list", queryParams];
                }
                if segments == 2 {
                    return ["reviewActivities.get", {taskId: wfPath[1]}];
                }
            }
        }
        return ();
    }

    if method != http:POST {
        return ();
    }
    match first {
        "workflows" => {
            if segments == 1 {
                // Fill workflowId so a retried start is idempotent on the runtime side.
                map<json> params = body.clone();
                if params["workflowId"] !is string {
                    params["workflowId"] = "workflow-" + uuid:createType4AsString();
                }
                return ["instances.start", params];
            }
            if segments == 3 && WF_INSTANCE_ACTIONS.indexOf(wfPath[2]) is int {
                map<json> params = {workflowId: wfPath[1]};
                if wfPath[2] == "terminate" && body["reason"] is string {
                    params["reason"] = body["reason"];
                }
                return ["instances." + wfPath[2], params];
            }
            if segments == 4 && WF_INSTANCE_ACTIONS.indexOf(wfPath[3]) is int {
                map<json> params = {workflowId: wfPath[1], runId: wfPath[2]};
                if wfPath[3] == "terminate" && body["reason"] is string {
                    params["reason"] = body["reason"];
                }
                return ["instances." + wfPath[3], params];
            }
        }
        "human-tasks" if segments == 3 => {
            string taskId = wfPath[1];
            if wfPath[2] == "complete" {
                return ["humanTasks.complete", {taskId: taskId, result: body["result"]}];
            }
            if wfPath[2] == "fail" {
                map<json> params = {taskId: taskId, reason: body["reason"]};
                if body["details"] is map<json> {
                    params["details"] = body["details"];
                }
                return ["humanTasks.fail", params];
            }
        }
        "review-activities" if segments == 3 => {
            string action = wfPath[2];
            if action == "proceed" || action == "proceed-with-input" || action == "reject" {
                map<json> params = {taskId: wfPath[1], action: action};
                if body["input"] is map<json> {
                    params["input"] = body["input"];
                }
                if body["feedback"] is string {
                    params["feedback"] = body["feedback"];
                }
                return ["reviewActivities.decide", params];
            }
        }
    }
    return ();
}

isolated function instanceSubresourceOperation(string sub) returns string {
    match sub {
        "history" => {
            return "instances.history";
        }
        "activity-tree" => {
            return "instances.activityTree";
        }
        _ => {
            return "instances.executionGraph";
        }
    }
}

// Converts a request's query params into the command's params map, preserving the
// types the runtime-side dispatcher expects: `limit` becomes an int, `onlyMyTasks` a
// boolean, everything else the first string value.
isolated function workflowQueryParams(map<string[]> rawQueryParams) returns map<json> {
    map<json> params = {};
    foreach [string, string[]] [key, values] in rawQueryParams.entries() {
        if values.length() == 0 {
            continue;
        }
        string value = values[0];
        if key == "limit" {
            int|error limitValue = int:fromString(value);
            if limitValue is int {
                params[key] = limitValue;
            }
        } else if key == "onlyMyTasks" {
            params[key] = value == "true";
        } else {
            params[key] = value;
        }
    }
    return params;
}
