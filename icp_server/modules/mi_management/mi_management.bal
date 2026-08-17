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

// Package: mi_management
// Provides utility functions to call the WSO2 MI Management REST API
// (at /management path) using HMAC-signed JWT auth

import ballerina/http;
import ballerina/log;
import ballerina/url;

import wso2/icp_server.storage;
import wso2/icp_server.types;

// Path prefix for all Management API endpoints
const string MGMT_API_PATH = "/management";

// HTTP header constants
const string HEADER_AUTHORIZATION = "Authorization";
const string HEADER_ACCEPT = "Accept";
const string CONTENT_TYPE_JSON = "application/json";
const string CONTENT_TYPE_XML = "application/xml";

// Artifact type constants
public const string ARTIFACT_TYPE_API = "api";
public const string ARTIFACT_TYPE_PROXY_SERVICE = "proxy-service";
public const string ARTIFACT_TYPE_ENDPOINT = "endpoint";
public const string ARTIFACT_TYPE_SEQUENCE = "sequence";
public const string ARTIFACT_TYPE_TASK = "task";
public const string ARTIFACT_TYPE_LOCAL_ENTRY = "local-entry";
public const string ARTIFACT_TYPE_MESSAGE_STORE = "message-store";
public const string ARTIFACT_TYPE_MESSAGE_PROCESSOR = "message-processor";
public const string ARTIFACT_TYPE_INBOUND_ENDPOINT = "inbound-endpoint";
public const string ARTIFACT_TYPE_CONNECTOR = "connector";
public const string ARTIFACT_TYPE_TEMPLATE = "template";
public const string ARTIFACT_TYPE_DATA_SERVICE = "data-service";
public const string ARTIFACT_TYPE_DATA_SOURCE = "data-source";

// ============================================================
// Artifact-specific fetch functions
// ============================================================

isolated function fetchApiArtifact(http:Client mgmtClient, string hmacToken, string apiName) returns types:MgmtRestApiInfo|error {
    string path = string `${MGMT_API_PATH}/apis?apiName=${apiName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtRestApiInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

public isolated function fetchProxyServiceArtifact(http:Client mgmtClient, string hmacToken, string proxyServiceName) returns types:MgmtProxyServiceInfo|error {
    string path = string `${MGMT_API_PATH}/proxy-services?proxyServiceName=${proxyServiceName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtProxyServiceInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

isolated function fetchEndpointArtifact(http:Client mgmtClient, string hmacToken, string endpointName) returns types:MgmtEndpointInfo|error {
    string path = string `${MGMT_API_PATH}/endpoints?endpointName=${endpointName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtEndpointInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

isolated function fetchSequenceArtifact(http:Client mgmtClient, string hmacToken, string sequenceName) returns types:MgmtSequenceInfo|error {
    string path = string `${MGMT_API_PATH}/sequences?sequenceName=${sequenceName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtSequenceInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

isolated function fetchTaskArtifact(http:Client mgmtClient, string hmacToken, string taskName) returns types:MgmtTaskInfo|error {
    string path = string `${MGMT_API_PATH}/tasks?taskName=${taskName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtTaskInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

public isolated function fetchLocalEntryArtifact(http:Client mgmtClient, string hmacToken, string entryName) returns types:MgmtLocalEntryInfo|error {
    string path = string `${MGMT_API_PATH}/local-entries?name=${entryName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtLocalEntryInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

public isolated function fetchMessageStoreArtifact(http:Client mgmtClient, string hmacToken, string storeName) returns types:MgmtMessageStoreInfo|error {
    string path = string `${MGMT_API_PATH}/message-stores?name=${storeName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtMessageStoreInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

public isolated function fetchMessageProcessorArtifact(http:Client mgmtClient, string hmacToken, string processorName) returns types:MgmtMessageProcessorInfo|error {
    string path = string `${MGMT_API_PATH}/message-processors?name=${processorName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtMessageProcessorInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

public isolated function fetchInboundEndpointArtifact(http:Client mgmtClient, string hmacToken, string inboundName) returns types:MgmtInboundEndpointInfo|error {
    string path = string `${MGMT_API_PATH}/inbound-endpoints?inboundEndpointName=${inboundName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtInboundEndpointInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

isolated function fetchConnectorArtifact(http:Client mgmtClient, string hmacToken, string connectorName, string? packageName) returns types:MgmtConnectorInfo|error {
    string path = string `${MGMT_API_PATH}/connectors`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtConnectorInfo[] result = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    foreach types:MgmtConnectorInfo connector in result {
        if connector.name == connectorName && (packageName is () || connector.'package == packageName) {
            return connector;
        }
    }
    return error(string `Connector '${connectorName}' not found in MI management API response`);
}

isolated function fetchTemplateArtifact(http:Client mgmtClient, string hmacToken, string templateName, string templateType) returns types:MgmtTemplateInfo|error {
    string path = string `${MGMT_API_PATH}/templates?name=${templateName}&type=${templateType}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtTemplateInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

public isolated function fetchDataServiceArtifact(http:Client mgmtClient, string hmacToken, string dataServiceName) returns types:MgmtDataServiceInfo|error {
    string path = string `${MGMT_API_PATH}/data-services?dataServiceName=${dataServiceName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtDataServiceInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

public isolated function fetchDataSourceArtifact(http:Client mgmtClient, string hmacToken, string dataSourceName) returns types:MgmtDataSourceInfo|error {
    string path = string `${MGMT_API_PATH}/data-sources?name=${dataSourceName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtDataSourceInfo result = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    log:printDebug("Data source converted to type",
            dataSourceName = dataSourceName,
            hasConfigParams = result.configurationParameters is map<json>,
            configParamsValue = result.configurationParameters);
    return result;
}

isolated function fetchCompositeAppArtifact(http:Client mgmtClient, string hmacToken, string compositeAppName) returns types:MgmtCompositeAppInfo|error {
    string path = string `${MGMT_API_PATH}/applications?carbonAppName=${compositeAppName}`;
    log:printDebug("Calling MI management API", path = path);
    types:MgmtCompositeAppInfo respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

// Fetch loggers from the MI Management API
public isolated function fetchLoggers(http:Client mgmtClient, string hmacToken) returns types:MgmtLoggersResponse|error {
    string path = string `${MGMT_API_PATH}/logging`;
    log:printDebug("Fetching loggers from MI management API");
    types:MgmtLoggersResponse respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

// Update logger (add new logger, update log level, or update root logger)
public isolated function updateLogger(http:Client mgmtClient, string hmacToken, types:MgmtUpdateLoggerRequest request) returns types:MgmtUpdateLoggerResponse|error {
    string path = string `${MGMT_API_PATH}/logging`;
    log:printDebug("Calling MI management API to update logger", path = path, loggerName = request.loggerName, loggingLevel = request.loggingLevel);

    do {
        types:MgmtUpdateLoggerResponse respResult = check mgmtClient->patch(path, request, {
            [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
            [HEADER_ACCEPT]: CONTENT_TYPE_JSON
        });

        log:printInfo("Successfully updated logger via MI management API", loggerName = request.loggerName, loggingLevel = request.loggingLevel);
        return respResult;
    } on fail error e {
        log:printError("Failed to update logger via MI management API", loggerName = request.loggerName, errorMessage = e.message());
        return e;
    }
}

// Delete logger via the MI Management API
public isolated function deleteLogger(http:Client mgmtClient, string hmacToken, string loggerName) returns types:MgmtDeleteLoggerResponse|error {
    string encodedName = check url:encode(loggerName, "UTF-8");
    string path = string `${MGMT_API_PATH}/logging?loggerName=${encodedName}`;
    log:printDebug("Calling MI management API to delete logger", path = path, loggerName = loggerName);

    do {
        types:MgmtDeleteLoggerResponse respResult = check mgmtClient->delete(path, headers = {
            [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
            [HEADER_ACCEPT]: CONTENT_TYPE_JSON
        });

        log:printInfo("Successfully deleted logger via MI management API", loggerName = loggerName);
        return respResult;
    } on fail error e {
        log:printError("Failed to delete logger via MI management API", loggerName = loggerName, errorMessage = e.message());
        return e;
    }
}

// ============================================================
// Dispatcher function
// ============================================================

// Artifact types that have a 'configuration' field i.e. source
public type ArtifactWithConfig types:MgmtRestApiInfo|types:MgmtProxyServiceInfo|types:MgmtEndpointInfo|
    types:MgmtSequenceInfo|types:MgmtTaskInfo|types:MgmtMessageStoreInfo|types:MgmtMessageProcessorInfo|
    types:MgmtInboundEndpointInfo|types:MgmtTemplateInfo|types:MgmtDataServiceInfo|types:MgmtDataSourceInfo;

// fetchRawArtifactItem dispatches to the appropriate artifact-specific fetch function
// based on the artifact type and returns the typed record.
isolated function getArtifactsWithSource(http:Client mgmtClient, string hmacToken, string artifactType, string artifactName, string? packageName = (), string? templateType = ()) returns ArtifactWithConfig|error {
    // Dispatch to artifact-specific fetch functions and return typed records
    if artifactType == ARTIFACT_TYPE_API {
        return check fetchApiArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_PROXY_SERVICE {
        return check fetchProxyServiceArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_ENDPOINT {
        return check fetchEndpointArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_SEQUENCE {
        return check fetchSequenceArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_TASK {
        return check fetchTaskArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_MESSAGE_STORE {
        return check fetchMessageStoreArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_MESSAGE_PROCESSOR {
        return check fetchMessageProcessorArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_INBOUND_ENDPOINT {
        return check fetchInboundEndpointArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_TEMPLATE {
        if templateType is () {
            return error(string `Template artifact type requires 'templateType' parameter to be specified`);
        }
        return check fetchTemplateArtifact(mgmtClient, hmacToken, artifactName, templateType);
    } else if artifactType == ARTIFACT_TYPE_DATA_SERVICE {
        return check fetchDataServiceArtifact(mgmtClient, hmacToken, artifactName);
    } else if artifactType == ARTIFACT_TYPE_DATA_SOURCE {
        return check fetchDataSourceArtifact(mgmtClient, hmacToken, artifactName);
    } else {
        return error(string `Unsupported artifact type for MI management API: ${artifactType}`);
    }
}

// ============================================================
// Public API functions
// ============================================================

// fetchArtifactDetails returns the synapse configuration XML for the named
// artifact, or the full metadata JSON when no 'configuration' field is present.
public isolated function getArtifactSource(http:Client mgmtClient, string hmacToken, string artifactType, string artifactName, string? packageName = (), string? templateType = ()) returns string|error {
    log:printDebug("Fetching artifact details from MI management API",
            artifactType = artifactType, artifactName = artifactName);

    ArtifactWithConfig artifact = check getArtifactsWithSource(mgmtClient, hmacToken, artifactType, artifactName, packageName, templateType);

    // Extract configuration field for artifacts that have it
    string? config = artifact.configuration;
    if config is string && config.length() > 0 {
        return config;
    }

    // Fallback: return full artifact metadata as JSON
    return artifact.toJson().toJsonString();
}

// fetchWsdlContent fetches the actual WSDL XML from the URL returned by the
// MI Management API. The URL is typically on the MI HTTP service port (e.g.
// http://host:8290/services/TestProxy?wsdl), distinct from the management port.
//
// Security: Replaces the URL host with the trusted management hostname to prevent SSRF attacks.
// MI may report its own configured hostname in the WSDL URL (e.g. the machine name) which can
// differ from the hostname ICP uses to connect to the management API. By substituting the host,
// we ensure the request always goes to the trusted runtime, regardless of what hostname MI reports.

public isolated function fetchWsdlContent(string wsdlUrl, string trustedHost, boolean allowInsecureTLS) returns string|error {
    log:printInfo("Fetching WSDL content", wsdlUrl = wsdlUrl, trustedHost = trustedHost);
    int? schemeEndPos = wsdlUrl.indexOf("://");
    if schemeEndPos is () {
        return error(string `Invalid WSDL URL (missing scheme): ${wsdlUrl}`);
    }

    // Validate scheme is http or https only
    string scheme = wsdlUrl.substring(0, schemeEndPos);
    if scheme != "http" && scheme != "https" {
        return error(string `Invalid WSDL URL scheme '${scheme}' (only http/https allowed): ${wsdlUrl}`);
    }

    int? pathStartPos = wsdlUrl.indexOf("/", schemeEndPos + 3);
    if pathStartPos is () {
        return error(string `Invalid WSDL URL (no path component): ${wsdlUrl}`);
    }

    // Extract host:port from URL, then pull out only the port.
    // We discard the host from the URL and substitute trustedHost (SSRF protection).
    string hostAndPort = wsdlUrl.substring(schemeEndPos + 3, pathStartPos);

    // Reject userinfo (e.g. user:pass@host) in the authority to prevent it being
    // misinterpreted as part of the port or host.
    if hostAndPort.indexOf("@") is int {
        return error(string `Invalid WSDL URL (userinfo not allowed in authority): ${wsdlUrl}`);
    }

    string urlPort;
    if hostAndPort.startsWith("[") {
        // IPv6 literal: check for port after closing bracket, e.g. "[::1]:8290"
        int? ipv6EndPos = hostAndPort.indexOf("]");
        if ipv6EndPos is () {
            return error(string `Invalid WSDL URL (unterminated IPv6 host): ${wsdlUrl}`);
        }
        string afterBracket = hostAndPort.substring(ipv6EndPos + 1);
        urlPort = afterBracket.startsWith(":") ? afterBracket.substring(1) : "";
    } else {
        // IPv4 or hostname: extract port if present
        int? portSeparatorPos = hostAndPort.indexOf(":");
        urlPort = portSeparatorPos is () ? "" : hostAndPort.substring(portSeparatorPos + 1);
    }

    // Validate the extracted port is either absent or a numeric value in range 1–65535.
    if urlPort != "" {
        int|error portNum = int:fromString(urlPort);
        if portNum is error || portNum < 1 || portNum > 65535 {
            return error(string `Invalid WSDL URL (invalid port '${urlPort}'): ${wsdlUrl}`);
        }
    }

    // Build the fetch URL using the trusted management hostname but keeping the original port and path.
    string trustedHostAndPort = urlPort == "" ? trustedHost : string `${trustedHost}:${urlPort}`;
    string wsdlBaseUrl = string `${scheme}://${trustedHostAndPort}`;
    string wsdlPath = wsdlUrl.substring(pathStartPos);

    log:printInfo("WSDL URL host replaced for security", originalUrl = wsdlUrl, trustedBaseUrl = wsdlBaseUrl);

    http:Client|error wsdlClientResult = allowInsecureTLS
        ? new (wsdlBaseUrl, {secureSocket: {enable: false}})
        : new (wsdlBaseUrl);

    if wsdlClientResult is error {
        return error(string `Failed to create HTTP client for WSDL URL: ${wsdlClientResult.message()}`);
    }
    http:Client wsdlClient = wsdlClientResult;

    http:Response|error wsdlRespResult = wsdlClient->get(wsdlPath, {[HEADER_ACCEPT]: CONTENT_TYPE_XML});
    if wsdlRespResult is error {
        return error(string `WSDL content fetch failed: ${wsdlRespResult.message()}`);
    }
    http:Response wsdlResp = wsdlRespResult;

    if wsdlResp.statusCode != http:STATUS_OK {
        string|error errPayload = wsdlResp.getTextPayload();
        string errMsg = errPayload is string ? errPayload : "Unknown error";
        return error(string `WSDL content fetch returned status ${wsdlResp.statusCode}: ${errMsg}`);
    }

    string|error wsdlContent = wsdlResp.getTextPayload();
    if wsdlContent is error {
        return error(string `Failed to read WSDL content: ${wsdlContent.message()}`);
    }
    return wsdlContent;
}

// ============================================================
// Log Files API functions
// ============================================================

// Fetch the list of log files from the MI management API
// GET /management/logs or /management/logs?searchKey={searchKey}
public isolated function fetchLogFiles(http:Client mgmtClient, string hmacToken, string? searchKey = ()) returns types:MgmtLogFilesResponse|error {
    string path = string `${MGMT_API_PATH}/logs`;
    if searchKey is string && searchKey.trim() != "" {
        string encodedSearchKey = check url:encode(searchKey, "UTF-8");
        path = string `${path}?searchKey=${encodedSearchKey}`;
    }
    log:printDebug("Calling MI management API", path = path);
    types:MgmtLogFilesResponse respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return respResult;
}

// Fetch the content of a specific log file from the MI management API
// GET /management/logs?file={fileName}
public isolated function fetchLogFileContent(http:Client mgmtClient, string hmacToken, string fileName) returns string|error {
    string encodedFileName = check url:encode(fileName, "UTF-8");
    string path = string `${MGMT_API_PATH}/logs?file=${encodedFileName}`;
    log:printDebug("Calling MI management API", path = path);
    string respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`
    });
    return respResult;
}

// Fetch registry directory contents from the MI management API
// GET /management/registry-resources?path={path}
public isolated function fetchRegistryDirectory(http:Client mgmtClient, string hmacToken, string path, boolean? expand = ()) returns types:RegistryDirectoryResponse|error {
    string encodedPath = check url:encode(path, "UTF-8");
    string apiPath = string `${MGMT_API_PATH}/registry-resources?path=${encodedPath}`;
    log:printDebug("Calling MI management API", path = apiPath);

    MgmtRegistryDirectoryResponse respResult = check mgmtClient->get(apiPath, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });

    types:RegistryDirectoryItem[] items = [];
    log:printDebug("Processing registry directory items", itemCount = respResult.count);

    foreach MgmtRegistryFileItem fileItem in respResult.list {
        types:RegistryProperty[] mappedProperties = from var prop in fileItem.properties
            select {name: prop.name, value: prop.value};

        log:printDebug("Mapped registry item",
            itemName = fileItem.name,
            mediaType = fileItem.mediaType,
            propertiesCount = mappedProperties.length()
        );

        items.push({
            name: fileItem.name,
            mediaType: fileItem.mediaType,
            isDirectory: fileItem.mediaType == "directory",
            properties: mappedProperties
        });
    }

    log:printDebug("Registry directory processing complete", totalItems = items.length());
    return {count: respResult.count, items: items};
}

// Fetch registry file content from the MI management API
// GET /management/registry-resources/content?path={path}
public isolated function fetchRegistryFileContent(http:Client mgmtClient, string hmacToken, string path) returns string|error {
    string encodedPath = check url:encode(path, "UTF-8");
    string apiPath = string `${MGMT_API_PATH}/registry-resources/content?path=${encodedPath}`;
    log:printDebug("Calling MI management API", path = apiPath);
    string respResult = check mgmtClient->get(apiPath, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`
    });
    return respResult;
}

// Fetch registry resource metadata from the MI management API
// GET /management/registry-resources/metadata?path={path}
public isolated function fetchRegistryResourceMetadata(http:Client mgmtClient, string hmacToken, string path) returns types:RegistryResourceMetadata|error {
    string encodedPath = check url:encode(path, "UTF-8");
    string apiPath = string `${MGMT_API_PATH}/registry-resources/metadata?path=${encodedPath}`;
    log:printDebug("Calling MI management API", path = apiPath);
    MgmtRegistryMetadataResponse respResult = check mgmtClient->get(apiPath, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    return {name: respResult.name, mediaType: respResult.mediaType};
}

// Fetch registry resource properties from the MI management API
// GET /management/registry-resources/properties?path={path}
public isolated function fetchRegistryResourceProperties(http:Client mgmtClient, string hmacToken, string path, string? propertyName = ()) returns types:RegistryPropertiesResponse|error {
    string encodedPath = check url:encode(path, "UTF-8");
    string apiPath = string `${MGMT_API_PATH}/registry-resources/properties?path=${encodedPath}`;
    if propertyName is string && propertyName.trim() != "" {
        string encodedName = check url:encode(propertyName, "UTF-8");
        apiPath = string `${apiPath}&name=${encodedName}`;
    }
    log:printDebug("Calling MI management API", path = apiPath);
    json respJson = check mgmtClient->get(apiPath, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });

    json listField = check respJson.list;
    if listField is string {
        log:printDebug("MI returned error for registry properties", errorMessage = listField, path = path);
        return {count: 0, properties: []};
    }

    MgmtRegistryPropertiesResponse respResult = check respJson.cloneWithType();
    types:RegistryProperty[] props = [];
    foreach MgmtRegistryProperty prop in respResult.list {
        props.push({name: prop.name, value: prop.value});
    }

    return {count: respResult.count, properties: props};
}

// Fetch the fault stack trace for a faulty Composite App from the MI management API
// GET /management/applications/{appName}/fault
public isolated function fetchCompositeAppFaultStackTrace(http:Client mgmtClient, string hmacToken, string appName) returns string|error {
    string encodedAppName = check url:encode(appName, "UTF-8");
    string path = string `${MGMT_API_PATH}/applications/${encodedAppName}/fault`;
    log:printDebug("Calling MI management API for Composite App fault stacktrace", path = path);
    MgmtCompositeAppFaultResponse respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    string? stackTrace = respResult?.faultStackTrace;
    if stackTrace is () {
        log:printWarn("No fault stack trace found for Composite App", appName = appName);
        return error(string `No fault stack trace available for Composite App: ${appName}`);
    }
    if stackTrace.trim().length() == 0 {
        log:printWarn("Empty fault stack trace found for Composite App", appName = appName);
        return error(string `No fault stack trace available for Composite App: ${appName}`);
    }
    return stackTrace;
}

// Fetch the fault stack trace for a faulty Data Service from the MI management API
// GET /management/data-services/{serviceName}/fault
public isolated function fetchDataServiceFaultStackTrace(http:Client mgmtClient, string hmacToken, string serviceName) returns string|error {
    string encodedServiceName = check url:encode(serviceName, "UTF-8");
    string path = string `${MGMT_API_PATH}/data-services/${encodedServiceName}/fault`;
    log:printDebug("Calling MI management API for Data Service fault stacktrace", path = path);
    MgmtDataServiceFaultResponse respResult = check mgmtClient->get(path, {
        [HEADER_AUTHORIZATION]: string `Bearer ${hmacToken}`,
        [HEADER_ACCEPT]: CONTENT_TYPE_JSON
    });
    string? stackTrace = respResult?.faultStackTrace;
    if stackTrace is () {
        log:printWarn("No fault stack trace found for Data Service", serviceName = serviceName);
        return error(string `No fault stack trace available for Data Service: ${serviceName}`);
    }
    if stackTrace.trim().length() == 0 {
        log:printWarn("Empty fault stack trace found for Data Service", serviceName = serviceName);
        return error(string `No fault stack trace available for Data Service: ${serviceName}`);
    }
    return stackTrace;
}

public isolated function createRegistryManagementClient(types:Runtime runtime, string runtimeId, boolean allowInsecureTLS) returns types:RegistryApiClient|error {
    log:printDebug("Creating registry management client", runtimeId = runtimeId, hostname = runtime.managementHostname, port = runtime.managementPort);

    string baseUrl = check storage:buildManagementBaseUrl(runtime.managementHostname, runtime.managementPort);
    http:Client mgmtClient = check (allowInsecureTLS
        ? new (baseUrl, {secureSocket: {enable: false}})
        : new (baseUrl));

    string hmacToken = check storage:issueRuntimeHmacToken(runtimeId);

    log:printDebug("Registry management client created", runtimeId = runtimeId, baseUrl = baseUrl);
    return {mgmtClient, hmacToken};
}

