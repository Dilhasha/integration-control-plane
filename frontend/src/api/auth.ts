import { getAccessToken } from '../auth/tokenManager';

async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(`${window.API_CONFIG.authBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body || `Request failed (${res.status})`;
    try {
      const json = JSON.parse(body);
      if (typeof json.message === 'string') {
        message = json.message;
      }
    } catch {
      // body is not JSON — use raw text as-is
    }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : (undefined as T);
}

export function authGet<T>(path: string): Promise<T> {
  return authFetch<T>(path);
}

export function authPost<T>(path: string, body: unknown): Promise<T> {
  return authFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function authPut<T>(path: string, body: unknown): Promise<T> {
  return authFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function authDelete<T>(path: string): Promise<T> {
  return authFetch<T>(path, { method: 'DELETE' });
}

// ── Permission fetching ──

interface UserPermissionsResponse {
  userId: string;
  scope: { orgUuid: number; projectUuid?: string; integrationUuid?: string; envUuid?: string };
  permissions: { permissionId: number; permissionName: string; permissionDomain: string; description: string }[];
  permissionNames: string[];
}

export function fetchOrgPermissions(orgHandle: string, userId: string): Promise<UserPermissionsResponse> {
  return authGet<UserPermissionsResponse>(`/orgs/${orgHandle}/users/${userId}/permissions`);
}

export function fetchProjectPermissions(orgHandle: string, userId: string, projectId: string): Promise<UserPermissionsResponse> {
  return authGet<UserPermissionsResponse>(`/orgs/${orgHandle}/users/${userId}/permissions?projectId=${projectId}`);
}

export function fetchComponentPermissions(orgHandle: string, userId: string, projectId: string, componentId: string): Promise<UserPermissionsResponse> {
  return authGet<UserPermissionsResponse>(`/orgs/${orgHandle}/users/${userId}/permissions?projectId=${projectId}&integrationId=${componentId}`);
}

// ── Types ──

export interface User {
  userId: string;
  username: string;
  displayName: string;
  isSuperAdmin: boolean;
  isOidcUser: boolean;
  groups: { groupId: string; groupName: string; groupDescription: string; membershipSource?: MembershipSource }[];
  groupCount: number;
}

export interface Role {
  roleId: string;
  roleName: string;
  description: string;
  orgId: number;
  groupCount?: number;
  userCount?: number;
}

export interface Permission {
  permissionId: string;
  permissionName: string;
  permissionDomain: string;
  resourceType: string;
  action: string;
  description: string;
}

export interface PermissionsResponse {
  permissions: Permission[];
  groupedByDomain: Record<string, Permission[]>;
}

export interface RoleDetail extends Role {
  permissions: Permission[];
}

export interface Group {
  groupId: string;
  groupName: string;
  description: string;
  userCount?: number;
  roleCount?: number;
}

export interface GroupRoleMapping {
  id: number;
  groupId: string;
  roleId: string;
  roleName: string;
  roleDescription: string;
  orgUuid: number;
  projectUuid: string | null;
  envUuid: string | null;
  integrationUuid: string | null;
}

export interface GroupUser {
  userId: string;
  username: string;
  displayName: string;
  membershipSource?: MembershipSource;
}

export type MembershipSource = 'manual' | 'federated' | 'manual_and_federated';

export interface SSOGroupMapping {
  mappingId: string;
  orgUuid: number;
  issuer: string;
  claimName: string;
  claimValue: string;
  groupId: string;
  groupName: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SSOGroupMappingInput {
  issuer: string;
  claimName: string;
  claimValue: string;
  groupId: string;
  enabled: boolean;
}

export interface RoleGroupMapping {
  id: number;
  groupId: string;
  groupName?: string;
  groupDescription?: string;
  roleId: string;
  orgUuid: number;
  projectUuid: string | null;
  envUuid: string | null;
  integrationUuid: string | null;
}
