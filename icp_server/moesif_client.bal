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

import ballerina/http;
import ballerina/jwt;
import ballerina/log;
import ballerina/time;
import ballerina/url;

// Master switch for the Moesif metrics integration. When false, all Moesif
// GraphQL operations are rejected so metrics/logs are served purely from
// OpenSearch and no Moesif functionality is exposed. Keep this in sync with the
// frontend `VITE_MOESIF_ENABLED` flag (config.json). Enabled by default.
configurable boolean moesifEnabled = true;

// When true, Moesif API calls target the Moesif dev environment instead of
// production. Enable this only for testing the metrics integration against
// Moesif dev; it must remain false in production.
configurable boolean moesifIsDev = false;

// Base URL for the Moesif Management API. Overridable via configuration.
// See https://www.moesif.com/docs/api/ (Management API).
configurable string moesifManagementBaseUrl = "https://api.moesif.com/v1";

// Base URL for the Moesif Management API when `moesifIsDev` is true. Overridable
// via configuration so the dev host/path can be adjusted without a code change.
// Note: this is the Management API host (api-dev.moesif.com), not the Collector
// ingestion host (api-dev.moesif.net) — the latter does not serve /~/apps etc.
configurable string moesifDevManagementBaseUrl = "https://api-dev.moesif.com/v1";

// The Management API base URL actually used: the dev host when `moesifIsDev` is
// enabled, otherwise the production host.
final string effectiveMoesifManagementBaseUrl = moesifIsDev ? moesifDevManagementBaseUrl : moesifManagementBaseUrl;

// ── Canvas embed configuration ────────────────────────────────────────────
// The canvas embed uses a postMessage handshake instead of a URL-fragment
// token: the frontend loads `/embed/canvas#auth=post` and posts the auth token
// to the iframe over postMessage (SET_TOKEN). The canvas resolves the
// organization + application from the `org`/`app` claims of that token, so the
// ids are not part of the URL. `/embed/canvas` is Moesif's API-key canvas route:
// it accepts tokens minted from a Management API key and does not restrict the
// embedding page's origin. The portal route (`/wrap/app/<org>-<app>/canvas`)
// must NOT be used: it only answers parent origins on Moesif's build-time
// allowlist and rejects Management-API-key-derived tokens, so the handshake
// silently never completes. The canvas auth token is not supplied by the user:
// it is minted on demand from the stored Management API key as a short-lived,
// restricted token (see `mintMoesifCanvasToken`).

// Host for the embedded canvas viewer, selected by `moesifIsDev` (production vs
// Moesif dev). The iframe src is
// `${effectiveMoesifCanvasEmbedBaseUrl}/embed/canvas#auth=post`.
final string effectiveMoesifCanvasEmbedBaseUrl = moesifIsDev ? "https://web-dev.moesif.com" : "https://www.moesif.com";

// Request timeout (seconds) for Moesif Management API calls.
const decimal MOESIF_HTTP_TIMEOUT_SECONDS = 30;

// Shared Moesif Management API HTTP client, reused across requests instead of
// constructing a new client per call. The base URL is fixed and authentication
// is passed per-request as a Bearer header, so a single shared client is safe.
final http:Client moesifClient = check new (effectiveMoesifManagementBaseUrl, timeout = MOESIF_HTTP_TIMEOUT_SECONDS);

// `take` value for the "list applications" call. Moesif returns the full set of
// applications the Management API key can access regardless of this value, so
// the documented `take=0` is used to fetch them all in a single request.
const int MOESIF_APP_LIST_TAKE = 0;

// Lifetime (seconds) of the short-lived canvas token minted from the Management
// API key. Set to one hour so it comfortably outlives a canvas session while
// staying short-lived; the frontend refetches the embed (re-minting a fresh
// token) before this elapses.
const decimal MOESIF_CANVAS_TOKEN_TTL_SECONDS = 3600;

// Scope requested for the minted canvas token. Restricts the token to reading
// events only (the data the embedded canvas renders), rather than granting the
// full access of the Management API key it is derived from.
const string MOESIF_CANVAS_TOKEN_SCOPE = "read:events";

// Target requested for the minted canvas token. The canvas embed authenticates
// against the Moesif management surface, so the token is minted with the
// `management` target.
const string MOESIF_CANVAS_TOKEN_TARGET = "management";

// Normalizes a pasted Moesif Management API key by stripping a leading
// "Bearer " prefix (case-insensitive) if present, so users can paste the key
// either with or without the prefix. The Bearer prefix is added back when the
// Authorization header is constructed, so leaving it here would produce a
// malformed "Bearer Bearer <key>" header and fail authentication.
public isolated function stripBearerPrefix(string apiKey) returns string {
    string trimmed = apiKey.trim();
    if trimmed.toLowerAscii().startsWith("bearer ") {
        return trimmed.substring("bearer ".length()).trim();
    }
    return trimmed;
}

// Extracts the Moesif organization id from a Management API key. Moesif issues
// its Management API keys as JWTs scoped to an organization, carrying the org id
// in the `org` claim (e.g. "688:183"). Decoding it here lets the setup flow
// derive the organization id from the key the user already supplies, instead of
// asking them to paste the organization id separately. The token is decoded (not
// cryptographically validated) purely to read this claim; it is still sent to
// Moesif as a Bearer credential, which performs the actual authentication.
// Returns an error when the key is not a decodable JWT or lacks a usable `org`
// claim.
public isolated function decodeMoesifOrgId(string managementApiKey) returns string|error {
    return decodeMoesifClaim(managementApiKey, "org", "organization id");
}

// Extracts the Moesif Collector Application id from a Management API key. Moesif
// issues its Management API keys as JWTs scoped to an organization + application,
// carrying the application id in the `app` claim (e.g. "191:407"). Decoding it
// here lets the setup flow derive the application id from the key the user
// already supplies, instead of asking them to paste it or select it from the
// application list. Mirrors `decodeMoesifOrgId`: the token is decoded (not
// cryptographically validated) purely to read this claim. Returns an error when
// the key is not a decodable JWT or lacks a usable `app` claim.
public isolated function decodeMoesifAppId(string managementApiKey) returns string|error {
    return decodeMoesifClaim(managementApiKey, "app", "application id");
}

// Reads a single non-empty string claim from a Moesif Management API key, shared
// by the org/app id decoders above. `claimName` is the JWT claim to read and
// `label` names it in the error messages surfaced to the user.
isolated function decodeMoesifClaim(string managementApiKey, string claimName, string label) returns string|error {
    string token = stripBearerPrefix(managementApiKey);
    [jwt:Header, jwt:Payload]|jwt:Error decoded = jwt:decode(token);
    if decoded is jwt:Error {
        return error(string `Could not read the ${label} from the Moesif Management API key: the key is not a valid token`);
    }
    jwt:Payload payload = decoded[1];
    anydata claim = payload[claimName];
    if claim is string && claim.trim().length() > 0 {
        return claim.trim();
    }
    return error(string `The Moesif Management API key does not contain an ${label}`);
}

// Lists the Moesif applications the given Management API key can access, so the
// UI can present them for selection instead of asking the user to paste an
// Application ID. Calls the Moesif Management API `/~/apps` endpoint and maps
// each returned application to its id + name. Requires a Management API key with
// the `read:apps` scope. Returns an error when the request fails (e.g. an
// invalid key or a missing scope).
public isolated function listMoesifApplications(string managementApiKey)
        returns types:MoesifApplication[]|error {
    map<string|string[]> headers = {"Authorization": string `Bearer ${managementApiKey}`};

    json apps = check getFromMoesif(moesifClient,
            string `/~/apps?take=${MOESIF_APP_LIST_TAKE}`, headers, "applications");
    return extractMoesifApplications(apps);
}

// Mints a short-lived, restricted canvas token from the stored Management API
// key. A GET to Moesif's OAuth endpoint (`/~/oauth/access_tokens`) exchanges the
// (broad) Management API key for a token scoped to `read:events` with a bounded
// lifetime, so the token delivered to the embedded canvas cannot be used for
// anything beyond rendering event data and expires on its own. The target,
// scope and expiration are passed as query parameters; the expiration is an
// ISO-8601 timestamp (now + `MOESIF_CANVAS_TOKEN_TTL_SECONDS`), URL-encoded,
// matching the format Moesif expects (e.g. `2026-09-01T04:57:58.264Z`). Returns
// an error when the key is empty, the request fails, or the response carries no
// token.
public isolated function mintMoesifCanvasToken(string managementApiKey) returns string|error {
    string trimmedKey = stripBearerPrefix(managementApiKey);
    if trimmedKey.length() == 0 {
        return error("Moesif canvas token minting requires a Management API key");
    }

    time:Utc expiry = time:utcAddSeconds(time:utcNow(), MOESIF_CANVAS_TOKEN_TTL_SECONDS);
    string expiration = time:utcToString(expiry);
    string encodedExpiration = check url:encode(expiration, "UTF-8");
    string encodedScope = check url:encode(MOESIF_CANVAS_TOKEN_SCOPE, "UTF-8");
    string encodedTarget = check url:encode(MOESIF_CANVAS_TOKEN_TARGET, "UTF-8");
    string path = string `/~/oauth/access_tokens?target=${encodedTarget}&scope=${encodedScope}&expiration=${encodedExpiration}`;

    // Log only non-sensitive request context. The Management API key, its prefix,
    // and the full URL (which carries query parameters) are secrets/PII and must
    // never be logged. Kept at DEBUG so it is off by default.
    log:printDebug("Minting Moesif canvas token",
            baseUrl = effectiveMoesifManagementBaseUrl,
            target = MOESIF_CANVAS_TOKEN_TARGET,
            scope = MOESIF_CANVAS_TOKEN_SCOPE,
            expiration = expiration);

    map<string|string[]> headers = {"Authorization": string `Bearer ${trimmedKey}`};
    http:Response response = check moesifClient->get(path, headers);
    int status = response.statusCode;

    // The success response body carries the minted canvas token (a bearer
    // credential), so it must never be logged or echoed to callers. Read it for
    // parsing only, and surface just the status code on failure.
    string|error rawBody = response.getTextPayload();
    string rawBodyStr = rawBody is string ? rawBody : "<no response body>";

    if status < 200 || status >= 300 {
        log:printError("Moesif canvas token minting failed", status = status);
        return error(string `Moesif API request to mint a canvas token failed with status ${status}`);
    }

    // The response body was already consumed above via getTextPayload(), so parse
    // the JSON from that string instead of re-reading the (now empty) stream.
    json payload = check rawBodyStr.fromJsonString();
    string|error minted = extractMintedToken(payload);
    if minted is error {
        log:printError("Moesif canvas token response had no usable token", 'error = minted);
    }
    return minted;
}

// Reads the minted token out of the Moesif OAuth response. Moesif returns the
// token wrapped in an object under `app_token` (e.g. `{"app_token":"<jwt>"}`).
// The `access_token` (OAuth-standard) and `token` fields, and a bare-string
// body, are also handled defensively so a response-shape change doesn't silently
// break minting. Returns an error when no usable token is present.
isolated function extractMintedToken(json payload) returns string|error {
    if payload is string && payload.trim().length() > 0 {
        return payload.trim();
    }
    if payload is map<json> {
        foreach string tokenField in ["app_token", "access_token", "token"] {
            json tokenValue = payload[tokenField];
            if tokenValue is string && tokenValue.trim().length() > 0 {
                return tokenValue.trim();
            }
        }
    }
    return error("Moesif OAuth response did not contain a canvas token");
}

// Builds the canvas embed descriptor: the iframe src the frontend loads and the
// auth token it delivers to the canvas over postMessage (SET_TOKEN). The
// `#auth=post` fragment tells the canvas to expect its token over postMessage.
// The organization and application are not part of the URL: the canvas derives
// them from the `org`/`app` claims of the token, which is minted on demand from
// the integration's stored Management API key as a short-lived, restricted token
// (see `mintMoesifCanvasToken`). Returns an error when the management key is
// unset or the token cannot be minted.
public isolated function buildMoesifCanvasEmbed(string managementApiKey) returns types:MoesifDashboardEmbed|error {
    string token = check mintMoesifCanvasToken(managementApiKey);
    string embedUrl = string `${effectiveMoesifCanvasEmbedBaseUrl}/embed/canvas#auth=post`;
    return {embedUrl, token};
}

// GETs from the Moesif Management API, surfacing the resource and the HTTP status
// on a non-2xx response so callers know which request failed. The response body
// may echo back credentials or other upstream detail, so it is logged at DEBUG for
// diagnostics and kept out of the returned (client-visible) error message.
isolated function getFromMoesif(http:Client moesifClient, string path,
        map<string|string[]> headers, string resourceLabel) returns json|error {
    http:Response response = check moesifClient->get(path, headers);
    int status = response.statusCode;
    if status < 200 || status >= 300 {
        string|error textBody = response.getTextPayload();
        string detail = textBody is string ? textBody : "<no response body>";
        log:printDebug(string `Moesif API request to list ${resourceLabel} failed with status ${status}: ${detail}`);
        return error(string `Moesif API request to list ${resourceLabel} failed with status ${status}`);
    }
    return response.getJsonPayload();
}

// Maps a Moesif `/~/apps` response into the id + name pairs the UI selects from.
// The endpoint returns the applications either as a bare JSON array or wrapped
// in an object (e.g. under a `results`/`apps` field), so both shapes are
// handled. Each application id is read from `id` (falling back to `_id`) and the
// label from `name` (falling back to the id when unnamed). Applications without
// a resolvable id are skipped.
isolated function extractMoesifApplications(json apps) returns types:MoesifApplication[]|error {
    json[] appList;
    if apps is json[] {
        appList = apps;
    } else if apps is map<json> {
        json results = apps["results"];
        json appsField = apps["apps"];
        if results is json[] {
            appList = results;
        } else if appsField is json[] {
            appList = appsField;
        } else {
            return error("Unexpected Moesif applications response shape");
        }
    } else {
        return error("Unexpected Moesif applications response shape");
    }

    types:MoesifApplication[] applications = [];
    foreach json app in appList {
        if app !is map<json> {
            continue;
        }
        json idValue = app["id"];
        if idValue !is string {
            idValue = app["_id"];
        }
        if idValue !is string || idValue.trim().length() == 0 {
            continue;
        }
        json nameValue = app["name"];
        string name = nameValue is string && nameValue.trim().length() > 0 ? nameValue : idValue;
        applications.push({id: idValue, name});
    }
    return applications;
}
