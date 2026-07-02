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

import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  ListingTable,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@wso2/oxygen-ui';
import { Pencil, Plus, Trash2 } from '@wso2/oxygen-ui-icons-react';
import { useEffect, useState, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useCreateSSOGroupMapping, useDeleteSSOGroupMapping, useGroups, useSSOGroupMappings, useUpdateSSOGroupMapping } from '../../api/authQueries';
import type { SSOGroupMapping, SSOGroupMappingInput } from '../../api/auth';
import { Permissions } from '../../constants/permissions';
import { useAccessControl } from '../../contexts/AccessControlContext';
import { newOrgGroupUrl } from '../../paths';
import { FormDialog, Loading } from './shared';

const EMPTY_MAPPING: SSOGroupMappingInput = {
  issuer: '',
  claimName: 'groups',
  claimValue: '',
  groupId: '',
  enabled: true,
};

function MappingDialog({ orgHandler, mapping, onClose, onSaved }: { orgHandler: string; mapping: SSOGroupMapping | null; onClose: () => void; onSaved: (message: string) => void }): JSX.Element {
  const navigate = useNavigate();
  const { data: groups = [] } = useGroups(orgHandler);
  const createMutation = useCreateSSOGroupMapping(orgHandler);
  const updateMutation = useUpdateSSOGroupMapping(orgHandler);
  const [form, setForm] = useState<SSOGroupMappingInput>(() =>
    mapping
      ? {
          issuer: mapping.issuer,
          claimName: mapping.claimName,
          claimValue: mapping.claimValue,
          groupId: mapping.groupId,
          enabled: mapping.enabled,
        }
      : { ...EMPTY_MAPPING, issuer: window.API_CONFIG.ssoIssuer },
  );
  const [error, setError] = useState<string | null>(null);
  const pending = createMutation.isPending || updateMutation.isPending;
  const valid = form.issuer.trim() && form.claimName.trim() && form.claimValue.trim() && form.groupId;

  const save = () => {
    setError(null);
    const input = {
      ...form,
      issuer: form.issuer.trim(),
      claimName: form.claimName.trim(),
      claimValue: form.claimValue.trim(),
    };
    const options = {
      onSuccess: () => {
        onClose();
        onSaved(mapping ? 'SSO group mapping updated successfully.' : 'SSO group mapping created successfully.');
      },
      onError: (err: Error) => setError(err.message ?? 'Failed to save SSO group mapping.'),
    };
    if (mapping) {
      updateMutation.mutate({ mappingId: mapping.mappingId, ...input }, options);
    } else {
      createMutation.mutate(input, options);
    }
  };

  return (
    <FormDialog open onClose={onClose} title={mapping ? 'Edit SSO Group Mapping' : 'Create SSO Group Mapping'} maxWidth="sm" primaryLabel={mapping ? 'Save' : 'Create'} primaryDisabled={!valid || pending} onPrimary={save}>
      {error && <Alert severity="error">{error}</Alert>}
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
        <Button variant="outlined" size="small" startIcon={<Plus size={16} />} sx={{ flexShrink: 0, whiteSpace: 'nowrap', width: { xs: '100%', sm: 'auto' } }} onClick={() => navigate(`${newOrgGroupUrl(orgHandler)}?returnTo=sso-mappings`)}>
          Create Group
        </Button>
      </Stack>
      <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => setForm((current) => ({ ...current, enabled: e.target.checked }))} />} label="Enabled" />
    </FormDialog>
  );
}

export function SSOMappingsTab({ orgHandler }: { orgHandler: string }): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { hasAnyPermission } = useAccessControl();
  const canManage = hasAnyPermission([Permissions.USER_MANAGE_GROUPS, Permissions.USER_UPDATE_GROUP_ROLES]);
  const { data: mappings = [], isLoading, isError } = useSSOGroupMappings(orgHandler);
  const updateMutation = useUpdateSSOGroupMapping(orgHandler);
  const deleteMutation = useDeleteSSOGroupMapping(orgHandler);
  const [editing, setEditing] = useState<SSOGroupMapping | null | undefined>(undefined);
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
          <Button variant="contained" startIcon={<Plus size={18} />} onClick={() => setEditing(null)}>
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
                  <Chip label={mapping.enabled ? 'Enabled' : 'Disabled'} size="small" color={mapping.enabled ? 'success' : 'default'} />
                  {canManage && (
                    <Stack direction="row" alignItems="center">
                      <Tooltip title={mapping.enabled ? 'Disable' : 'Enable'}>
                        <Switch
                          size="small"
                          checked={mapping.enabled}
                          disabled={updateMutation.isPending}
                          inputProps={{ 'aria-label': `${mapping.enabled ? 'Disable' : 'Enable'} mapping for ${mapping.claimValue}` }}
                          onChange={(e) =>
                            updateMutation.mutate(
                              {
                                mappingId: mapping.mappingId,
                                issuer: mapping.issuer,
                                claimName: mapping.claimName,
                                claimValue: mapping.claimValue,
                                groupId: mapping.groupId,
                                enabled: e.target.checked,
                              },
                              { onError: (err) => setAlert({ type: 'error', message: err.message ?? 'Failed to update mapping.' }) },
                            )
                          }
                        />
                      </Tooltip>
                      <Tooltip title="Edit">
                        <IconButton size="small" aria-label={`Edit mapping for ${mapping.claimValue}`} onClick={() => setEditing(mapping)}>
                          <Pencil size={16} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" color="error" aria-label={`Delete mapping for ${mapping.claimValue}`} onClick={() => setDeleting(mapping)}>
                          <Trash2 size={16} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
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
                <ListingTable.Cell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Status</ListingTable.Cell>
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
                      <Chip label={mapping.enabled ? 'Enabled' : 'Disabled'} size="small" color={mapping.enabled ? 'success' : 'default'} />
                    </ListingTable.Cell>
                    {canManage && (
                      <ListingTable.Cell align="right">
                        <Chip label={mapping.enabled ? 'On' : 'Off'} size="small" color={mapping.enabled ? 'success' : 'default'} sx={{ display: { xs: 'inline-flex', md: 'none' }, mr: 0.5 }} />
                        <Tooltip title={mapping.enabled ? 'Disable' : 'Enable'}>
                          <Switch
                            size="small"
                            checked={mapping.enabled}
                            disabled={updateMutation.isPending}
                            inputProps={{ 'aria-label': `${mapping.enabled ? 'Disable' : 'Enable'} mapping for ${mapping.claimValue}` }}
                            onChange={(e) =>
                              updateMutation.mutate(
                                {
                                  mappingId: mapping.mappingId,
                                  issuer: mapping.issuer,
                                  claimName: mapping.claimName,
                                  claimValue: mapping.claimValue,
                                  groupId: mapping.groupId,
                                  enabled: e.target.checked,
                                },
                                {
                                  onError: (err) => setAlert({ type: 'error', message: err.message ?? 'Failed to update mapping.' }),
                                },
                              )
                            }
                          />
                        </Tooltip>
                        <Tooltip title="Edit">
                          <IconButton size="small" aria-label={`Edit mapping for ${mapping.claimValue}`} onClick={() => setEditing(mapping)}>
                            <Pencil size={16} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton size="small" color="error" aria-label={`Delete mapping for ${mapping.claimValue}`} onClick={() => setDeleting(mapping)}>
                            <Trash2 size={16} />
                          </IconButton>
                        </Tooltip>
                      </ListingTable.Cell>
                    )}
                  </ListingTable.Row>
                ))
              )}
            </ListingTable.Body>
          </ListingTable>
        </ListingTable.Container>
      </Box>
      {editing !== undefined && <MappingDialog orgHandler={orgHandler} mapping={editing} onClose={() => setEditing(undefined)} onSaved={(message) => setAlert({ type: 'success', message })} />}
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
