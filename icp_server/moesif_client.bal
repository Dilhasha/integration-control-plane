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
import ballerina/log;
import ballerina/time;
import ballerina/url;

// Base URL for the Moesif Management API. Overridable via configuration.
// See https://www.moesif.com/docs/api/ (Management API).
configurable string moesifManagementBaseUrl = "https://api.moesif.com/v1";

// Base URL for the public embedded-workspace viewer. The final iframe src is
// `${moesifEmbedBaseUrl}/${workspaceId}?embed=true#${accessToken}`.
configurable string moesifEmbedBaseUrl = "https://www.moesif.com/public/em/ws";

// Request timeout (seconds) for Moesif Management API calls.
const decimal MOESIF_HTTP_TIMEOUT_SECONDS = 30;

// Shared Moesif Management API HTTP client, reused across requests instead of
// constructing a new client per call. The base URL is fixed and authentication
// is passed per-request as a Bearer header, so a single shared client is safe.
final http:Client moesifClient = check new (moesifManagementBaseUrl, timeout = MOESIF_HTTP_TIMEOUT_SECONDS);

// Time-to-live (seconds) of the minted workspace access token. Kept short; the
// frontend re-requests a fresh token before it expires.
const int MOESIF_ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour

// Default time window (seconds) the embedded chart shows: now-7d .. now.
const int MOESIF_EMBED_WINDOW_SECONDS = 7 * 24 * 3600;

// Name of the dashboard the user imports into Moesif (from the ICP-provided
// metrics template). Its linked workspace is what gets embedded, so discovery is
// anchored on this dashboard name.
const string MOESIF_DASHBOARD_NAME = "Application Metrics";

// Name of the workspace inside the imported dashboard. Used as a fallback lookup
// when the dashboard's workspace link cannot be resolved directly.
const string MOESIF_WORKSPACE_NAME = "Total Request Summary";

// Name of the workspace embedded for Micro Integrator (MI) integrations. The MI
// template imports the Synapse observability dashboards (Overall, APIs, Proxy
// Services, ...); ICP embeds a single workspace, so discovery targets this named
// chart from the "Overall" dashboard by name (its name is unique across the
// template).
const string MOESIF_MI_WORKSPACE_NAME = "Overall Message Count Over Time";

// Page size for the "list dashboards" call used to discover the imported
// dashboard. The Moesif list endpoint requires a `take` parameter; this is set
// high enough to return all dashboards in a single page for a typical org.
const int MOESIF_DASHBOARD_LIST_TAKE = 1000;

// `take` value for the "list applications" call. Moesif returns the full set of
// applications the Management API key can access regardless of this value, so
// the documented `take=0` is used to fetch them all in a single request.
const int MOESIF_APP_LIST_TAKE = 0;

// A short-lived embed descriptor for a Moesif workspace: the minted access
// token and the fully-formed iframe src the UI should load.
public type MoesifWorkspaceEmbed record {|
    string workspaceId;
    string accessToken;
    string embedUrl;
|};

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

// Discovers the id of the workspace embedded by the ICP metrics dashboard, by
// listing the org's Moesif dashboards and locating the one the user imported from
// the ICP metrics template (named MOESIF_DASHBOARD_NAME). The workspace id is
// read from that dashboard's linked workspace; if the dashboard link can't be
// resolved, a fallback searches the listing for a workspace node named
// MOESIF_WORKSPACE_NAME. Workspaces are NOT created via the API because Moesif
// ignores the `access_control` field on create (making them non-embeddable), so
// the user imports the template and sets the workspace sharing to Public in the
// Moesif UI instead. The `moesifAppId` is used in the `app_id` query parameter.
// Returns the workspace id, or an error if the dashboard/workspace can't be found
// (usually because the template hasn't been imported yet).
public isolated function discoverMoesifMetricsWorkspaceId(string managementApiKey, string moesifAppId, boolean isMI = false)
        returns string|error {
    map<string|string[]> headers = {"Authorization": string `Bearer ${managementApiKey}`};

    string encodedAppId = check url:encode(moesifAppId, "UTF-8");
    json dashboards = check getFromMoesif(moesifClient,
            string `/~/dashboards?app_id=${encodedAppId}&take=${MOESIF_DASHBOARD_LIST_TAKE}`, headers, "dashboards");

    if isMI {
        // The MI template's "Overall" dashboard holds many chart workspaces, so
        // there is no single dashboard-to-workspace link to follow. Instead,
        // target the uniquely-named chart ICP embeds for MI directly by name.
        string? miWorkspaceId = findMoesifIdByName(dashboards, MOESIF_MI_WORKSPACE_NAME);
        if miWorkspaceId is string {
            log:printInfo("Discovered Moesif MI metrics workspace", workspaceId = miWorkspaceId);
            return miWorkspaceId;
        }
        return error(string `Could not find the imported Moesif "${MOESIF_MI_WORKSPACE_NAME}" workspace for app_id ${moesifAppId}. ` +
                string `Import the MI metrics template into Moesif and set the "${MOESIF_MI_WORKSPACE_NAME}" workspace sharing to Public, then try again.`);
    }

    string? workspaceId = findMoesifWorkspaceIdForDashboard(dashboards, MOESIF_DASHBOARD_NAME);
    if workspaceId is () {
        // Fallback: the dashboard's workspace link wasn't resolvable; try to find
        // the workspace node directly by name anywhere in the listing.
        workspaceId = findMoesifIdByName(dashboards, MOESIF_WORKSPACE_NAME);
    }
    if workspaceId is string {
        log:printInfo("Discovered Moesif metrics workspace", workspaceId = workspaceId);
        return workspaceId;
    }
    return error(string `Could not find the imported Moesif "${MOESIF_DASHBOARD_NAME}" dashboard for app_id ${moesifAppId}. ` +
            string `Import the metrics template into Moesif and set the "${MOESIF_WORKSPACE_NAME}" workspace sharing to Public, then try again.`);
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

// Mints a short-lived embed access token for the given workspace via the Moesif
// portal API, then returns it together with the fully-formed iframe src. The
// token is scoped to a default now-7d..now window and expires after
// MOESIF_ACCESS_TOKEN_TTL_SECONDS. Requires a Management API key with
// `read:workspaces` scope.
public isolated function generateMoesifWorkspaceAccessToken(string managementApiKey, string workspaceId)
        returns MoesifWorkspaceEmbed|error {
    map<string|string[]> headers = {"Authorization": string `Bearer ${managementApiKey}`};

    time:Utc now = time:utcNow();
    string expiration = time:utcToString(time:utcAddSeconds(now, <decimal>MOESIF_ACCESS_TOKEN_TTL_SECONDS));
    json body = {
        "template": {
            "values": {},
            "from": time:utcToString(time:utcAddSeconds(now, <decimal>-MOESIF_EMBED_WINDOW_SECONDS)),
            "to": time:utcToString(now)
        }
    };
    string encodedWorkspaceId = check url:encode(workspaceId, "UTF-8");
    string encodedExpiration = check url:encode(expiration, "UTF-8");
    json response = check postToMoesif(moesifClient,
            string `/portal/~/workspaces/${encodedWorkspaceId}/access_token?expiration=${encodedExpiration}`, body, headers, "workspace access token");
    map<json> responseMap = check response.ensureType();
    json tokenValue = responseMap["token"];
    if tokenValue !is string {
        return error("Moesif access token response did not contain a valid 'token' field");
    }
    string embedUrl = string `${moesifEmbedBaseUrl}/${workspaceId}?embed=true#${tokenValue}`;
    return {workspaceId, accessToken: tokenValue, embedUrl};
}

// POSTs to the Moesif Management API and validates the response. On a non-2xx
// status the Moesif error body is surfaced in the returned error so callers can
// see exactly why a request failed (e.g. an invalid token or a missing scope)
// instead of just the bare HTTP status reason. Uses an http:Response target
// type so 4xx/5xx responses are inspected here rather than auto-converted to a
// generic error that discards the body.
isolated function postToMoesif(http:Client moesifClient, string path, json body,
        map<string|string[]> headers, string resourceLabel) returns json|error {
    http:Response response = check moesifClient->post(path, body, headers);
    int status = response.statusCode;
    if status < 200 || status >= 300 {
        string|error textBody = response.getTextPayload();
        string detail = textBody is string ? textBody : "<no response body>";
        return error(string `Moesif API request to create ${resourceLabel} failed with status ${status}: ${detail}`);
    }
    return response.getJsonPayload();
}

// GETs from the Moesif Management API, surfacing status + response body on a
// non-2xx status so callers see why a request failed (mirrors postToMoesif).
isolated function getFromMoesif(http:Client moesifClient, string path,
        map<string|string[]> headers, string resourceLabel) returns json|error {
    http:Response response = check moesifClient->get(path, headers);
    int status = response.statusCode;
    if status < 200 || status >= 300 {
        string|error textBody = response.getTextPayload();
        string detail = textBody is string ? textBody : "<no response body>";
        return error(string `Moesif API request to list ${resourceLabel} failed with status ${status}: ${detail}`);
    }
    return response.getJsonPayload();
}

// Recursively walks a hydrated Moesif dashboards listing to find the dashboard
// map node named `dashboardName`, then returns its linked workspace id. The
// workspace link is resolved from either a hydrated `workspaces` array (each
// entry an object with an `_id`) or the raw `workspace_ids` field (a nested array
// of id strings, e.g. [["<workspaceId>"]]). The listing may nest dashboards
// inside their parents, so a single recursive pass discovers a match at any
// depth. Returns () when no matching dashboard with a resolvable workspace is
// found.
isolated function findMoesifWorkspaceIdForDashboard(json node, string dashboardName) returns string? {
    if node is json[] {
        foreach json element in node {
            string? found = findMoesifWorkspaceIdForDashboard(element, dashboardName);
            if found is string {
                return found;
            }
        }
        return ();
    }
    if node is map<json> {
        json nameValue = node["name"];
        if nameValue is string && nameValue == dashboardName {
            string? workspaceId = extractDashboardWorkspaceId(node);
            if workspaceId is string {
                return workspaceId;
            }
        }
        foreach json value in node {
            string? found = findMoesifWorkspaceIdForDashboard(value, dashboardName);
            if found is string {
                return found;
            }
        }
    }
    return ();
}

// Extracts the metrics workspace id from a dashboard node. The `/~/dashboards`
// listing hydrates each dashboard's `workspaces` as a nested array of workspace
// objects (rows of columns, e.g. [[{...}, {...}]]); each object carries its
// `_id` and `name`. A dashboard may hold several workspaces, so this prefers the
// one named MOESIF_WORKSPACE_NAME and only falls back to the first workspace's
// id when no name match is found. As a last resort it reads the raw
// `workspace_ids` field (a nested array of id strings) for older export shapes.
// Returns () when no workspace id can be resolved.
isolated function extractDashboardWorkspaceId(map<json> dashboardNode) returns string? {
    json workspaces = dashboardNode["workspaces"];
    string? namedId = findWorkspaceIdByNameInWorkspaces(workspaces, MOESIF_WORKSPACE_NAME);
    if namedId is string {
        return namedId;
    }
    string? firstId = findFirstWorkspaceIdInWorkspaces(workspaces);
    if firstId is string {
        return firstId;
    }
    return extractFirstMoesifWorkspaceId(dashboardNode["workspace_ids"]);
}

// Depth-first walks a dashboard's hydrated `workspaces` value (arbitrarily
// nested arrays of workspace objects) and returns the `_id` of the first object
// whose `name` equals `workspaceName`. Returns () when no match is found.
isolated function findWorkspaceIdByNameInWorkspaces(json workspaces, string workspaceName) returns string? {
    if workspaces is json[] {
        foreach json element in workspaces {
            string? found = findWorkspaceIdByNameInWorkspaces(element, workspaceName);
            if found is string {
                return found;
            }
        }
        return ();
    }
    if workspaces is map<json> {
        json nameValue = workspaces["name"];
        json idValue = workspaces["_id"];
        if nameValue is string && nameValue == workspaceName && idValue is string {
            return idValue;
        }
    }
    return ();
}

// Depth-first walks a dashboard's hydrated `workspaces` value and returns the
// `_id` of the first workspace object found, regardless of name. Used as a
// fallback when the named workspace lookup fails. Returns () when none.
isolated function findFirstWorkspaceIdInWorkspaces(json workspaces) returns string? {
    if workspaces is json[] {
        foreach json element in workspaces {
            string? found = findFirstWorkspaceIdInWorkspaces(element);
            if found is string {
                return found;
            }
        }
        return ();
    }
    if workspaces is map<json> {
        json idValue = workspaces["_id"];
        if idValue is string {
            return idValue;
        }
    }
    return ();
}

// Returns the first id string from a Moesif `workspace_ids` value. The field is a
// nested array (rows of columns of ids), e.g. [["<workspaceId>"]]; the first
// string found by a depth-first walk is returned, or () if none.
isolated function extractFirstMoesifWorkspaceId(json workspaceIds) returns string? {
    if workspaceIds is string {
        return workspaceIds;
    }
    if workspaceIds is json[] {
        foreach json element in workspaceIds {
            string? found = extractFirstMoesifWorkspaceId(element);
            if found is string {
                return found;
            }
        }
    }
    return ();
}

// Recursively walks a Moesif listing looking for the first map node named `name`
// and returns its `_id`. Used as a fallback to locate the workspace node by name
// when the dashboard's workspace link cannot be resolved. Returns () when no
// matching named node with a string `_id` is found.
isolated function findMoesifIdByName(json node, string name) returns string? {
    if node is json[] {
        foreach json element in node {
            string? found = findMoesifIdByName(element, name);
            if found is string {
                return found;
            }
        }
        return ();
    }
    if node is map<json> {
        json nameValue = node["name"];
        json idValue = node["_id"];
        if nameValue is string && nameValue == name && idValue is string {
            return idValue;
        }
        foreach json value in node {
            string? found = findMoesifIdByName(value, name);
            if found is string {
                return found;
            }
        }
    }
    return ();
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
