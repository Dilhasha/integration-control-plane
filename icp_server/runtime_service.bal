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
    string? secretId;
    string actualSecret;
|};

// Parses an HMAC secret that may contain a secretId prefix (format: secretId.actualSecret).
// If the secret contains a period, splits it and returns both parts.
// Otherwise, returns the entire string as the actualSecret with no secretId.
// Validates that the actualSecret is at least 32 bytes (256 bits) as required for HS256.
isolated function parseHmacSecret(string hmacSecret) returns ParsedSecret|error {
    int? periodIndex = hmacSecret.indexOf(".");
    if periodIndex is int && periodIndex > 0 {
        string secretId = hmacSecret.substring(0, periodIndex);
        string actualSecret = hmacSecret.substring(periodIndex + 1);

        // Validate that actualSecret is non-empty after splitting
        if actualSecret.length() == 0 {
            log:printError(string `Invalid HMAC secret format: actualSecret is empty after splitting. Secret format must be 'secretId.actualSecret' where actualSecret is non-empty.`);
            return error(string `Invalid HMAC secret: actualSecret cannot be empty (format: ${secretId}.)`);
        }

        // Validate minimum secret length for HS256 (32 bytes / 256 bits)
        if actualSecret.length() < 32 {
            log:printError(string `Invalid HMAC secret: actualSecret too short (${actualSecret.length()} bytes, minimum 32 bytes required for HS256)`);
            return error(string `Invalid HMAC secret: actualSecret must be at least 32 bytes (current: ${actualSecret.length()} bytes)`);
        }

        log:printDebug(string `Parsed HMAC secret with secretId prefix: secretId=${secretId}, secretLength=${actualSecret.length()}`);
        return {
            secretId: secretId,
            actualSecret: actualSecret
        };
    }

    // Validate that hmacSecret is non-empty in the no-period case
    if hmacSecret.length() == 0 {
        log:printError(string `Invalid HMAC secret: secret cannot be empty`);
        return error("Invalid HMAC secret: secret cannot be empty");
    }

    // Validate minimum secret length for HS256 (32 bytes / 256 bits)
    if hmacSecret.length() < 32 {
        log:printError(string `Invalid HMAC secret: secret too short (${hmacSecret.length()} bytes, minimum 32 bytes required for HS256)`);
        return error(string `Invalid HMAC secret: secret must be at least 32 bytes (current: ${hmacSecret.length()} bytes)`);
    }

    log:printDebug(string `Parsed HMAC secret without secretId prefix, secretLength=${hmacSecret.length()}`);
    return {
        secretId: (),
        actualSecret: hmacSecret
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

    // Parse the secret to extract secretId (if present) and actualSecret
    ParsedSecret|error parsedResult = parseHmacSecret(hmacSecret);
    if parsedResult is error {
        log:printError(string `Failed to parse HMAC secret: ${parsedResult.message()}`);
        return <http:Unauthorized>{body: "Invalid server configuration"};
    }
    ParsedSecret parsedSecret = parsedResult;
    log:printDebug(string `Validating JWT with secretId=${parsedSecret.secretId ?: "none"}`);

    jwt:ValidatorConfig validatorConfig = {
        issuer: jwtIssuer,
        audience: jwtAudience,
        clockSkew: jwtClockSkewSeconds,
        signatureConfig: {secret: parsedSecret.actualSecret}
    };

    jwt:Payload|jwt:Error validatedPayload = jwt:validate(jwtToken, validatorConfig);
    if validatedPayload is jwt:Error {
        log:printWarn(string `JWT validation failed: ${validatedPayload.message()}`);
        return <http:Unauthorized>{body: "Invalid or expired token"};
    }

    log:printDebug(string `JWT signature validated successfully`);

    // If a secretId prefix was present, verify it matches the JWT claim
    string? expectedSecretId = parsedSecret.secretId;
    if expectedSecretId is string {
        anydata secretIdClaim = validatedPayload["secretId"];
        if !(secretIdClaim is string && secretIdClaim == expectedSecretId) {
            string claimValue = secretIdClaim is string ? secretIdClaim : "missing or invalid";
            log:printDebug(string `secretId mismatch: expected ${expectedSecretId}, got ${claimValue}`);
            return <http:Unauthorized>{body: "Invalid secretId claim"};
        }
        log:printDebug(string `secretId claim validated successfully: ${expectedSecretId}`);
    }

    // Enforce the runtime_agent scope
    anydata scope = validatedPayload["scope"];
    if !(scope is string && scope == "runtime_agent") {
        return <http:Unauthorized>{body: "Insufficient scope — 'runtime_agent' required"};
    }

    return (); // authentication and authorisation passed
}

