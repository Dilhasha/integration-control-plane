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
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { lazy, Suspense, useEffect, useMemo, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Autocomplete, Box, CircularProgress, Divider, IconButton, InputAdornment, OutlinedInput, PageContent, Stack, TextField, Tooltip, Typography } from '@wso2/oxygen-ui';
import { Eye, EyeOff } from '@wso2/oxygen-ui-icons-react';
import { useProjectByHandler, useComponentByHandler, useEnvironments, useArtifacts, useOpenApiDefinitionsByRuntime, type GqlArtifact } from '../api/queries';
import NotFound from '../components/NotFound';
import Authorized from '../components/Authorized';
import CopyButton from '../components/CopyButton';
import { matchesServiceBasePath } from '../utils/openApiMatching';
import { tryitApiUrl } from '../config/api';
import { Permissions } from '../constants/permissions';
import { resourceUrl, broaden, type ComponentScope } from '../nav';

// swagger-ui-react is ~1.3MB gzipped - code-split it out of the main bundle (same reasoning as
// EntryPoints.tsx's lazy-loaded OpenApiDefinitionsDrawer), since it's only needed once a service
// with a packed OpenAPI definition is actually selected.
const TestConsoleSwaggerPanel = lazy(() => import('../components/TestConsoleSwaggerPanel'));

interface RuntimeRef {
  runtimeId: string;
  runtimeName?: string;
  status: string;
}

interface ListenerRef {
  protocol?: string;
  port?: number;
}

function serviceLabel(service: GqlArtifact): string {
  const basePath = service.basePath?.toString();
  return basePath ? `${service.name} (${basePath})` : service.name;
}

function runningRuntimes(artifact: GqlArtifact | null): RuntimeRef[] {
  const runtimes = (artifact?.runtimes as RuntimeRef[] | undefined) ?? [];
  return runtimes.filter((r) => r.status === 'RUNNING');
}

// A Service can have multiple RUNNING runtime instances (e.g. one per replica); default to the
// first one so there's always a sensible pick, but the Runtime selector below lets the user
// target a specific instance instead (e.g. to test a particular replica).
function pickRuntimeId(artifact: GqlArtifact | null): string {
  return runningRuntimes(artifact)[0]?.runtimeId ?? '';
}

function pickListenerPort(artifact: GqlArtifact | null): number | null {
  const listeners = (artifact?.listeners as ListenerRef[] | undefined) ?? [];
  const listener = listeners.find((l) => (l.protocol ?? '').toLowerCase().startsWith('http')) ?? listeners[0];
  return listener?.port ?? null;
}

// Builds the Try-It proxy URL for the selected service on the selected runtime instance — the
// only invocable address is now resolved server-side (icp_server's tryit_proxy_service.bal),
// since the runtime's own listener host is frequently unusable from the browser (bind-all
// addresses, no CORS, unreachable networks). The frontend only needs to know which port to ask
// for; the proxy validates it against that runtime's actually-registered listeners.
function computeInvokeUrl(componentId: string, environmentId: string, runtimeId: string, artifact: GqlArtifact | null): string {
  if (!artifact || !runtimeId) return '';
  const port = pickListenerPort(artifact);
  if (port === null) return '';
  const basePath = artifact.basePath?.toString() ?? '';
  const normalizedBasePath = basePath ? (basePath.startsWith('/') ? basePath : `/${basePath}`) : '';
  return tryitApiUrl(componentId, environmentId, runtimeId, port, normalizedBasePath);
}

export default function TestConsole(scope: ComponentScope): JSX.Element {
  const { data: project, isLoading: loadingProject } = useProjectByHandler(scope.project);
  const projectId = project?.id ?? '';
  const { data: component, isLoading: loadingComponent } = useComponentByHandler(projectId, scope.component);
  const componentId = component?.id ?? '';
  const { data: environments = [], isLoading: loadingEnvs } = useEnvironments(projectId);

  // Deep-link params (e.g. from EntryPoints.tsx's "Test" action): ?service=<name>&env=<environmentId>
  const [searchParams] = useSearchParams();
  const [selectedEnvId, setSelectedEnvId] = useState(searchParams.get('env') ?? '');
  useEffect(() => {
    if (!environments.length) return;
    setSelectedEnvId((prev) => (prev && environments.some((e) => e.id === prev) ? prev : environments[0].id));
  }, [environments]);
  const selectedEnv = environments.find((e) => e.id === selectedEnvId) ?? null;

  const { data: services = [], isLoading: loadingServices } = useArtifacts('Service', selectedEnvId, componentId);
  const [selectedServiceName, setSelectedServiceName] = useState(searchParams.get('service') ?? '');
  useEffect(() => {
    if (!services.length) return;
    setSelectedServiceName((prev) => (prev && services.some((s) => s.name === prev) ? prev : services[0].name));
  }, [services]);
  const selectedService = services.find((s) => s.name === selectedServiceName) ?? null;

  // Which runtime instance to target — defaults to the first RUNNING one, but user-overridable
  // (a service can have multiple replicas; Try It needs to hit one of them specifically).
  const [selectedRuntimeId, setSelectedRuntimeId] = useState('');
  useEffect(() => {
    setSelectedRuntimeId(pickRuntimeId(selectedService));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedService?.name, selectedEnvId]);
  const runtimeOptions = runningRuntimes(selectedService);
  const selectedRuntime = runtimeOptions.find((r) => r.runtimeId === selectedRuntimeId) ?? null;

  const invokeUrl = useMemo(() => computeInvokeUrl(componentId, selectedEnvId, selectedRuntime?.runtimeId ?? '', selectedService), [componentId, selectedEnvId, selectedRuntime, selectedService]);

  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [showHeaderValue, setShowHeaderValue] = useState(false);

  const { data: allDefinitions = [], isLoading: loadingDefs, error: defsError } = useOpenApiDefinitionsByRuntime(selectedRuntimeId, !!selectedRuntimeId);
  const basePath = selectedService?.basePath?.toString() ?? '';
  const definition = useMemo(() => allDefinitions.find((d) => matchesServiceBasePath(d.fileName, basePath)), [allDefinitions, basePath]);
  const parsedSpec = useMemo(() => {
    if (!definition) return { spec: null, error: null as string | null };
    try {
      return { spec: JSON.parse(definition.definition) as object, error: null };
    } catch {
      return { spec: null, error: 'Could not parse this OpenAPI definition as JSON.' };
    }
  }, [definition]);

  if (loadingProject || loadingComponent || loadingEnvs) {
    return (
      <PageContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </PageContent>
    );
  }
  if (!component) return <NotFound message="Component not found" backTo={resourceUrl(broaden(scope)!, 'overview')} backLabel="Back to Project" />;

  return (
    <PageContent>
      <Typography variant="h1" sx={{ mb: 0.5 }}>
        Test Console
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Send test requests to <strong>{component.displayName ?? scope.component}</strong>&apos;s services.
      </Typography>

      <Authorized
        permissions={[Permissions.INTEGRATION_EDIT, Permissions.INTEGRATION_MANAGE]}
        fallback={
          <Typography color="text.secondary" sx={{ py: 4 }}>
            You do not have permission to send test requests for this integration.
          </Typography>
        }>
        <Stack direction="column" gap={2} sx={{ maxWidth: 820, mb: 3 }}>
          <Stack direction="row" alignItems="center" gap={2}>
            <Typography variant="body2" sx={{ minWidth: 120, fontWeight: 500, color: 'text.secondary' }}>
              Environment
            </Typography>
            <Autocomplete
              size="small"
              sx={{ minWidth: 240 }}
              options={environments}
              getOptionLabel={(e) => e.name}
              value={selectedEnv}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              disableClearable={environments.length > 0}
              onChange={(_, v) => setSelectedEnvId(v?.id ?? '')}
              renderInput={(params) => <TextField {...params} placeholder="Select environment" />}
            />
          </Stack>

          <Stack direction="row" alignItems="center" gap={2}>
            <Typography variant="body2" sx={{ minWidth: 120, fontWeight: 500, color: 'text.secondary' }}>
              Service
            </Typography>
            {loadingServices ? (
              <CircularProgress size={20} />
            ) : (
              <Autocomplete
                size="small"
                sx={{ minWidth: 320 }}
                options={services}
                getOptionLabel={serviceLabel}
                renderOption={(props, s) => (
                  <Box component="li" {...props} key={s.name}>
                    <Stack>
                      <Typography variant="body2">{s.name}</Typography>
                      {s.basePath?.toString() && (
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                          {s.basePath.toString()}
                        </Typography>
                      )}
                    </Stack>
                  </Box>
                )}
                value={selectedService}
                isOptionEqualToValue={(a, b) => a.name === b.name}
                disableClearable={services.length > 0}
                onChange={(_, v) => setSelectedServiceName(v?.name ?? '')}
                renderInput={(params) => <TextField {...params} placeholder="Select service" />}
              />
            )}
          </Stack>

          {runtimeOptions.length > 0 && (
            <Stack direction="row" alignItems="center" gap={2}>
              <Typography variant="body2" sx={{ minWidth: 120, fontWeight: 500, color: 'text.secondary' }}>
                Runtime
              </Typography>
              <Autocomplete
                size="small"
                sx={{ minWidth: 320 }}
                options={runtimeOptions}
                getOptionLabel={(r) => r.runtimeName ?? r.runtimeId}
                value={selectedRuntime}
                isOptionEqualToValue={(a, b) => a.runtimeId === b.runtimeId}
                disableClearable={runtimeOptions.length > 0}
                onChange={(_, v) => setSelectedRuntimeId(v?.runtimeId ?? '')}
                renderInput={(params) => <TextField {...params} placeholder="Select runtime instance" />}
              />
            </Stack>
          )}

          <Stack direction="row" alignItems="flex-start" gap={2}>
            <Typography variant="body2" sx={{ minWidth: 120, fontWeight: 500, color: 'text.secondary', pt: 1 }}>
              Auth Header
            </Typography>
            <Stack direction="row" gap={1} sx={{ flex: 1 }}>
              <TextField size="small" value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="Header name" sx={{ width: 200, fontFamily: 'monospace' }} />
              <OutlinedInput
                size="small"
                type={showHeaderValue ? 'text' : 'password'}
                value={headerValue}
                onChange={(e) => setHeaderValue(e.target.value)}
                placeholder="e.g. Bearer <token>"
                sx={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}
                endAdornment={
                  <InputAdornment position="end">
                    <Tooltip title={showHeaderValue ? 'Hide' : 'Show'}>
                      <IconButton size="small" onClick={() => setShowHeaderValue((s) => !s)}>
                        {showHeaderValue ? <EyeOff size={16} /> : <Eye size={16} />}
                      </IconButton>
                    </Tooltip>
                    <CopyButton value={headerValue} label="header value" />
                  </InputAdornment>
                }
              />
            </Stack>
          </Stack>
        </Stack>

        <Divider sx={{ mb: 3 }} />

        {loadingDefs ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : defsError ? (
          <Alert severity="error" sx={{ maxWidth: 820 }}>
            Failed to load OpenAPI definitions for this runtime.
          </Alert>
        ) : !selectedService ? (
          <Typography color="text.secondary" sx={{ py: 4 }}>
            No services found for this environment.
          </Typography>
        ) : !selectedRuntimeId ? (
          <Typography color="text.secondary" sx={{ py: 4 }}>
            No running runtime instance found for this service.
          </Typography>
        ) : parsedSpec.error ? (
          <Alert severity="warning" sx={{ maxWidth: 820 }}>
            {parsedSpec.error}
          </Alert>
        ) : !parsedSpec.spec ? (
          <Typography color="text.secondary" sx={{ py: 4 }}>
            No OpenAPI definition packed for this service yet.
          </Typography>
        ) : (
          <Suspense
            fallback={
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            }>
            <TestConsoleSwaggerPanel spec={parsedSpec.spec} invokeUrl={invokeUrl} headerName={headerName} headerValue={headerValue} />
          </Suspense>
        )}
      </Authorized>
    </PageContent>
  );
}
