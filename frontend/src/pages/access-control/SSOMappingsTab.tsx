/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControl, IconButton, InputLabel, ListingTable, MenuItem, Select, Stack, TextField, Tooltip, Typography } from '@wso2/oxygen-ui';
import { Plus, Trash2 } from '@wso2/oxygen-ui-icons-react';
import { useEffect, useState, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useCreateSSOGroupMapping, useDeleteSSOGroupMapping, useGroups, useSSOGroupMappings } from '../../api/authQueries';
import type { SSOGroupMapping, SSOGroupMappingInput } from '../../api/auth';
import { Permissions } from '../../constants/permissions';
import { useAccessControl } from '../../contexts/AccessControlContext';
import { newOrgGroupUrl } from '../../paths';
import { FormDialog, Loading } from './shared';

// Administrative scope the tab is rendered at. Mappings from every scope are
// listed everywhere; create/delete only applies to mappings matching this scope.
export interface SSOMappingScope {
  projectId?: string;
  integrationId?: string;
}

function scopeMatches(mapping: SSOGroupMapping, scope: SSOMappingScope): boolean {
  return (mapping.projectUuid ?? null) === (scope.projectId ?? null) && (mapping.integrationUuid ?? null) === (scope.integrationId ?? null);
}

function scopeLabel(mapping: SSOGroupMapping): string {
  if (mapping.integrationUuid) return `Integration · ${mapping.integrationName ?? mapping.integrationUuid}`;
  if (mapping.projectUuid) return `Project · ${mapping.projectName ?? mapping.projectUuid}`;
  return 'Organization';
}

function MappingDialog({ orgHandler, scope, onClose, onSaved }: { orgHandler: string; scope: SSOMappingScope; onClose: () => void; onSaved: (message: string) => void }): JSX.Element {
  const navigate = useNavigate();
  const { data: groups = [] } = useGroups(orgHandler);
  const createMutation = useCreateSSOGroupMapping(orgHandler);
  const [form, setForm] = useState<SSOGroupMappingInput>(() => ({
    issuer: window.API_CONFIG.ssoIssuer,
    claimName: 'groups',
    claimValue: '',
    groupId: '',
  }));
  const [error, setError] = useState<string | null>(null);
  const pending = createMutation.isPending;
  const valid = form.issuer.trim() && form.claimName.trim() && form.claimValue.trim() && form.groupId;
  const isOrgLevel = !scope.projectId;

  const save = () => {
    setError(null);
    const input: SSOGroupMappingInput = {
      issuer: form.issuer.trim(),
      claimName: form.claimName.trim(),
      claimValue: form.claimValue.trim(),
      groupId: form.groupId,
      ...(scope.projectId ? { projectUuid: scope.projectId } : {}),
      ...(scope.integrationId ? { integrationUuid: scope.integrationId } : {}),
    };
    createMutation.mutate(input, {
      onSuccess: () => {
        onClose();
        onSaved('SSO group mapping created successfully.');
      },
      onError: (err: Error) => setError(err.message ?? 'Failed to create SSO group mapping.'),
    });
  };

  return (
    <FormDialog open onClose={onClose} title="Create SSO Group Mapping" maxWidth="sm" primaryLabel="Create" primaryDisabled={!valid || pending} onPrimary={save}>
      {error && <Alert severity="error">{error}</Alert>}
      {!isOrgLevel && <Alert severity="info">This mapping will be created at the current {scope.integrationId ? 'integration' : 'project'} scope.</Alert>}
      <TextField label="Issuer" value={form.issuer} onChange={(e) => setForm((current) => ({ ...current, issuer: e.target.value }))} required fullWidth />
      <TextField label="Claim name" value={form.claimName} onChange={(e) => setForm((current) => ({ ...current, claimName: e.target.value }))} required fullWidth />
      <TextField label="IdP group or role value" value={form.claimValue} onChange={(e) => setForm((current) => ({ ...current, claimValue: e.target.value }))} required fullWidth />
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ sm: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          <FormControl required fullWidth size="small">
            <InputLabel id="sso-mapping-group-label">ICP group</InputLabel>
            <Select labelId="sso-mapping-group-label" label="ICP group" value={form.groupId} onChange={(e) => setForm((current) => ({ ...current, groupId: e.target.value as string }))}>
              {groups.length === 0 && <MenuItem disabled>No groups available</MenuItem>}
              {groups.map((group) => (
                <MenuItem key={group.groupId} value={group.groupId}>
                  {group.groupName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        {isOrgLevel && (
          <Button variant="outlined" size="small" startIcon={<Plus size={16} />} sx={{ flexShrink: 0, whiteSpace: 'nowrap', width: { xs: '100%', sm: 'auto' } }} onClick={() => navigate(`${newOrgGroupUrl(orgHandler)}?returnTo=sso-mappings`)}>
            Create Group
          </Button>
        )}
      </Stack>
    </FormDialog>
  );
}

export function SSOMappingsTab({ orgHandler, projectId, integrationId }: { orgHandler: string; projectId?: string; integrationId?: string }): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { hasAnyPermission } = useAccessControl();
  const scope: SSOMappingScope = { projectId, integrationId };
  const canManage = hasAnyPermission([Permissions.USER_MANAGE_GROUPS, Permissions.USER_UPDATE_GROUP_ROLES], projectId, integrationId);
  const { data: mappings = [], isLoading, isError } = useSSOGroupMappings(orgHandler);
  const deleteMutation = useDeleteSSOGroupMapping(orgHandler);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SSOGroupMapping | null>(null);
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    const state = location.state as { created?: boolean; name?: string } | null;
    if (state?.created) {
      setAlert({ type: 'success', message: `Group '${state.name}' created. It is now available for SSO mapping.` });
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  if (isLoading) return <Loading />;

  return (
    <>
      {alert && (
        <Alert severity={alert.type} onClose={() => setAlert(null)} sx={{ mb: 2 }}>
          {alert.message}
        </Alert>
      )}
      {isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load SSO group mappings.
        </Alert>
      )}
      <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
        SSO Group Mappings
      </Typography>
      {canManage && (
        <Stack direction="row" justifyContent={{ xs: 'flex-start', sm: 'flex-end' }} sx={{ mb: 2 }}>
          <Button variant="contained" startIcon={<Plus size={18} />} onClick={() => setCreating(true)}>
            Create Mapping
          </Button>
        </Stack>
      )}
      <Stack gap={1.5} sx={{ display: { xs: 'flex', md: 'none' } }}>
        {mappings.length === 0 ? (
          <Typography color="text.secondary">No records to display</Typography>
        ) : (
          mappings.map((mapping) => (
            <Box key={mapping.mappingId} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
              <Stack gap={1.5}>
                <Stack>
                  <Typography variant="body2">{mapping.claimValue}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {mapping.claimName} · {mapping.issuer}
                  </Typography>
                </Stack>
                <Stack>
                  <Typography variant="caption" color="text.secondary">
                    ICP Group
                  </Typography>
                  <Typography variant="body2">{mapping.groupName}</Typography>
                </Stack>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Chip label={scopeLabel(mapping)} size="small" variant="outlined" />
                  {canManage && scopeMatches(mapping, scope) && (
                    <Tooltip title="Delete">
                      <IconButton size="small" color="error" aria-label={`Delete mapping for ${mapping.claimValue}`} onClick={() => setDeleting(mapping)}>
                        <Trash2 size={16} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
              </Stack>
            </Box>
          ))
        )}
      </Stack>
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <ListingTable.Container>
          <ListingTable>
            <ListingTable.Head>
              <ListingTable.Row>
                <ListingTable.Cell>IdP Claim</ListingTable.Cell>
                <ListingTable.Cell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Claim Value</ListingTable.Cell>
                <ListingTable.Cell>ICP Group</ListingTable.Cell>
                <ListingTable.Cell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Scope</ListingTable.Cell>
                {canManage && <ListingTable.Cell align="right">Action</ListingTable.Cell>}
              </ListingTable.Row>
            </ListingTable.Head>
            <ListingTable.Body>
              {mappings.length === 0 ? (
                <ListingTable.Row>
                  <ListingTable.Cell colSpan={canManage ? 5 : 4} align="center">
                    No records to display
                  </ListingTable.Cell>
                </ListingTable.Row>
              ) : (
                mappings.map((mapping) => (
                  <ListingTable.Row key={mapping.mappingId}>
                    <ListingTable.Cell>
                      <Stack>
                        <Typography variant="body2">{mapping.claimName}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {mapping.issuer}
                        </Typography>
                        <Typography variant="caption" sx={{ display: { xs: 'block', md: 'none' } }}>
                          {mapping.claimValue}
                        </Typography>
                      </Stack>
                    </ListingTable.Cell>
                    <ListingTable.Cell sx={{ display: { xs: 'none', md: 'table-cell' } }}>{mapping.claimValue}</ListingTable.Cell>
                    <ListingTable.Cell>{mapping.groupName}</ListingTable.Cell>
                    <ListingTable.Cell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                      <Chip label={scopeLabel(mapping)} size="small" variant="outlined" />
                    </ListingTable.Cell>
                    {canManage && (
                      <ListingTable.Cell align="right">
                        {scopeMatches(mapping, scope) ? (
                          <Tooltip title="Delete">
                            <IconButton size="small" color="error" aria-label={`Delete mapping for ${mapping.claimValue}`} onClick={() => setDeleting(mapping)}>
                              <Trash2 size={16} />
                            </IconButton>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Managed at its own scope">
                            <Typography component="span" variant="caption" color="text.secondary">
                              —
                            </Typography>
                          </Tooltip>
                        )}
                      </ListingTable.Cell>
                    )}
                  </ListingTable.Row>
                ))
              )}
            </ListingTable.Body>
          </ListingTable>
        </ListingTable.Container>
      </Box>
      {creating && <MappingDialog orgHandler={orgHandler} scope={scope} onClose={() => setCreating(false)} onSaved={(message) => setAlert({ type: 'success', message })} />}
      {deleting && (
        <Dialog open onClose={() => setDeleting(null)} maxWidth="sm" fullWidth>
          <DialogTitle>Delete SSO Group Mapping</DialogTitle>
          <DialogContent>
            <DialogContentText>
              Delete the mapping from <strong>{deleting.claimValue}</strong> to <strong>{deleting.groupName}</strong>?
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="contained"
              color="error"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteMutation.mutate(deleting.mappingId, {
                  onSuccess: () => {
                    setDeleting(null);
                    setAlert({ type: 'success', message: 'SSO group mapping deleted successfully.' });
                  },
                  onError: (err) => {
                    setDeleting(null);
                    setAlert({ type: 'error', message: err.message ?? 'Failed to delete mapping.' });
                  },
                })
              }>
              Delete
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
