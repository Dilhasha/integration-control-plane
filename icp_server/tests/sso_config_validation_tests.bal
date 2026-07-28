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

import ballerina/test;

function buildSSOConfig(boolean enabled, boolean passwordLoginDisabled,
        boolean federatedAccessControlEnabled) returns types:SSOConfig => {
    enabled,
    issuer: "https://idp.example.com",
    authorizationEndpoint: "https://idp.example.com/oauth2/authorize",
    tokenEndpoint: "https://idp.example.com/oauth2/token",
    logoutEndpoint: "https://idp.example.com/oidc/logout",
    jwksUrl: "https://idp.example.com/oauth2/jwks",
    clientId: "icp",
    clientSecret: "secret",
    redirectUri: "https://icp.example.com/auth/callback",
    usernameClaim: "email",
    scopes: ["openid", "email", "profile", "groups"],
    allowInsecureTLS: false,
    passwordLoginDisabled,
    adminClaim: "groups",
    adminValues: ["icp-platform-admins"],
    federatedAccessControlEnabled
};

@test:Config {
    groups: ["sso-rbac", "config"]
}
function testPasswordLoginDisabledRequiresSSO() {
    error? result = validateSSOConfig(buildSSOConfig(false, true, false));
    test:assertTrue(result is error, "passwordLoginDisabled without ssoEnabled must be rejected");
}

@test:Config {
    groups: ["sso-rbac", "config"]
}
function testFederatedAccessControlRequiresSSO() {
    error? result = validateSSOConfig(buildSSOConfig(false, false, true));
    test:assertTrue(result is error, "federatedAccessControlEnabled without ssoEnabled must be rejected");
}

@test:Config {
    groups: ["sso-rbac", "config"]
}
function testFederatedAccessControlRequiresPasswordLoginDisabled() {
    // Mode 4 (password login + federated access control) is not supported.
    error? result = validateSSOConfig(buildSSOConfig(true, false, true));
    test:assertTrue(result is error,
            "federatedAccessControlEnabled without passwordLoginDisabled must be rejected");
}

@test:Config {
    groups: ["sso-rbac", "config"]
}
function testSSOOnlyWithFederatedAccessControlIsValid() {
    error? result = validateSSOConfig(buildSSOConfig(true, true, true));
    test:assertTrue(result is (), "SSO-only mode with federated access control must be accepted");
}

@test:Config {
    groups: ["sso-rbac", "config"]
}
function testSSOOnlyWithoutAdminClaimIsRejected() {
    types:SSOConfig config = buildSSOConfig(true, true, false);
    config.adminClaim = "";
    error? result = validateSSOConfig(config);
    test:assertTrue(result is error, "passwordLoginDisabled without ssoAdminClaim must be rejected");
}
