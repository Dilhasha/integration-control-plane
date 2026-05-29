// Copyright (c) 2026, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
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

import icp_server.types;

import ballerina/data.jsondata;
import ballerina/log;
import ballerina/sql;
import ballerina/time;

// === INSERT ===

// Create a new control command history record
public isolated function insertControlCommandHistory(
        string commandId,
        string operationType,
        string artifactName,
        string artifactType,
        string componentId,
        string environmentId,
        string projectId,
        string runtimeType,
        string? initiatedBy,
        int totalRuntimes
) returns error? {
    log:printDebug("insertControlCommandHistory", commandId = commandId, operationType = operationType);

    sql:ParameterizedQuery query = `
        INSERT INTO control_command_history (
            command_id, operation_type, artifact_name, artifact_type,
            component_id, environment_id, project_id, runtime_type,
            initiated_by, total_runtimes, status
        ) VALUES (
            ${commandId}, ${operationType}, ${artifactName}, ${artifactType},
            ${componentId}, ${environmentId}, ${projectId}, ${runtimeType},
            ${initiatedBy}, ${totalRuntimes}, 'PENDING'
        )
    `;

    _ = check dbClient->execute(query);
    log:printDebug("insertControlCommandHistory done");
}

// === UPDATE ===

// Update command history with runtime results
public isolated function updateControlCommandHistory(
        string commandId,
        types:CommandStatus status,
        int successCount,
        int failedCount,
        types:RuntimeCommandResult[] runtimeResults,
        string? errorMessage = ()
) returns error? {
    log:printDebug("updateControlCommandHistory", commandId = commandId, status = status);

    // Serialize runtime results to JSON
    string runtimeResultsJson = check jsondata:toJson(runtimeResults).toJsonString();

    sql:ParameterizedQuery query = `
        UPDATE control_command_history
        SET status = ${status},
            success_count = ${successCount},
            failed_count = ${failedCount},
            runtime_results = ${runtimeResultsJson},
            error_message = ${errorMessage},
            completed_at = CURRENT_TIMESTAMP
        WHERE command_id = ${commandId}
    `;

    _ = check dbClient->execute(query);
    log:printDebug("updateControlCommandHistory done");
}

// Update command history status only (for IN_PROGRESS state)
public isolated function updateControlCommandStatus(
        string commandId,
        types:CommandStatus status
) returns error? {
    log:printDebug("updateControlCommandStatus", commandId = commandId, status = status);

    sql:ParameterizedQuery query = `
        UPDATE control_command_history
        SET status = ${status}
        WHERE command_id = ${commandId}
    `;

    _ = check dbClient->execute(query);
    log:printDebug("updateControlCommandStatus done");
}

// === READ ===

// Get control command history by ID
public isolated function getControlCommandHistory(string commandId) returns types:ControlCommandHistory|error {
    log:printDebug("getControlCommandHistory", commandId = commandId);

    stream<types:ControlCommandHistoryDBRecord, sql:Error?> rows = dbClient->query(`
        SELECT command_id, operation_type, artifact_name, artifact_type,
               component_id, environment_id, project_id, runtime_type,
               initiated_by, initiated_at, completed_at, status,
               total_runtimes, success_count, failed_count,
               runtime_results, error_message
        FROM control_command_history
        WHERE command_id = ${commandId}
    `);

    types:ControlCommandHistoryDBRecord[]|error records = from types:ControlCommandHistoryDBRecord row in rows
        select row;

    if records is error {
        return records;
    }

    if records.length() == 0 {
        return error("Command history not found");
    }

    return mapDBRecordToHistory(records[0]);
}

// Query control command history with filters
public isolated function queryControlCommandHistory(
        string? projectId = (),
        string? componentId = (),
        string? environmentId = (),
        types:CommandStatus? status = (),
        int 'limit = 50,
        int offset = 0
) returns types:ControlCommandHistory[]|error {
    log:printDebug("queryControlCommandHistory", projectId = projectId, componentId = componentId);

    // Build dynamic query
    sql:ParameterizedQuery baseQuery = `
        SELECT command_id, operation_type, artifact_name, artifact_type,
               component_id, environment_id, project_id, runtime_type,
               initiated_by, initiated_at, completed_at, status,
               total_runtimes, success_count, failed_count,
               runtime_results, error_message
        FROM control_command_history
        WHERE 1=1
    `;

    sql:ParameterizedQuery[] conditions = [];

    if projectId is string {
        conditions.push(` AND project_id = ${projectId}`);
    }
    if componentId is string {
        conditions.push(` AND component_id = ${componentId}`);
    }
    if environmentId is string {
        conditions.push(` AND environment_id = ${environmentId}`);
    }
    if status is types:CommandStatus {
        string statusStr = status.toString();
        conditions.push(` AND status = ${statusStr}`);
    }

    sql:ParameterizedQuery orderLimit = ` ORDER BY initiated_at DESC LIMIT ${'limit} OFFSET ${offset}`;

    // Combine all query parts
    sql:ParameterizedQuery fullQuery = sql:queryConcat(baseQuery, ...conditions, orderLimit);

    stream<types:ControlCommandHistoryDBRecord, sql:Error?> rows = dbClient->query(fullQuery);

    types:ControlCommandHistory[] result = [];
    check from types:ControlCommandHistoryDBRecord row in rows
        do {
            result.push(check mapDBRecordToHistory(row));
        };

    log:printDebug("queryControlCommandHistory done", count = result.length());
    return result;
}

// === DELETE ===

// Delete old command history records (for cleanup)
public isolated function deleteOldCommandHistory(int daysToKeep = 30) returns int|error {
    log:printDebug("deleteOldCommandHistory", daysToKeep = daysToKeep);

    sql:ParameterizedQuery query = `
        DELETE FROM control_command_history
        WHERE initiated_at < (CURRENT_TIMESTAMP - INTERVAL '${daysToKeep}' DAY)
    `;

    sql:ExecutionResult result = check dbClient->execute(query);
    int rowsAffected = result.affectedRowCount ?: 0;

    log:printDebug("deleteOldCommandHistory done", rowsDeleted = rowsAffected);
    return rowsAffected;
}

// === HELPER FUNCTIONS ===

// Map DB record to ControlCommandHistory type
isolated function mapDBRecordToHistory(types:ControlCommandHistoryDBRecord dbRecord) returns types:ControlCommandHistory|error {
    // Parse runtime results from JSON
    types:RuntimeCommandResult[] runtimeResults = [];
    if dbRecord.runtimeResults is string {
        runtimeResults = check jsondata:parseString(<string>dbRecord.runtimeResults).cloneWithType();
    }

    // Parse status enum
    types:CommandStatus statusEnum = check dbRecord.status.cloneWithType(types:CommandStatus);

    return {
        commandId: dbRecord.commandId,
        operationType: dbRecord.operationType,
        artifactName: dbRecord.artifactName,
        artifactType: dbRecord.artifactType,
        componentId: dbRecord.componentId,
        environmentId: dbRecord.environmentId,
        projectId: dbRecord.projectId,
        runtimeType: dbRecord.runtimeType,
        initiatedBy: dbRecord.initiatedBy,
        initiatedAt: dbRecord.initiatedAt,
        completedAt: dbRecord.completedAt,
        status: statusEnum,
        totalRuntimes: dbRecord.totalRuntimes,
        successCount: dbRecord.successCount,
        failedCount: dbRecord.failedCount,
        runtimeResults: runtimeResults,
        errorMessage: dbRecord.errorMessage
    };
}
