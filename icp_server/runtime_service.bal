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

import icp_server.storage as storage;
import icp_server.types as types;

import ballerina/http;
import ballerina/jwt;
import ballerina/log;

// HTTP service configuration
listener http:Listener httpListener = new (serverPort,
    config = {
        host: serverHost,
        secureSocket: {
            key: {
                path: keystorePath,
                password: resolvedKeystorePassword
            }
        }
    }
);

// Runtime management service
// Per-environment JWT validation: the @http:ServiceConfig auth block is intentionally
// removed so that each heartbeat request can be validated against its own environment's
// HMAC secret (stored in the database). validateRuntimeJwt() is called explicitly at
// the start of every resource function.
service /icp on httpListener {

    function init() {
        log:printInfo("Runtime service started at " + serverHost + ":" + serverPort.toString());
    }

    // Process heartbeat from runtime
    isolated resource function post heartbeat(http:Request request, @http:Payload json heartbeatJson)
            returns types:HeartbeatResponse|http:Unauthorized|error? {
        do {
            types:Heartbeat heartbeat = check heartbeatJson.cloneWithType(types:Heartbeat);

            // heartbeat.component and heartbeat.environment carry handler/name strings
            // as written in the runtime's Config.toml (integration = "<handler>",
            // environment = "<name>").  component_environment_secrets is keyed by UUID,
            // so resolve both names to their canonical IDs before the secret lookup.
            string componentId = check storage:getComponentIdByName(heartbeat.component);
            string environmentId = check storage:getEnvironmentIdByName(heartbeat.environment);

            // Resolve the HMAC secret for this component+environment pair and validate the bearer JWT.
            string jwtSecret = check storage:resolveComponentEnvJwtSecret(componentId, environmentId);
            http:Unauthorized? authResult = validateRuntimeJwt(request, jwtSecret);
            if authResult is http:Unauthorized {
                log:printWarn(string `Heartbeat rejected — invalid JWT for component: ${heartbeat.component}, environment: ${heartbeat.environment}`);
                return authResult;
            }

            // Process heartbeat using the repository (handles both registration and updates)
            types:HeartbeatResponse heartbeatResponse = check storage:processHeartbeat(heartbeat);
            log:printInfo(string `Heartbeat processed successfully for ${heartbeat.runtime}`);
            return heartbeatResponse;

        } on fail error e {
            // Return error response
            log:printError("Failed to process heartbeat", e);
            types:HeartbeatResponse errorResponse = {
                acknowledged: false,
                commands: [],
                errors: [e.message()]
            };
            return errorResponse;
        }
    }

    // Process delta heartbeat from runtime
    isolated resource function post deltaHeartbeat(http:Request request, @http:Payload types:DeltaHeartbeat deltaHeartbeat)
            returns types:HeartbeatResponse|http:Unauthorized|error? {
        do {
            // Resolve the HMAC secret via runtime ID (environment is not in the delta payload)
            // and validate the bearer JWT before processing.
            string jwtSecret = check storage:resolveRuntimeJwtSecretByRuntimeId(deltaHeartbeat.runtime);
            http:Unauthorized? authResult = validateRuntimeJwt(request, jwtSecret);
            if authResult is http:Unauthorized {
                log:printWarn(string `Delta heartbeat rejected — invalid JWT for runtime: ${deltaHeartbeat.runtime}`);
                return authResult;
            }

            // Process delta heartbeat using the repository
            types:HeartbeatResponse heartbeatResponse = check storage:processDeltaHeartbeat(deltaHeartbeat);
            log:printInfo(string `Delta heartbeat processed successfully for ${deltaHeartbeat.runtime}`);
            return heartbeatResponse;

        } on fail error e {
            // Return error response
            log:printError("Failed to process delta heartbeat", e);
            types:HeartbeatResponse errorResponse = {
                acknowledged: false,
                fullHeartbeatRequired: true,
                commands: []
            };
            return errorResponse;
        }
    }

}

// ---------------------------------------------------------------------------
// JWT Secret Parsing Helper
// ---------------------------------------------------------------------------
// Record type to hold parsed secret components
type ParsedSecret record {|
    string keyId;  // Key ID as per RFC 7515 (can be empty string)
    string keyMaterial;
|};

// Parses an HMAC secret in the format: keyId.keyMaterial
// The keyId (Key ID) can be empty (e.g., ".keyMaterial"), but the period is required.
// Validates that the keyMaterial is at least 32 bytes (256 bits) as required for HS256.
isolated function parseHmacSecret(string hmacSecret) returns ParsedSecret|error {
    int? periodIndex = hmacSecret.indexOf(".");

    // Period is required in the secret format
    if periodIndex is () {
        log:printError(string `Invalid HMAC secret format: missing period separator. Secret format must be 'keyId.keyMaterial' (keyId can be empty: '.keyMaterial')`);
        return error("Invalid HMAC secret: format must be 'keyId.keyMaterial' with period separator");
    }

    string keyId = hmacSecret.substring(0, periodIndex);
    string keyMaterial = hmacSecret.substring(periodIndex + 1);

    // Validate that keyMaterial is non-empty after splitting
    if keyMaterial.length() == 0 {
        log:printError(string `Invalid HMAC secret format: keyMaterial is empty after splitting. Secret format must be 'keyId.keyMaterial' where keyMaterial is non-empty.`);
        return error(string `Invalid HMAC secret: keyMaterial cannot be empty (format: ${keyId}.)`);
    }

    // Validate minimum secret length for HS256 (32 bytes / 256 bits)
    if keyMaterial.length() < 32 {
        log:printError(string `Invalid HMAC secret: keyMaterial too short (${keyMaterial.length()} bytes, minimum 32 bytes required for HS256)`);
        return error(string `Invalid HMAC secret: keyMaterial must be at least 32 bytes (current: ${keyMaterial.length()} bytes)`);
    }

    return {
        keyId: keyId,
        keyMaterial: keyMaterial
    };
}

// ---------------------------------------------------------------------------
// Custom per-environment JWT validator
// ---------------------------------------------------------------------------
// Extracts the bearer token from the Authorization header and validates it
// against the provided HMAC secret. Returns http:Unauthorized when the token
// is missing, malformed, expired or signed with the wrong key; returns ()
// (nil) on success.
isolated function validateRuntimeJwt(http:Request request, string hmacSecret) returns http:Unauthorized? {
    string|error authHeader = request.getHeader("Authorization");
    if authHeader is error || !authHeader.startsWith("Bearer ") {
        return <http:Unauthorized>{body: "Missing or malformed Authorization header"};
    }

    string jwtToken = authHeader.substring(7);

    // Parse the secret to extract keyId and keyMaterial
    ParsedSecret|error parsedResult = parseHmacSecret(hmacSecret);
    if parsedResult is error {
        log:printError(string `Failed to parse HMAC secret: ${parsedResult.message()}`);
        return <http:Unauthorized>{body: "Invalid server configuration"};
    }
    ParsedSecret parsedSecret = parsedResult;

    jwt:ValidatorConfig validatorConfig = {
        issuer: jwtIssuer,
        audience: jwtAudience,
        clockSkew: jwtClockSkewSeconds,
        keyId: parsedSecret.keyId,
        signatureConfig: {secret: parsedSecret.keyMaterial}
    };

    jwt:Payload|jwt:Error validatedPayload = jwt:validate(jwtToken, validatorConfig);
    if validatedPayload is jwt:Error {
        log:printWarn(string `JWT validation failed: ${validatedPayload.message()}`);
        return <http:Unauthorized>{body: "Invalid or expired token"};
    }

    // Enforce the runtime_agent scope
    anydata scope = validatedPayload["scope"];
    if !(scope is string && scope == "runtime_agent") {
        return <http:Unauthorized>{body: "Insufficient scope — 'runtime_agent' required"};
    }

    return (); // authentication and authorisation passed
}

