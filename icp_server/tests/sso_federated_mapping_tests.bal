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

import icp_server.auth;
import icp_server.storage;
import icp_server.types;

import ballerina/test;
import ballerina/uuid;

const string SSO_MAPPING_TEST_ISSUER = "https://idp.example.com";

@test:Config {
    groups: ["sso-rbac", "storage"]
}
function testSSOGroupMappingStorage() returns error? {
    string uniqueValue = uuid:createType1AsString();
    string userId = uuid:createType1AsString();
    string groupId = check storage:createGroup({
        groupName: "SSO Test Group " + uniqueValue,
        description: "Temporary group for SSO mapping storage tests"
    });
    string roleId = check storage:createRoleV2({
        roleName: "SSO Test Role " + uniqueValue,
        description: "Temporary role for SSO effective permission tests"
    });
    string scopedRoleId = check storage:createRoleV2({
        roleName: "SSO Scoped Test Role " + uniqueValue,
        description: "Temporary scoped role for SSO effective permission tests"
    });
    types:Permission userManageGroupsPermission = check storage:getPermissionByName(auth:PERMISSION_USER_MANAGE_GROUPS);
    types:Permission projectViewPermission = check storage:getPermissionByName(auth:PERMISSION_PROJECT_VIEW);
    check storage:assignPermissionsToRole(roleId, [userManageGroupsPermission.permissionId]);
    check storage:assignPermissionsToRole(scopedRoleId, [projectViewPermission.permissionId]);
    _ = check storage:createUserV2(
        userId,
        "sso-mapping-user-" + uniqueValue,
        "SSO Mapping User",
        [],
        true
    );
    types:Project? testProject = check storage:createProject({
        orgId: storage:DEFAULT_ORG_ID,
        orgHandler: "default",
        name: "SSO Test Project " + uniqueValue,
        projectHandler: "sso-test-project-" + uniqueValue
    }, {
        userId: userId,
        username: "sso-mapping-user-" + uniqueValue,
        displayName: "SSO Mapping User",
        permissions: []
    });
    if testProject is () {
        return error("Failed to create temporary project for SSO mapping test");
    }
    string projectId = testProject.id;
    int roleMappingId = check storage:assignRoleToGroup({
        groupId: groupId,
        roleId: roleId,
        orgUuid: storage:DEFAULT_ORG_ID
    });
    int scopedRoleMappingId = check storage:assignRoleToGroup({
        groupId: groupId,
        roleId: scopedRoleId,
        orgUuid: storage:DEFAULT_ORG_ID,
        projectUuid: projectId
    });

    types:SSOGroupMappingInput mappingInput = {
        issuer: SSO_MAPPING_TEST_ISSUER,
        claimName: "groups",
        claimValue: "icp-platform-admins-" + uniqueValue,
        groupId: groupId
    };

    string mappingId = check storage:createSSOGroupMapping(mappingInput);
    types:SSOGroupMapping mapping = check storage:getSSOGroupMappingById(mappingId);
    test:assertEquals(mapping.orgUuid, storage:DEFAULT_ORG_ID, "Mapping should default to the default organization");
    test:assertEquals(mapping.issuer, SSO_MAPPING_TEST_ISSUER, "Issuer should be persisted");
    test:assertEquals(mapping.claimName, "groups", "Claim name should be persisted");
    test:assertEquals(mapping.claimValue, mappingInput.claimValue, "Claim value should be persisted");
    test:assertEquals(mapping.groupId, groupId, "Mapped group should be persisted");
    test:assertEquals(mapping.projectUuid, (), "Mappings default to org-level scope");
    test:assertEquals(mapping.integrationUuid, (), "Mappings default to org-level scope");

    types:SSOGroupMapping[] mappings = check storage:getSSOGroupMappingsByOrgId(storage:DEFAULT_ORG_ID);
    test:assertTrue(hasSSOGroupMapping(mappings, mappingId), "Created mapping should be listed");

    string|error duplicateMapping = storage:createSSOGroupMapping(mappingInput);
    test:assertTrue(duplicateMapping is error, "Duplicate SSO group mappings should be rejected");

    // Project-scoped mapping: scope columns persist and duplicates are rejected
    // across scopes because the unique constraint ignores scope.
    types:SSOGroupMappingInput scopedMappingInput = {
        issuer: SSO_MAPPING_TEST_ISSUER,
        claimName: "groups",
        claimValue: "icp-project-devs-" + uniqueValue,
        groupId: groupId,
        projectUuid: projectId
    };
    string scopedMappingId = check storage:createSSOGroupMapping(scopedMappingInput);
    types:SSOGroupMapping scopedMapping = check storage:getSSOGroupMappingById(scopedMappingId);
    test:assertEquals(scopedMapping.projectUuid, projectId, "Project scope should be persisted");
    test:assertEquals(scopedMapping.integrationUuid, (), "Integration scope should stay empty");

    types:SSOGroupMappingResponse[] enrichedMappings =
        check storage:getSSOGroupMappingsWithGroupNamesByOrgId(storage:DEFAULT_ORG_ID);
    boolean foundScopedMapping = false;
    foreach types:SSOGroupMappingResponse enriched in enrichedMappings {
        if enriched.mappingId == scopedMappingId {
            foundScopedMapping = true;
            test:assertEquals(enriched.projectName, "SSO Test Project " + uniqueValue,
                "Enriched listing should include the scope project name");
        }
    }
    test:assertTrue(foundScopedMapping, "Scoped mapping should appear in the enriched listing");

    types:SSOGroupMappingInput crossScopeDuplicate = {
        issuer: SSO_MAPPING_TEST_ISSUER,
        claimName: "groups",
        claimValue: mappingInput.claimValue,
        groupId: groupId,
        projectUuid: projectId
    };
    string|error crossScopeResult = storage:createSSOGroupMapping(crossScopeDuplicate);
    test:assertTrue(crossScopeResult is error,
        "The same claim-to-group mapping must be rejected regardless of scope");

    int federatedMappingId = check storage:addFederatedGroupUserMapping({
        issuer: SSO_MAPPING_TEST_ISSUER,
        userUuid: userId,
        groupId: groupId,
        claimName: "groups",
        claimValue: mappingInput.claimValue
    });
    test:assertTrue(federatedMappingId > 0, "Federated membership ID should be returned");

    types:FederatedGroupUserMapping[] federatedMappings =
        check storage:getFederatedGroupUserMappings(userId);
    test:assertTrue(hasFederatedGroupUserMapping(federatedMappings, federatedMappingId),
        "Created federated membership should be listed");

    int|error duplicateFederatedMapping = storage:addFederatedGroupUserMapping({
        issuer: SSO_MAPPING_TEST_ISSUER,
        userUuid: userId,
        groupId: groupId,
        claimName: "groups",
        claimValue: mappingInput.claimValue
    });
    test:assertTrue(duplicateFederatedMapping is error, "Duplicate federated memberships should be rejected");

    boolean manualMember = check storage:isUserInGroup(userId, groupId);
    test:assertFalse(manualMember, "Federated memberships should not create manual group_user_mapping rows");

    types:EffectiveGroupUserMembership[] effectiveMemberships =
        check storage:getGroupUsersWithMembershipSource(groupId);
    test:assertEquals(effectiveMemberships.length(), 1, "Effective membership should be listed once");
    test:assertEquals(effectiveMemberships[0].userUuid, userId, "Effective membership should identify the user");
    test:assertEquals(effectiveMemberships[0].membershipSource, "federated",
        "SSO-owned membership should be marked as federated");

    json userWithGroups = check storage:getUserWithGroupsById(userId);
    json[] userGroups = check userWithGroups.groups.ensureType();
    boolean foundFederatedGroup = false;
    foreach json userGroup in userGroups {
        if userGroup.groupId == groupId {
            foundFederatedGroup = true;
            test:assertEquals(userGroup.membershipSource, "federated",
                "User group responses should expose the federated source");
        }
    }
    test:assertTrue(foundFederatedGroup, "User details should include the effective SSO-mapped group");

    check storage:addUserToGroup(userId, groupId);
    effectiveMemberships = check storage:getGroupUsersWithMembershipSource(groupId);
    test:assertEquals(effectiveMemberships[0].membershipSource, "manual_and_federated",
        "Memberships owned locally and by SSO should expose both sources");
    check storage:removeUserFromGroup(userId, groupId);

    types:Group[] effectiveGroups = check storage:getUserGroups(userId);
    test:assertTrue(hasGroup(effectiveGroups, groupId), "Federated memberships should be effective user groups");

    types:Group[] manualGroups = check storage:getUserManualGroups(userId);
    test:assertFalse(hasGroup(manualGroups, groupId), "Federated memberships should not appear as manual groups");

    types:AccessScope orgScope = {orgUuid: storage:DEFAULT_ORG_ID};
    boolean hasFederatedPermission = check auth:hasPermission(userId, auth:PERMISSION_USER_MANAGE_GROUPS, orgScope);
    test:assertTrue(hasFederatedPermission, "Federated group memberships should grant permissions");

    boolean hasProjectPermissionAtOrg = check auth:hasPermission(userId, auth:PERMISSION_PROJECT_VIEW, orgScope);
    test:assertFalse(hasProjectPermissionAtOrg, "Project-scoped federated permissions should not apply org-wide");

    types:AccessScope projectScope = {orgUuid: storage:DEFAULT_ORG_ID, projectUuid: projectId};
    boolean hasProjectPermission = check auth:hasPermission(userId, auth:PERMISSION_PROJECT_VIEW, projectScope);
    test:assertTrue(hasProjectPermission, "Project-scoped federated memberships should grant scoped permissions");

    types:Permission[] allPermissions = check storage:getAllUserPermissions(userId);
    test:assertTrue(hasPermission(allPermissions, auth:PERMISSION_USER_MANAGE_GROUPS),
        "Federated memberships should be included in all-permission resolution");

    int groupUserCount = check storage:getGroupUserCount(groupId);
    test:assertEquals(groupUserCount, 1, "Federated memberships should count as effective group users");

    types:GroupResponse[] groupsWithCounts = check storage:getGroupsWithCountsByOrgId(storage:DEFAULT_ORG_ID);
    test:assertEquals(getGroupUserCountFromList(groupsWithCounts, groupId), 1,
        "Group list user counts should include federated memberships");

    check storage:removeRoleFromGroup(scopedRoleMappingId);
    check storage:removeRoleFromGroup(roleMappingId);
    check storage:removePermissionsFromRole(scopedRoleId, [projectViewPermission.permissionId]);
    check storage:removePermissionsFromRole(roleId, [userManageGroupsPermission.permissionId]);
    check storage:deleteRoleV2(scopedRoleId);
    check storage:deleteRoleV2(roleId);
    check storage:deleteProject(projectId);
    check storage:deleteUserV2(userId, "test-cleanup-user");
    check storage:deleteGroup(groupId);
}

@test:Config {
    groups: ["sso-rbac", "storage"]
}
function testFederatedMembershipReconciliation() returns error? {
    string uniqueValue = uuid:createType1AsString();
    string userId = uuid:createType1AsString();
    string groupId = check storage:createGroup({
        groupName: "SSO Reconcile Test Group " + uniqueValue,
        description: "Temporary group for SSO reconciliation tests"
    });
    _ = check storage:createUserV2(
        userId,
        "sso-reconcile-user-" + uniqueValue,
        "SSO Reconcile User",
        [groupId],
        true
    );

    types:FederatedGroupMembershipInput desired = {
        groupId: groupId,
        claimName: "groups",
        claimValue: "developers-" + uniqueValue
    };
    check storage:reconcileFederatedGroupUserMappings(
        storage:DEFAULT_ORG_ID,
        SSO_MAPPING_TEST_ISSUER,
        userId,
        [desired]
    );
    check storage:reconcileFederatedGroupUserMappings(
        storage:DEFAULT_ORG_ID,
        SSO_MAPPING_TEST_ISSUER,
        userId,
        [desired]
    );

    _ = check storage:addFederatedGroupUserMapping({
        issuer: "https://other-idp.example.com",
        userUuid: userId,
        groupId: groupId,
        claimName: "groups",
        claimValue: "other-issuer-" + uniqueValue
    });

    types:FederatedGroupUserMapping[] reconciledMappings =
        check storage:getFederatedGroupUserMappings(userId);
    test:assertEquals(countFederatedMappingsForIssuer(reconciledMappings, SSO_MAPPING_TEST_ISSUER), 1,
        "Repeated reconciliation should remain idempotent");

    check storage:reconcileFederatedGroupUserMappings(
        storage:DEFAULT_ORG_ID,
        SSO_MAPPING_TEST_ISSUER,
        userId,
        []
    );

    types:FederatedGroupUserMapping[] remainingMappings =
        check storage:getFederatedGroupUserMappings(userId);
    test:assertEquals(countFederatedMappingsForIssuer(remainingMappings, SSO_MAPPING_TEST_ISSUER), 0,
        "Missing claims should remove stale memberships for the current issuer");
    test:assertEquals(countFederatedMappingsForIssuer(remainingMappings, "https://other-idp.example.com"), 1,
        "Reconciliation should not modify memberships owned by another issuer");
    test:assertTrue(check storage:isUserInGroup(userId, groupId),
        "Reconciliation should preserve manual memberships");

    check storage:deleteUserV2(userId, "test-cleanup-user");
    check storage:deleteGroup(groupId);
}

// Deleting a mapping is the replacement for the removed enable/disable flow:
// the membership it granted disappears on the user's next login even though
// the IdP still sends the same claim.
@test:Config {
    groups: ["sso-rbac", "storage"]
}
function testDeletedMappingRemovesMembershipOnNextLogin() returns error? {
    string uniqueValue = uuid:createType1AsString();
    string userId = uuid:createType1AsString();
    string groupId = check storage:createGroup({
        groupName: "SSO Delete Test Group " + uniqueValue,
        description: "Temporary group for mapping deletion tests"
    });
    _ = check storage:createUserV2(
        userId,
        "sso-delete-user-" + uniqueValue,
        "SSO Delete User",
        [],
        true
    );

    string claimValue = "delete-test-" + uniqueValue;
    string mappingId = check storage:createSSOGroupMapping({
        issuer: SSO_MAPPING_TEST_ISSUER,
        claimName: "groups",
        claimValue: claimValue,
        groupId: groupId
    });

    types:OIDCIdTokenClaims claims = {
        sub: userId,
        iss: SSO_MAPPING_TEST_ISSUER,
        aud: "icp",
        exp: 2000000000,
        iat: 1999999000,
        rawClaims: {"groups": [claimValue]}
    };

    // First login: the mapping grants a federated membership.
    types:SSOGroupMapping[] issuerMappings =
        check storage:getSSOGroupMappingsByIssuer(storage:DEFAULT_ORG_ID, SSO_MAPPING_TEST_ISSUER);
    types:FederatedGroupMembershipInput[] desiredMemberships =
        auth:resolveFederatedGroupMemberships(claims, issuerMappings);
    check storage:reconcileFederatedGroupUserMappings(
        storage:DEFAULT_ORG_ID, SSO_MAPPING_TEST_ISSUER, userId, desiredMemberships);
    types:FederatedGroupUserMapping[] afterLogin = check storage:getFederatedGroupUserMappings(userId);
    test:assertEquals(countFederatedMappingsForIssuer(afterLogin, SSO_MAPPING_TEST_ISSUER), 1,
        "Login sync should create the federated membership");

    // Delete the mapping and simulate the next login with unchanged claims.
    check storage:deleteSSOGroupMapping(mappingId, storage:DEFAULT_ORG_ID);
    issuerMappings =
        check storage:getSSOGroupMappingsByIssuer(storage:DEFAULT_ORG_ID, SSO_MAPPING_TEST_ISSUER);
    desiredMemberships = auth:resolveFederatedGroupMemberships(claims, issuerMappings);
    check storage:reconcileFederatedGroupUserMappings(
        storage:DEFAULT_ORG_ID, SSO_MAPPING_TEST_ISSUER, userId, desiredMemberships);
    types:FederatedGroupUserMapping[] afterDelete = check storage:getFederatedGroupUserMappings(userId);
    test:assertEquals(countFederatedMappingsForIssuer(afterDelete, SSO_MAPPING_TEST_ISSUER), 0,
        "Deleting a mapping must remove its federated membership on the next login");

    check storage:deleteUserV2(userId, "test-cleanup-user");
    check storage:deleteGroup(groupId);
}

function hasSSOGroupMapping(types:SSOGroupMapping[] mappings, string mappingId) returns boolean {
    foreach types:SSOGroupMapping mapping in mappings {
        if mapping.mappingId == mappingId {
            return true;
        }
    }
    return false;
}

function hasFederatedGroupUserMapping(types:FederatedGroupUserMapping[] mappings, int mappingId) returns boolean {
    foreach types:FederatedGroupUserMapping mapping in mappings {
        if mapping.id == mappingId {
            return true;
        }
    }
    return false;
}

function hasGroup(types:Group[] groups, string groupId) returns boolean {
    foreach types:Group group in groups {
        if group.groupId == groupId {
            return true;
        }
    }
    return false;
}

function hasPermission(types:Permission[] permissions, string permissionName) returns boolean {
    foreach types:Permission permission in permissions {
        if permission.permissionName == permissionName {
            return true;
        }
    }
    return false;
}

function getGroupUserCountFromList(types:GroupResponse[] groups, string groupId) returns int {
    foreach types:GroupResponse group in groups {
        if group.groupId == groupId {
            return group.userCount;
        }
    }
    return -1;
}

function countFederatedMappingsForIssuer(types:FederatedGroupUserMapping[] mappings, string issuer) returns int {
    int count = 0;
    foreach types:FederatedGroupUserMapping mapping in mappings {
        if mapping.issuer == issuer {
            count += 1;
        }
    }
    return count;
}
