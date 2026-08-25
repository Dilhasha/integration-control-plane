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

// Tests for the login authorization gate: in federated access control mode a
// user who resolves to no effective permissions must not be issued a token.
//
// The mode itself cannot be flipped per test — federatedAccessControlEnabled is
// a configurable read at startup, and turning it on demands
// passwordLoginDisabled, which would break every password login test. So the
// mode decision is covered through the pure isLoginAuthorized seam, and the
// permission resolution feeding it is covered against the real database by
// replaying the login sequence (grant -> sync -> resolve) that auth_service.bal
// runs before the gate.

import icp_server.auth;
import icp_server.storage;
import icp_server.types;

import ballerina/http;
import ballerina/test;
import ballerina/uuid;

const string GATE_TEST_ISSUER = "https://idp.example.com";

// Replays the ordering auth_service.bal uses on the OIDC path. Ordering is what
// makes the gate safe: the super admin grant and the federated sync both run
// before permissions are resolved, so the bootstrap can never be locked out by
// the gate its own grant satisfies.
function resolveLoginPermissions(string userId, string username, types:OIDCIdTokenClaims claims)
        returns string[]|error {
    check grantSuperAdminFromSSOClaims(userId, username, claims, getSSOConfig());
    check syncFederatedGroupsFromSSOClaims(userId, username, claims);
    return auth:getUserPermissionNames(userId);
}

function buildGateClaims(string subject, string[] groups) returns types:OIDCIdTokenClaims => {
    sub: subject,
    iss: GATE_TEST_ISSUER,
    aud: "icp",
    exp: 2000000000,
    iat: 1999999000,
    rawClaims: {"groups": groups}
};

// ============================================================================
// The decision itself
// ============================================================================

@test:Config {
    groups: ["sso-rbac"]
}
function testLoginAuthorizationDecision() {
    test:assertTrue(isLoginAuthorized(false, []),
            "Without federated access control a zero-permission login must still be allowed");
    test:assertTrue(isLoginAuthorized(false, ["project:view"]),
            "Without federated access control an authorized login must be allowed");
    test:assertFalse(isLoginAuthorized(true, []),
            "Under federated access control a zero-permission login must be refused");
    test:assertTrue(isLoginAuthorized(true, ["project:view"]),
            "Under federated access control an authorized login must be allowed");
}

@test:Config {
    groups: ["sso-rbac"]
}
function testLoginAuthorizationRequirementFollowsFederatedMode() {
    test:assertEquals(isLoginAuthorizationRequired(), federatedAccessControlEnabled,
            "The gate must be driven by federated access control alone, with no separate switch");
}

// ============================================================================
// Permission resolution feeding the gate
// ============================================================================

// Scenario 1 — the email's headline case. Before any mapping exists, the user
// holding the configured admin claim is bootstrapped into Super Admins and must
// come out authorized.
@test:Config {
    groups: ["sso-rbac", "storage"]
}
function testAdminClaimUserIsAuthorizedWithoutAnyMappings() returns error? {
    string uniqueValue = uuid:createType1AsString();
    string userId = uuid:createType1AsString();
    string username = "sso-gate-admin-" + uniqueValue;
    _ = check storage:createUserV2(userId, username, "SSO Gate Admin", [], true);

    types:SSOConfig ssoConfig = getSSOConfig();
    test:assertTrue(ssoConfig.adminValues.length() > 0, "Test config must define an admin claim value");
    types:OIDCIdTokenClaims claims = buildGateClaims(userId, [ssoConfig.adminValues[0]]);

    string[] permissions = check resolveLoginPermissions(userId, username, claims);
    test:assertTrue(permissions.length() > 0,
            "The bootstrapped super admin must resolve to permissions before any mapping exists");
    test:assertTrue(isLoginAuthorized(true, permissions),
            "The super admin bootstrap must never be refused by the gate");

    string superAdminsGroupId = check storage:getSuperAdminsGroupId();
    check storage:removeUserFromGroup(userId, superAdminsGroupId);
    check storage:deleteUserV2(userId, "test-cleanup-user");
}

// Scenario 2 — a user with neither the admin claim nor a matching mapping is
// refused, and the JIT-provisioned record survives the refusal so an admin can
// find them under Access Control -> Users.
@test:Config {
    groups: ["sso-rbac", "storage"]
}
function testUnmappedUserIsRefusedButStillProvisioned() returns error? {
    string uniqueValue = uuid:createType1AsString();
    string userId = uuid:createType1AsString();
    string username = "sso-gate-unmapped-" + uniqueValue;
    _ = check storage:createUserV2(userId, username, "SSO Gate Unmapped", [], true);

    types:OIDCIdTokenClaims claims = buildGateClaims(userId, ["nothing-maps-to-this-" + uniqueValue]);
    string[] permissions = check resolveLoginPermissions(userId, username, claims);

    test:assertEquals(permissions.length(), 0, "A user matching no mapping must resolve to no permissions");
    test:assertFalse(isLoginAuthorized(true, permissions), "A user matching no mapping must be refused");

    types:User persisted = check storage:getUserDetailsById(userId);
    test:assertEquals(persisted.username, username,
            "The JIT-provisioned user record must survive a refused login");

    check storage:deleteUserV2(userId, "test-cleanup-user");
}

// Scenarios 3, 5 and 6 — a matching mapping authorizes; deleting it refuses on
// the next login; recreating it authorizes again without operator surgery.
@test:Config {
    groups: ["sso-rbac", "storage"]
}
function testMappedUserIsAuthorizedAndRecoversAfterMappingChanges() returns error? {
    string uniqueValue = uuid:createType1AsString();
    string userId = uuid:createType1AsString();
    string username = "sso-gate-mapped-" + uniqueValue;
    string claimValue = "engineers-" + uniqueValue;

    string groupId = check storage:createGroup({
        groupName: "SSO Gate Group " + uniqueValue,
        description: "Temporary group for login gate tests"
    });
    string roleId = check storage:createRoleV2({
        roleName: "SSO Gate Role " + uniqueValue,
        description: "Temporary role for login gate tests"
    });
    types:Permission projectViewPermission = check storage:getPermissionByName(auth:PERMISSION_PROJECT_VIEW);
    check storage:assignPermissionsToRole(roleId, [projectViewPermission.permissionId]);
    int roleMappingId = check storage:assignRoleToGroup({
        groupId: groupId,
        roleId: roleId,
        orgUuid: storage:DEFAULT_ORG_ID
    });
    _ = check storage:createUserV2(userId, username, "SSO Gate Mapped", [], true);

    types:SSOGroupMappingInput mappingInput = {
        issuer: GATE_TEST_ISSUER,
        claimName: "groups",
        claimValue: claimValue,
        groupId: groupId
    };
    string mappingId = check storage:createSSOGroupMapping(mappingInput);

    types:OIDCIdTokenClaims claims = buildGateClaims(userId, [claimValue]);

    // Scenario 3: the claim matches a mapping.
    string[] mappedPermissions = check resolveLoginPermissions(userId, username, claims);
    test:assertTrue(isLoginAuthorized(true, mappedPermissions),
            "A user whose claim matches a mapping must be allowed in");

    // Scenario 5: the mapping is deleted; the sync clears the membership before
    // the gate reads permissions, so the very next login is refused.
    check storage:deleteSSOGroupMapping(mappingId, storage:DEFAULT_ORG_ID);
    string[] afterDeletion = check resolveLoginPermissions(userId, username, claims);
    test:assertEquals(afterDeletion.length(), 0,
            "Deleting the mapping must strip the federated membership on the next login");
    test:assertFalse(isLoginAuthorized(true, afterDeletion),
            "A user whose only mapping was deleted must be refused");

    // Scenario 6: the admin recreates the mapping and the user gets back in.
    string recreatedMappingId = check storage:createSSOGroupMapping(mappingInput);
    string[] afterRecreation = check resolveLoginPermissions(userId, username, claims);
    test:assertTrue(isLoginAuthorized(true, afterRecreation),
            "Recreating the mapping must restore access on the next login");

    check storage:deleteSSOGroupMapping(recreatedMappingId, storage:DEFAULT_ORG_ID);
    check storage:reconcileFederatedGroupUserMappings(
            storage:DEFAULT_ORG_ID, GATE_TEST_ISSUER, userId, []);
    check storage:removeRoleFromGroup(roleMappingId);
    check storage:removePermissionsFromRole(roleId, [projectViewPermission.permissionId]);
    check storage:deleteRoleV2(roleId);
    check storage:deleteUserV2(userId, "test-cleanup-user");
    check storage:deleteGroup(groupId);
}

// Scenario 4 — membership is not authorization. A group carrying no
// group_role_mapping rows resolves to nothing, and issuing a token for it would
// only hand the user a credential that can do nothing.
@test:Config {
    groups: ["sso-rbac", "storage"]
}
function testMembershipWithoutRolesIsNotAuthorization() returns error? {
    string uniqueValue = uuid:createType1AsString();
    string userId = uuid:createType1AsString();
    string username = "sso-gate-roleless-" + uniqueValue;
    string claimValue = "roleless-" + uniqueValue;

    string groupId = check storage:createGroup({
        groupName: "SSO Gate Roleless Group " + uniqueValue,
        description: "Temporary group with no role mappings"
    });
    _ = check storage:createUserV2(userId, username, "SSO Gate Roleless", [], true);
    string mappingId = check storage:createSSOGroupMapping({
        issuer: GATE_TEST_ISSUER,
        claimName: "groups",
        claimValue: claimValue,
        groupId: groupId
    });

    types:OIDCIdTokenClaims claims = buildGateClaims(userId, [claimValue]);
    string[] permissions = check resolveLoginPermissions(userId, username, claims);

    test:assertTrue(hasGroup(check storage:getUserGroups(userId), groupId),
            "The mapping must still grant the federated membership");
    test:assertEquals(permissions.length(), 0,
            "A group with no role mappings must resolve to no permissions");
    test:assertFalse(isLoginAuthorized(true, permissions),
            "Membership of a group that grants nothing must not count as authorization");

    check storage:deleteSSOGroupMapping(mappingId, storage:DEFAULT_ORG_ID);
    check storage:reconcileFederatedGroupUserMappings(
            storage:DEFAULT_ORG_ID, GATE_TEST_ISSUER, userId, []);
    check storage:deleteUserV2(userId, "test-cleanup-user");
    check storage:deleteGroup(groupId);
}

// ============================================================================
// Mode 2 contract (the suite runs with federatedAccessControlEnabled = false)
// ============================================================================

// Scenario 7 — SSO-only mode without federated access control is documented as
// "log in with nothing, the admin assigns groups by hand". The gate must not
// change that, so this asserts the real HTTP path still admits the user.
@test:Config {
    groups: ["sso-rbac", "oidc", "login"]
}
function testZeroPermissionLoginAllowedWithoutFederatedAccessControl() returns error? {
    test:assertFalse(federatedAccessControlEnabled,
            "This test asserts the mode 2 contract and requires federated access control to be off");

    http:Response response = check authClient->post("/auth/login/oidc", {code: UNMAPPED_USER_CODE});

    test:assertEquals(response.statusCode, 200,
            "SSO-only mode must keep admitting users who resolve to no permissions");

    json responseBody = check response.getJsonPayload();
    json[] permissions = check responseBody.permissions.ensureType();
    test:assertEquals(permissions.length(), 0, "The unmapped user must log in with no permissions");
    test:assertTrue(responseBody.token is string, "A token must still be issued in SSO-only mode");

    // Scenario 8's mode 2 half: the same user can still refresh. Under federated
    // access control both this and the login above become 403; that transition is
    // covered by the decision tests, since the mode cannot be flipped here.
    string refreshToken = check responseBody.refreshToken;
    http:Response refreshResponse = check authClient->post("/auth/refresh-token", {refreshToken: refreshToken});
    test:assertEquals(refreshResponse.statusCode, 200,
            "SSO-only mode must keep allowing refresh for a zero-permission user");

    check storage:deleteUserV2(UNMAPPED_USER_ID, "test-cleanup-user");
}
