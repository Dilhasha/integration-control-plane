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

import ballerina/test;

// Workflow metadata ingestion tests: the bi_workflow_metadata rows written off full
// heartbeats, the field negotiation advertising "workflowMetadata", and the GraphQL
// definitions source reading stored metadata instead of live-calling the runtime.
//
// Uses Component 2 / Prod with dedicated runtimes so the workflow proxy tests'
// component (Component 1 / Dev) keeps exercising the legacy live-fetch path.

const string WF_META_RUNTIME_ID = "aa000002-test-test-test-000000000003";
const string WF_META_RUNTIME_2_ID = "aa000002-test-test-test-000000000004";

// A minimal workflow metadata document in the shape the ICP bridge publishes.
final map<json> & readonly WF_META_DOCUMENT = {
    metadataVersion: "1.0",
    definitions: [
        {workflowType: "expenseApproval", kind: "WORKFLOW", inputSchema: "{\"type\":\"object\"}"}
    ],
    humanTasks: [
        {name: "expenseApproval.approve", resultSchema: "{\"type\":\"object\"}"}
    ],
    activities: [
        {workflowType: "expenseApproval", name: "recordApproval", inputSchema: "{\"type\":\"object\"}"}
    ],
    reviewActions: ["proceed", "proceed-with-input", "reject"],
    agents: []
};

function buildWorkflowMetadataHeartbeat(string runtimeId, string runtimeName,
        boolean withMetadata) returns types:Heartbeat {
    types:Heartbeat heartbeat = buildWorkflowHeartbeat(runtimeId, runtimeName,
            WF_COMPONENT_2_ID, WF_PROD_ENV_ID, ());
    if withMetadata {
        heartbeat.workflowMetadata = WF_META_DOCUMENT.clone();
        heartbeat.capabilities = ["workflowCommands"];
    }
    return heartbeat;
}

@test:AfterGroups {value: ["workflow-metadata"]}
function cleanupWorkflowMetadataTests() {
    cleanupRuntime(WF_META_RUNTIME_ID);
    cleanupRuntime(WF_META_RUNTIME_2_ID);
}

// The server advertises the workflowMetadata field so bridges know to attach it, and a
// full heartbeat carrying the document lands as this runtime's bi_workflow_metadata row
// (with its advertised capabilities). A later full heartbeat WITHOUT the document clears
// the row — delete-then-insert, same semantics as packed OpenAPI definitions.
@test:Config {groups: ["workflow-metadata"]}
function testWorkflowMetadataUpsertFromHeartbeat() returns error? {
    cleanupRuntime(WF_META_RUNTIME_ID);

    types:HeartbeatResponse response = check storage:processHeartbeat(
            buildWorkflowMetadataHeartbeat(WF_META_RUNTIME_ID, "wf-meta-test-runtime", true),
            preResolved = true);
    test:assertTrue(response.acknowledged);
    test:assertTrue(response.supportedHeartbeatFields.indexOf("workflowMetadata") is int,
        "The server must advertise the workflowMetadata heartbeat field");

    types:WorkflowMetadataRecord? stored = check storage:getWorkflowMetadataForRuntime(WF_META_RUNTIME_ID);
    if stored is () {
        test:assertFail("The heartbeat's workflow metadata must be stored");
    }
    json storedDocument = check stored.metadata.fromJsonString();
    test:assertEquals(check storedDocument.metadataVersion, "1.0");
    test:assertEquals(stored.capabilities, "workflowCommands");

    // Re-sending the same heartbeat replaces the row without erroring (idempotent upsert).
    types:HeartbeatResponse repeat = check storage:processHeartbeat(
            buildWorkflowMetadataHeartbeat(WF_META_RUNTIME_ID, "wf-meta-test-runtime", true),
            preResolved = true);
    test:assertTrue(repeat.acknowledged);
    test:assertTrue(check storage:getWorkflowMetadataForRuntime(WF_META_RUNTIME_ID)
        is types:WorkflowMetadataRecord);

    // A full heartbeat without the document clears the stored row.
    types:HeartbeatResponse withoutMetadata = check storage:processHeartbeat(
            buildWorkflowMetadataHeartbeat(WF_META_RUNTIME_ID, "wf-meta-test-runtime", false),
            preResolved = true);
    test:assertTrue(withoutMetadata.acknowledged);
    test:assertTrue(check storage:getWorkflowMetadataForRuntime(WF_META_RUNTIME_ID) is (),
        "A full heartbeat without metadata must clear the stored row");
}

// The definitions resolver prefers stored metadata: no call into the integration, one
// Workflow item per workflow type deduped across the component's runtimes, workerCount =
// number of RUNNING runtimes declaring the type.
@test:Config {groups: ["workflow-metadata"]}
function testWorkflowDefinitionsFromStoredMetadata() returns error? {
    cleanupRuntime(WF_META_RUNTIME_ID);
    cleanupRuntime(WF_META_RUNTIME_2_ID);

    _ = check storage:processHeartbeat(
            buildWorkflowMetadataHeartbeat(WF_META_RUNTIME_ID, "wf-meta-test-runtime", true),
            preResolved = true);
    _ = check storage:processHeartbeat(
            buildWorkflowMetadataHeartbeat(WF_META_RUNTIME_2_ID, "wf-meta-test-runtime-2", true),
            preResolved = true);

    types:WorkflowMetadataRecord[] records =
        check storage:getWorkflowMetadataForComponentEnv(WF_COMPONENT_2_ID, WF_PROD_ENV_ID);
    test:assertEquals(records.length(), 2, "Both RUNNING runtimes' metadata must be returned");

    types:Workflow[] definitions = check fetchWorkflowDefinitions(WF_COMPONENT_2_ID, WF_PROD_ENV_ID);
    test:assertEquals(definitions.length(), 1,
        "The same workflow type from two runtimes must dedupe to one definition");
    test:assertEquals(definitions[0].name, "expenseApproval");
    test:assertTrue(definitions[0].isActive);
    test:assertEquals(definitions[0].workerCount, 2,
        "workerCount must be the number of RUNNING runtimes declaring the type");
    test:assertEquals(definitions[0].state, types:ENABLED);
    test:assertEquals(definitions[0].inputSchema, "{\"type\":\"object\"}");
}
