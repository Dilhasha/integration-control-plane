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

import ballerina/test;

// Helper function to normalize a single origin (same logic as in config.bal)
isolated function normalizeOrigin(string origin) returns string {
    return origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
}

@test:Config {
    groups: ["config", "unit"]
}
function testCorsOriginNormalization() {
    // Test that trailing slashes are removed from CORS origins
    // This ensures that origins like "http://localhost:5173/" match browser Origin headers
    // which never include trailing slashes (e.g., "http://localhost:5173")

    // Test cases
    test:assertEquals(normalizeOrigin("http://localhost:5173/"), "http://localhost:5173");
    test:assertEquals(normalizeOrigin("http://localhost:5173"), "http://localhost:5173");
    test:assertEquals(normalizeOrigin("https://example.com/"), "https://example.com");
    test:assertEquals(normalizeOrigin("https://example.com"), "https://example.com");
    test:assertEquals(normalizeOrigin("http://localhost:8080/path/"), "http://localhost:8080/path");

    // Verify the actual normalized origins don't have trailing slashes
    foreach string origin in normalizedCorsAllowedOrigins {
        test:assertFalse(origin.endsWith("/"),
            msg = string `Normalized CORS origin should not have trailing slash: ${origin}`);
    }
}

@test:Config {
    groups: ["config", "unit"]
}
function testCorsOriginNormalizationPreservesNonTrailingSlashes() {
    // Test that normalization only removes trailing slashes, not slashes in paths

    // Origins with paths should have internal slashes preserved
    test:assertEquals(normalizeOrigin("http://example.com/api/v1/"), "http://example.com/api/v1");
    test:assertEquals(normalizeOrigin("http://example.com/api/v1"), "http://example.com/api/v1");
}
