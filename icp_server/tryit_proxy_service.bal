// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import icp_server.auth;
import icp_server.storage;
import icp_server.types;

import ballerina/http;
import ballerina/log;

// ── Try-It proxy ─────────────────────────────────────────────────────────────
// Forwards frontend "Try it out" requests (Test Console) to a specific, user-chosen runtime
// instance. Requests can no longer go straight from the browser to the runtime's own listener
// address: that address is frequently a bind-all address (0.0.0.0), the runtime's own listener
// has no CORS policy for the ICP frontend's origin, and the runtime may sit on a network the
// browser can't reach directly at all.
//
// Frontend → GET/POST/PUT/PATCH/DELETE/HEAD https://<icp>/icp/tryit/{componentId}/{environmentId}/{runtimeId}/{port}/<path>
//          → forwarded to <try_it_host>:{port}/<path> (scheme from the target listener's protocol)
//
// Unlike the workflow proxy (which auto-picks any RUNNING runtime for a component+environment),
// runtimeId here is explicitly chosen by the frontend user, so componentId/environmentId are
// used purely as an ownership check (see storage:getTryItTarget) rather than for resolution.
//
// The incoming Authorization header is ICP's own JWT (validates this service's own auth) and is
// stripped before forwarding. The caller's desired header for the *target* service travels as
// X-Tryit-Header-Name/X-Tryit-Header-Value instead, so it can't collide with (and overwrite) the
// ICP JWT even when the user's target header also happens to be named "Authorization".

// Certificate validation for https targets is on by default. Set to true only to deliberately
// accept self-signed certs (K8s-internal / dev without a trusted chain).
configurable boolean tryitProxyAllowInsecureTLS = false;

// Request timeout (seconds) for calls to the target runtime.
configurable decimal tryitProxyTimeout = 30;

const int TRYIT_CLIENT_CACHE_MAX_SIZE = 100;
isolated map<http:Client> tryitClientCache = {};

// Headers that must never be set from the X-Tryit-Header-Name envelope — setting these would
// desync the forwarded request from Ballerina's own framing of it (e.g. a stale Content-Length
// after the interceptor already fixed up the body).
final string[] & readonly BLOCKED_HEADER_NAMES = ["host", "content-length", "transfer-encoding", "connection"];

// Evicts cached clients whose base URL no longer belongs to a live (RUNNING, registered) runtime+port.
isolated function pruneTryitClientCache() {
    string[]|error liveUrls = storage:getLiveTryItBaseUrls();
    if liveUrls is error {
        log:printWarn("Try-It client cache prune skipped — failed to look up running runtimes",
                'error = liveUrls);
        return;
    }
    map<()> liveSetMut = {};
    foreach string url in liveUrls {
        liveSetMut[url] = ();
    }
    final readonly & map<()> liveSet = liveSetMut.cloneReadOnly();
    lock {
        foreach string cachedUrl in tryitClientCache.keys() {
            if !liveSet.hasKey(cachedUrl) {
                _ = tryitClientCache.remove(cachedUrl);
            }
        }
    }
}

isolated function getTryitClient(string baseUrl) returns http:Client|error {
    lock {
        if tryitClientCache.hasKey(baseUrl) {
            return tryitClientCache.get(baseUrl);
        }
    }
    http:ClientConfiguration cfg = {timeout: tryitProxyTimeout};
    if baseUrl.startsWith("https") && tryitProxyAllowInsecureTLS {
        cfg.secureSocket = {enable: false};
    }
    http:Client newClient = check new (baseUrl, cfg);
    lock {
        // Re-check in case another worker created it meanwhile.
        if tryitClientCache.hasKey(baseUrl) {
            return tryitClientCache.get(baseUrl);
        }
        if tryitClientCache.length() >= TRYIT_CLIENT_CACHE_MAX_SIZE {
            tryitClientCache.removeAll();
        }
        tryitClientCache[baseUrl] = newClient;
    }
    return newClient;
}

isolated function tryitErrorResponse(int statusCode, string message) returns http:Response {
    http:Response res = new;
    res.statusCode = statusCode;
    res.setJsonPayload({"error": {"message": message}});
    return res;
}

// Performs auth, runtime resolution, header rewrite and forwarding for one Try-It request;
// returns the response to relay to the caller.
function proxyTryItRequest(string componentId, string environmentId, string runtimeId, int port,
        string[] restPath, http:Request req) returns http:Response {
    // 1. Identify the caller from the (already JWT-validated) Authorization header.
    string|http:HeaderNotFoundError authHeader = req.getHeader("Authorization");
    if authHeader is http:HeaderNotFoundError {
        return tryitErrorResponse(401, "Authorization header missing");
    }
    types:UserContextV2|error userContext = auth:extractUserContextV2(authHeader);
    if userContext is error {
        return tryitErrorResponse(401, "Invalid token: " + userContext.message());
    }

    // 2. Authorize — Try-It can trigger arbitrary side effects (POST/PUT/DELETE), so every
    //    method (including GET) requires edit/manage-level access, not just view.
    string|error projectId = storage:getProjectIdByComponentId(componentId);
    if projectId is error {
        return tryitErrorResponse(404, "Component not found: " + componentId);
    }
    types:AccessScope scope = auth:buildAccessScope(projectId, componentId, environmentId);
    boolean|error permitted = auth:hasAnyPermission(userContext.userId,
            [auth:PERMISSION_INTEGRATION_EDIT, auth:PERMISSION_INTEGRATION_MANAGE], scope);
    if permitted is error {
        return tryitErrorResponse(500, "Authorization check failed: " + permitted.message());
    }
    if !permitted {
        log:printWarn("Try-It proxy access denied", userId = userContext.userId, componentId = componentId,
                runtimeId = runtimeId, method = req.method);
        return tryitErrorResponse(403, "Access denied");
    }

    // 3. Resolve the target runtime's reachable host — this also doubles as the ownership check
    //    (runtimeId must belong to componentId+environmentId) and the port check (port must be
    //    one of that runtime's actually-registered listener ports).
    types:TryItTarget?|error target = storage:getTryItTarget(componentId, environmentId, runtimeId, port);
    if target is error {
        return tryitErrorResponse(500, "Failed to resolve target runtime: " + target.message());
    }
    if target is () {
        return tryitErrorResponse(404,
                "No running runtime with that id/port was found for this component and environment");
    }

    // 4. Build the target path — no fixed prefix here (unlike the workflow proxy's "/workflow/"),
    //    so an empty restPath must still produce "/" rather than "".
    string subPath = string:'join("/", ...restPath);
    string rawPath = req.rawPath;
    int? qIdx = rawPath.indexOf("?");
    string query = qIdx is int ? rawPath.substring(qIdx) : "";
    string targetPath = "/" + subPath + query;

    // 5. Header rewrite: drop ICP's own bearer token, and translate the envelope
    //    (X-Tryit-Header-Name/Value) into the real header the target service expects.
    string|http:HeaderNotFoundError tryitHeaderName = req.getHeader("X-Tryit-Header-Name");
    string|http:HeaderNotFoundError tryitHeaderValue = req.getHeader("X-Tryit-Header-Value");
    req.removeHeader("X-Tryit-Header-Name");
    req.removeHeader("X-Tryit-Header-Value");
    req.removeHeader("Authorization");
    if tryitHeaderName is string && tryitHeaderValue is string {
        string trimmedName = tryitHeaderName.trim();
        if trimmedName != "" && tryitHeaderValue != "" && BLOCKED_HEADER_NAMES.indexOf(trimmedName.toLowerAscii()) is () {
            req.setHeader(trimmedName, tryitHeaderValue);
        }
    }

    // 6. Forward (method + body preserved) and relay the upstream response.
    string baseUrl = storage:tryitScheme(target.protocol) + "://" + target.host + ":" + port.toString();
    http:Client|error tryitClient = getTryitClient(baseUrl);
    if tryitClient is error {
        return tryitErrorResponse(502, "Failed to connect to target runtime: " + tryitClient.message());
    }
    http:Response|error upstream = tryitClient->forward(targetPath, req);
    if upstream is error {
        log:printError("Try-It proxy forward failed", upstream, targetPath = targetPath, baseUrl = baseUrl);
        return tryitErrorResponse(502, "Target runtime request failed: " + upstream.message());
    }
    return upstream;
}

@http:ServiceConfig {
    auth: [
        {
            jwtValidatorConfig: {
                issuer: frontendJwtIssuer,
                audience: frontendJwtAudience,
                signatureConfig: {
                    secret: resolvedFrontendJwtHMACSecret
                }
            }
        }
    ],
    cors: {
        allowOrigins: normalizedCorsAllowedOrigins,
        allowHeaders: ["Content-Type", "Authorization", "X-Tryit-Header-Name", "X-Tryit-Header-Value"]
    }
}
service /icp/tryit on httpListener {

    function init() {
        log:printInfo("Try-It proxy started at " + serverHost + ":" + serverPort.toString());
    }

    // Explicit per-method accessors (not 'default) so CORS preflight OPTIONS is auto-handled by
    // the listener and not subjected to service auth — same reasoning as workflow_proxy_service.

    resource function get [string componentId]/[string environmentId]/[string runtimeId]/[int port]/[string... restPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(proxyTryItRequest(componentId, environmentId, runtimeId, port, restPath, req));
    }

    resource function post [string componentId]/[string environmentId]/[string runtimeId]/[int port]/[string... restPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(proxyTryItRequest(componentId, environmentId, runtimeId, port, restPath, req));
    }

    resource function put [string componentId]/[string environmentId]/[string runtimeId]/[int port]/[string... restPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(proxyTryItRequest(componentId, environmentId, runtimeId, port, restPath, req));
    }

    resource function patch [string componentId]/[string environmentId]/[string runtimeId]/[int port]/[string... restPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(proxyTryItRequest(componentId, environmentId, runtimeId, port, restPath, req));
    }

    resource function delete [string componentId]/[string environmentId]/[string runtimeId]/[int port]/[string... restPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(proxyTryItRequest(componentId, environmentId, runtimeId, port, restPath, req));
    }

    resource function head [string componentId]/[string environmentId]/[string runtimeId]/[int port]/[string... restPath](http:Caller caller, http:Request req) returns error? {
        check caller->respond(proxyTryItRequest(componentId, environmentId, runtimeId, port, restPath, req));
    }
}
