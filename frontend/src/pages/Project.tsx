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

import { Avatar, Button, Chip, CircularProgress, Grid, IconButton, ListingTable, PageContent, Stack, TablePagination, Tooltip, Typography } from '@wso2/oxygen-ui';
import { Plus, PlugZap, RefreshCw, Trash2, Pencil } from '@wso2/oxygen-ui-icons-react';
import EmptyListing from '../components/EmptyListing';
import IntegrationTypesCard from '../components/IntegrationTypesCard';
import { integrationTypeLabel } from '../constants/integrationTypes';
import { technologyLabel } from '../constants/technologies';
import SearchField from '../components/SearchField';
import DeleteIntegrationDialog from '../components/DeleteIntegrationDialog';
import { useNavigate } from 'react-router';
import { useState, type JSX } from 'react';
import { useProjectByHandler, useComponents, useComponentsPage, type GqlComponent } from '../api/queries';
import NotFound from '../components/NotFound';
import { formatDistanceToNow } from '../utils/time';
import { resourceUrl, narrow, broaden, newComponentUrl, type ProjectScope } from '../nav';
import { editComponentUrl } from '../paths';
import { Permissions } from '../constants/permissions';
import Authorized from '../components/Authorized';
import { useLoadProjectPermissions } from '../hooks/usePermissionLoader';

function IntegrationsTable({ orgHandler, scope, projectId, onSelect }: { orgHandler: string; scope: ProjectScope; projectId: string; onSelect: (handler: string) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [deleting, setDeleting] = useState<GqlComponent | null>(null);
  const { data, isLoading, isFetching: isRefreshing, refetch } = useComponentsPage(orgHandler, projectId, query ? 500 : rowsPerPage, query ? 0 : page * rowsPerPage);
  const components = data?.items ?? [];
  const serverTotal = data?.pageInfo?.total ?? 0;
  const q = query.trim().toLowerCase();
  // Matches both columns: the integration type label, and technology by its raw code
  // (BI/MI) as well as its label.
  const filtered = components.filter(
    (c) =>
      !q ||
      c.displayName.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      integrationTypeLabel(c.displayType, c.componentSubType).toLowerCase().includes(q) ||
      c.componentType?.toLowerCase().includes(q) ||
      technologyLabel(c.componentType).toLowerCase().includes(q),
  );
  const displayItems = query ? filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage) : filtered;
  const total = query ? filtered.length : serverTotal;

  return (
    <section>
      <Stack direction="row" alignItems="center" gap={2} sx={{ mb: 2 }}>
        <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
          Integrations
        </Typography>
        <IconButton
          size="small"
          aria-label="Refresh integrations"
          onClick={() => refetch()}
          disabled={isRefreshing}
          sx={isRefreshing ? { '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } }, '& svg': { animation: 'spin 1s linear infinite' } } : undefined}>
          <RefreshCw size={16} />
        </IconButton>
        <SearchField
          value={query}
          onChange={(v) => {
            setQuery(v);
            setPage(0);
          }}
          placeholder="Search"
          sx={{ flex: 1 }}
        />
        <Authorized permissions={Permissions.INTEGRATION_MANAGE}>
          <Button variant="contained" startIcon={<Plus size={16} />} onClick={() => navigate(newComponentUrl(scope))}>
            Create Integration
          </Button>
        </Authorized>
      </Stack>

      {isLoading ? (
        <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
      ) : filtered.length === 0 ? (
        <EmptyListing icon={<PlugZap size={48} />} title="No integrations found" description={query ? 'Try adjusting your search' : 'Create your first integration to get started'} />
      ) : (
        <ListingTable.Container disablePaper>
          <ListingTable variant="card" density="compact">
            <ListingTable.Head>
              <ListingTable.Row>
                <ListingTable.Cell>Name</ListingTable.Cell>
                <ListingTable.Cell>Description</ListingTable.Cell>
                <ListingTable.Cell>Type</ListingTable.Cell>
                <ListingTable.Cell>Technology</ListingTable.Cell>
                <ListingTable.Cell>Last Updated</ListingTable.Cell>
                <Authorized permissions={Permissions.INTEGRATION_MANAGE}>
                  <ListingTable.Cell width={100}>Actions</ListingTable.Cell>
                </Authorized>
              </ListingTable.Row>
            </ListingTable.Head>
            <ListingTable.Body>
              {displayItems.map((c) => (
                <ListingTable.Row
                  key={c.id}
                  variant="card"
                  clickable
                  hover
                  tabIndex={0}
                  aria-label={`View details for ${c.displayName}`}
                  onClick={() => onSelect(c.handler)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      if (e.key === ' ') e.preventDefault();
                      onSelect(c.handler);
                    }
                  }}>
                  <ListingTable.Cell>
                    <Stack direction="row" alignItems="center" gap={1.5}>
                      <Avatar sx={{ width: 32, height: 32, fontSize: 14, bgcolor: 'action.hover', color: 'text.primary' }}>{c.displayName[0].toUpperCase()}</Avatar>
                      {c.displayName}
                    </Stack>
                  </ListingTable.Cell>
                  <ListingTable.Cell>
                    <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 200 }}>
                      {c.description || ''}
                    </Typography>
                  </ListingTable.Cell>
                  <ListingTable.Cell>{integrationTypeLabel(c.displayType, c.componentSubType)}</ListingTable.Cell>
                  <ListingTable.Cell>
                    <Chip label={technologyLabel(c.componentType)} size="small" variant="outlined" />
                  </ListingTable.Cell>
                  <ListingTable.Cell>
                    <Typography variant="body2" color="text.secondary">
                      {formatDistanceToNow(c.lastBuildDate)}
                    </Typography>
                  </ListingTable.Cell>
                  <Authorized permissions={Permissions.INTEGRATION_MANAGE}>
                    <ListingTable.Cell>
                      <Stack direction="row" gap={0.5}>
                        <Tooltip title="Edit">
                          <IconButton
                            size="small"
                            aria-label={`Edit ${c.displayName}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(editComponentUrl(scope.org, scope.project, c.handler));
                            }}>
                            <Pencil size={16} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton
                            size="small"
                            color="error"
                            aria-label={`Delete ${c.displayName}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleting(c);
                            }}>
                            <Trash2 size={16} />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </ListingTable.Cell>
                  </Authorized>
                </ListingTable.Row>
              ))}
            </ListingTable.Body>
          </ListingTable>
        </ListingTable.Container>
      )}
      <TablePagination
        component="div"
        count={total}
        page={page}
        onPageChange={(_, p) => setPage(p)}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={(e) => {
          setRowsPerPage(parseInt(e.target.value, 10));
          setPage(0);
        }}
        rowsPerPageOptions={[5, 10, 20, 50]}
        sx={{ mt: 1 }}
      />

      {deleting && (
        <DeleteIntegrationDialog
          component={deleting}
          orgHandler={scope.org}
          projectId={projectId}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            if (page > 0 && page * rowsPerPage >= total - 1) setPage((p) => p - 1);
          }}
        />
      )}
    </section>
  );
}

export default function Project(scope: ProjectScope): JSX.Element {
  const navigate = useNavigate();
  const { data: project, isLoading: loadingProject } = useProjectByHandler(scope.project);
  const projectId = project?.id ?? '';
  useLoadProjectPermissions(scope.org, projectId);
  const { data: components = [] } = useComponents(scope.org, projectId);

  if (loadingProject) {
    return (
      <PageContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </PageContent>
    );
  }
  if (!project) {
    return <NotFound message="Project not found" backTo={resourceUrl(broaden(scope)!, 'overview')} backLabel="Back to Projects" />;
  }

  return (
    <PageContent>
      <Stack component="header" direction="row" alignItems="center" gap={2} sx={{ mb: 4 }}>
        <Avatar sx={{ width: 56, height: 56, fontSize: 24, bgcolor: 'text.primary', color: 'background.paper' }}>{project?.name?.[0]?.toUpperCase() ?? 'P'}</Avatar>
        <div>
          <Typography variant="h1">{project.name}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {project.description}
          </Typography>
        </div>
      </Stack>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 8 }}>
          <IntegrationsTable orgHandler={scope.org} scope={scope} projectId={projectId} onSelect={(handler) => navigate(resourceUrl(narrow(scope, handler), 'overview'))} />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Stack gap={3}>
            <IntegrationTypesCard components={components} />
          </Stack>
        </Grid>
      </Grid>
    </PageContent>
  );
}
