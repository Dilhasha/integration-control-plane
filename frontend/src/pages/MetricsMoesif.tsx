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
import { Alert, Button, Card, CardContent, Chip, CircularProgress, Divider, IconButton, MenuItem, PageContent, Select, Stack, TextField, Tooltip, Typography } from '@wso2/oxygen-ui';
import { BarChart3, Download, RefreshCw } from '@wso2/oxygen-ui-icons-react';
import { useState, type JSX } from 'react';
import { useProjectByHandler, useComponentByHandler, useComponents, useEnvironments } from '../api/queries';
import { useMoesifMetricsConfig, useCreateMoesifDashboards, useMoesifDashboardEmbed, useMoesifApplications } from '../api/metricsMoesif';
import { downloadMoesifMetricsTemplate, MOESIF_METRICS_WORKSPACE_NAME } from '../assets/moesifMetricsTemplate';
import { downloadMoesifMiMetricsTemplate, MOESIF_MI_DASHBOARD_NAMES, MOESIF_MI_METRICS_WORKSPACE_NAME } from '../assets/moesifMiMetricsTemplate';
import { MI_DEPLOYMENT_TOML_SNIPPET, MI_LOG4J2_SNIPPET, miFluentBitEnv, downloadMoesifMiFluentBitFiles } from '../assets/moesifMiMetrics';
import CodeBoxWithCopy from '../components/CodeBoxWithCopy';
import EmptyListing from '../components/EmptyListing';
import NotFound from '../components/NotFound';
import { resourceUrl, broaden, hasComponent } from '../nav';
import type { MetricsPageProps } from './MetricsOpenSearch';

// Read scopes required on the Moesif Management API Key so the backend can list
// applications (to select one), list dashboards (to discover the imported
// workspace) and mint embed access tokens.
const REQUIRED_ENTITY_SCOPES: { entity: string; actions: string[] }[] = [
  { entity: 'Apps', actions: ['read'] },
  { entity: 'Dashboards', actions: ['read'] },
  { entity: 'Workspaces', actions: ['read'] },
];

const MOESIF_MAIN_BAL_IMPORT = 'import ballerinax/moesif as _;';

// Short description shown when introducing Moesif on the landing/config view.
// The leading "Moesif" is rendered in bold at the call site.
const MOESIF_DESCRIPTION = ' (a WSO2 company) allows you to observe your service integrations with real-time monitoring, behavioral analytics, and AI-powered insights into API adoption and usage.';

// Documentation guide for setting up Moesif-backed observability, referenced from
// the Moesif intro on the landing/config view.
const MOESIF_SETUP_GUIDE = 'https://wso2.com/integration-platform/docs/manage/icp/observability-setup';

// Documentation guides for setting up OpenSearch-backed observability, offered
// as an alternative when nothing is configured yet. The guide differs by runtime
// technology: MI (Micro Integrator) has its own docs, while other runtimes (BI)
// use the general ICP observability setup guide.
const OPENSEARCH_SETUP_GUIDE_DEFAULT = 'https://wso2.com/integration-platform/docs/manage/icp/observability-setup';
const OPENSEARCH_SETUP_GUIDE_MI = 'https://mi.docs.wso2.com/en/latest/install-and-setup/install/adding-observability-for-icp/';

// Build the metrics-only Config.toml snippet for publishing metrics to Moesif.
// Based on https://ballerina.io/learn/supported-observability-tools-and-platforms/moesif/
function moesifConfigToml(applicationId: string): string {
  return `[ballerina.observe]
metricsEnabled = true
metricsReporter = "moesif"

[ballerinax.moesif]
applicationId = "${applicationId}"          # Mandatory. Your Moesif Collector Application ID.
reporterBaseUrl = "https://api.moesif.net"  # Optional. Default: https://api.moesif.net
metricsReporterFlushInterval = 15000        # Optional. Default: 15000 (ms)
metricsReporterClientTimeout = 10000        # Optional. Default: 10000 (ms)`;
}

// Runtime configuration instructions for publishing metrics to Moesif. Rendered
// inline (directly on the page) so it can be shown without a popup. The
// instructions differ by runtime technology: BI (Ballerina) has a built-in
// Moesif reporter configured via main.bal + Config.toml, whereas MI (Micro
// Integrator) publishes analytics to a log that a Fluent Bit sidecar ships to
// Moesif.
function MoesifInstructionsContent({ applicationId, isMI }: { applicationId: string; isMI?: boolean }): JSX.Element {
  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        If you already have a{' '}
        <a href="https://www.moesif.com/" target="_blank" rel="noreferrer">
          Moesif
        </a>{' '}
        account, create an application for the integration you want to track and copy its <strong>Collector Application ID</strong>. Otherwise, sign up for Moesif with your organization and application details to obtain a Collector Application ID.
      </Typography>

      {isMI ? <MoesifMiRuntimeInstructions applicationId={applicationId} /> : <MoesifBiRuntimeInstructions applicationId={applicationId} />}

      <Alert severity="info" sx={{ mt: 2 }}>
        After applying this configuration you need to <strong>restart the runtime</strong> for it to start publishing metrics to Moesif.
      </Alert>
    </>
  );
}

// BI (Ballerina) runtime configuration: add the Moesif import to main.bal and
// the observability config to Config.toml.
function MoesifBiRuntimeInstructions({ applicationId }: { applicationId: string }): JSX.Element {
  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Add the following import to your runtime's <strong>main.bal</strong> file:
      </Typography>
      <CodeBoxWithCopy code={MOESIF_MAIN_BAL_IMPORT} />

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, mt: 2 }}>
        Add the following configuration to your runtime's <strong>Config.toml</strong> file:
      </Typography>
      <CodeBoxWithCopy code={moesifConfigToml(applicationId)} />
    </>
  );
}

// MI (Micro Integrator) runtime configuration. MI has no built-in Moesif
// reporter, so it writes analytics to a log which a Fluent Bit sidecar tails and
// forwards to Moesif. Three parts: enable statistics/analytics in
// deployment.toml, add the analytics appender/logger to log4j2.properties, then
// run the Fluent Bit sidecar with the Collector Application ID.
function MoesifMiRuntimeInstructions({ applicationId }: { applicationId: string }): JSX.Element {
  return (
    <>
      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        1. Enable statistics and analytics
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        <br />
        Add the following to <strong>&lt;MI_HOME&gt;/conf/deployment.toml</strong>, replacing <strong>&lt;UNIQUE_MI_SERVER_ID&gt;</strong> with a unique id for this server (each MI server publishing to the same Moesif application must use a distinct id):
      </Typography>
      <CodeBoxWithCopy code={MI_DEPLOYMENT_TOML_SNIPPET} />

      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        2. Route analytics to a log file
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        <br />
        Update <strong>&lt;MI_HOME&gt;/conf/log4j2.properties</strong> as described below (add the appender/logger names to the existing <strong>appenders</strong> and <strong>loggers</strong> lists, then add the definitions):
      </Typography>
      <CodeBoxWithCopy code={MI_LOG4J2_SNIPPET} />

      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        3. Run the Fluent Bit sidecar
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        <br />
        Download the Fluent Bit configuration bundle and unzip it first. In the generated <strong>.env</strong> file, set <strong>MI_HOME</strong> to your MI installation path. Set the <strong>Collector Application ID</strong> to the one you obtained from
        Moesif. Then, run <strong>docker compose up -d</strong> to start Fluent Bit to publish metrics to Moesif.
      </Typography>
      <Button size="small" variant="outlined" startIcon={<Download size={14} />} onClick={() => downloadMoesifMiFluentBitFiles(applicationId)} sx={{ mb: 1, alignSelf: 'flex-start', py: 0.25, px: 1, fontSize: 12 }}>
        Download Fluent Bit config
      </Button>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, mt: 1 }}>
        The generated <strong>.env</strong> looks like this:
      </Typography>
      <CodeBoxWithCopy code={miFluentBitEnv(applicationId)} />
    </>
  );
}

// Set up the Moesif metrics dashboard for an integration. Renders the runtime
// configuration instructions (so the runtime publishes metrics to Moesif) and
// the steps to import + link the metrics dashboard. The user downloads the ICP
// metrics template, imports it into Moesif (creating the "Application Metrics"
// dashboard and its workspace), sets that workspace's sharing to Public, then
// provides a Moesif Management API Key and selects the application to link. The
// token + Application ID are sent to the backend, which discovers the imported
// dashboard's workspace id and persists it against the integration (setting the
// `dashboardsCreated` flag). The Collector Application ID itself is not stored —
// it is used only transiently for workspace discovery. Workspaces can't be
// created via the API with public sharing, hence the manual import + Public step.
//
// When `isEdit` is set the card is in update mode for an already-linked
// dashboard: the user supplies a new Management API Key + Moesif Application ID
// to re-link (the backend re-discovers the workspace and overwrites the stored
// credentials). An optional Cancel action returns to the metrics view.
function MoesifDashboardCard({
  componentId,
  onCreate,
  creating,
  error,
  isEdit,
  isMI,
  onCancel,
}: {
  componentId: string;
  onCreate: (token: string, moesifAppId: string) => void;
  creating: boolean;
  error: unknown;
  isEdit?: boolean;
  isMI?: boolean;
  onCancel?: () => void;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [moesifAppId, setMoesifAppId] = useState('');

  // The selected Moesif application is the integration's Collector Application
  // ID, so reflect it into the runtime Config.toml snippet once chosen. Falls
  // back to a placeholder until an application is selected.
  const effectiveAppId = moesifAppId.trim() || '<MOESIF_COLLECTOR_APPLICATION_ID>';

  // Fetch the Moesif applications the entered Management API Key can access
  const listApps = useMoesifApplications();
  const apps = listApps.data ?? [];
  const trimmedToken = token.trim();

  // Changing the key invalidates any applications fetched for the previous key
  const handleTokenChange = (value: string): void => {
    setToken(value);
    if (listApps.data || listApps.error) {
      listApps.reset();
    }
    if (moesifAppId) {
      setMoesifAppId('');
    }
  };

  const handleFetchApps = (): void => {
    listApps.mutate(
      { componentId, managementApiKey: trimmedToken },
      // Auto-select when the key can access exactly one application.
      { onSuccess: (fetched) => fetched.length === 1 && setMoesifAppId(fetched[0].id) },
    );
  };
  return (
    <Stack sx={{ mt: 2 }}>
      {isEdit && (
        <Typography variant="h6" sx={{ mb: 1 }}>
          Update dashboard credentials
        </Typography>
      )}

      {/* Step 1: configure the runtime to publish metrics to Moesif. */}
      <MoesifInstructionsContent applicationId={effectiveAppId} isMI={isMI} />

      <Divider sx={{ my: 3 }} />

      {/* Step 2: import the dashboard template + link its workspace. */}
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        {isEdit
          ? 'If you have not imported the metrics dashboard into Moesif yet, follow the steps below. Then provide a new Management API Key and Moesif Application ID to re-link the dashboard.'
          : 'Import the metrics dashboard template into Moesif, make its workspace public, then link it here.'}
      </Typography>

      <Stack component="ol" sx={{ pl: 2.5, mb: 2, '& li': { mb: 1 } }} gap={0.5}>
        <li>
          <Typography variant="body2">Download the metrics dashboard template.</Typography>
          <Button size="small" variant="outlined" startIcon={<Download size={16} />} onClick={isMI ? downloadMoesifMiMetricsTemplate : downloadMoesifMetricsTemplate} sx={{ mt: 1 }}>
            Download template
          </Button>
        </li>
        <li>
          <Typography variant="body2">
            In Moesif, go to <strong>Dashboard Templates → Import Json Template</strong> and import the downloaded file.{' '}
            {isMI ? (
              <>
                This creates the <strong>{MOESIF_MI_DASHBOARD_NAMES.join(', ')}</strong> dashboard.
              </>
            ) : (
              <>
                This creates the <strong>Application Metrics</strong> dashboard.
              </>
            )}
          </Typography>
        </li>
        <li>
          <Typography variant="body2">
            Open the <strong>{isMI ? MOESIF_MI_METRICS_WORKSPACE_NAME : MOESIF_METRICS_WORKSPACE_NAME}</strong> workspace{isMI ? ' (in the Overall dashboard)' : ''}, click <strong>Share</strong>, and set its sharing to <strong>Public</strong>. This is required
            for the embedded chart to load.
          </Typography>
        </li>
        <li>
          <Typography variant="body2">
            Provide a Moesif <strong>Management API Key</strong> (with the read scopes below), <strong>fetch your applications</strong> and select the one to use, then {isEdit ? 'update the credentials' : 'link the dashboard'}.
          </Typography>
        </li>
      </Stack>

      <Stack gap={1.5} sx={{ mb: 2 }}>
        {REQUIRED_ENTITY_SCOPES.map(({ entity, actions }) => (
          <Stack key={entity} direction="row" alignItems="center" gap={1} flexWrap="wrap">
            <Typography variant="body2" sx={{ minWidth: 90, fontWeight: 600 }}>
              {entity}
            </Typography>
            {actions.map((a) => (
              <Chip key={a} label={a} size="small" variant="outlined" />
            ))}
          </Stack>
        ))}
      </Stack>

      <Stack direction="row" gap={1} alignItems="flex-start" sx={{ mb: 2 }}>
        <TextField label="Management API Key" placeholder="Paste your Moesif Management API Key" value={token} onChange={(e) => handleTokenChange(e.target.value)} type="password" fullWidth size="small" autoComplete="off" />
        <Button variant="outlined" onClick={handleFetchApps} disabled={!trimmedToken || listApps.isPending} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          {listApps.isPending ? 'Fetching…' : 'Fetch applications'}
        </Button>
      </Stack>

      {/* The application list is populated from the entered key. Only shown
          after a successful fetch so the user selects an application rather
          than pasting its id. */}
      {listApps.isSuccess &&
        (apps.length > 0 ? (
          <TextField select label="Moesif Application" value={moesifAppId} onChange={(e) => setMoesifAppId(e.target.value)} fullWidth size="small" sx={{ mb: 2 }} helperText="Select the Moesif application to link.">
            {apps.map((app) => (
              <MenuItem key={app.id} value={app.id}>
                {app.name} ({app.id})
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Alert severity="warning" sx={{ mb: 2 }}>
            No Moesif applications were found for this Management API Key.
          </Alert>
        ))}

      {!!listApps.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {(listApps.error as Error).message || 'Failed to fetch Moesif applications.'}
        </Alert>
      )}

      {!!error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {(error as Error).message || 'Failed to link the Moesif dashboard.'}
        </Alert>
      )}

      <Stack direction="row" gap={1}>
        {isEdit && onCancel && (
          <Button variant="text" onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
        )}
        <Button variant="contained" disabled={!trimmedToken || !moesifAppId || creating} onClick={() => onCreate(trimmedToken, moesifAppId)}>
          {isEdit ? (creating ? 'Updating…' : 'Update credentials') : creating ? 'Linking…' : 'Link dashboard'}
        </Button>
      </Stack>
    </Stack>
  );
}

export default function MetricsMoesif({ scope, backendSelector, opensearchConfigured }: MetricsPageProps): JSX.Element {
  const isComponent = hasComponent(scope);
  const { data: project, isLoading: loadingProject } = useProjectByHandler(scope.project);
  const projectId = project?.id ?? '';
  const { data: singleComponent, isLoading: loadingComponent } = useComponentByHandler(projectId, isComponent ? scope.component : undefined);
  const { data: components = [], isLoading: loadingComponents } = useComponents(scope.org, projectId);
  const { data: environments = [], isLoading: loadingEnvironments } = useEnvironments(projectId);
  // Moesif metrics are offered for BI (Ballerina) and MI (Micro Integrator)
  // integrations; each has its own runtime setup instructions (see
  // MoesifInstructionsContent).
  const moesifComponents = components.filter((component) => component.componentType === 'BI' || component.componentType === 'MI');

  const [integrationFilter, setIntegrationFilter] = useState('all');
  // When set, the dashboard-credentials edit form is shown for an already-linked
  // integration so the user can update the stored Management API Key + Moesif
  // Application ID (re-linking the dashboard via the backend discovery flow).
  const [editingDashboard, setEditingDashboard] = useState(false);

  const componentId = isComponent ? (singleComponent?.id ?? '') : '';

  // The integration (project + component combo) whose Moesif configuration is
  // being viewed/configured. Component scope targets the single component;
  // project scope targets a Moesif-capable integration chosen via the filter.
  // Re-check the selected ID against the filtered list so a stale or manually
  // supplied unsupported value can never be used for Moesif requests.
  const selectedProjectComponentId = moesifComponents.some((component) => component.id === integrationFilter) ? integrationFilter : '';
  const targetComponentId = isComponent ? componentId : selectedProjectComponentId;

  // The technology of the targeted integration drives which runtime setup
  // instructions are shown (MI uses the Fluent Bit sidecar flow; BI uses the
  // built-in reporter). Resolved from the single component at component scope, or
  // the selected integration at project scope.
  const targetComponent = isComponent ? singleComponent : moesifComponents.find((component) => component.id === targetComponentId);
  const isMI = targetComponent?.componentType === 'MI';

  // Whether this integration's Moesif metrics dashboard has been created/linked.
  // This single flag comes from the backend and drives the setup vs. dashboard
  // views below.
  const { data: moesifConfig, isLoading: loadingMoesifConfig } = useMoesifMetricsConfig(targetComponentId || undefined);
  const createDashboards = useCreateMoesifDashboards();
  const dashboardsCreated = !!moesifConfig?.dashboardsCreated;

  // Once the dashboards exist, mint a short-lived workspace access token and
  // build the iframe embed URL. The hook refetches before the token expires.
  const { data: embed, isLoading: loadingEmbed, isFetching: fetchingEmbed, error: embedError, refetch: refetchEmbed } = useMoesifDashboardEmbed(targetComponentId || undefined, dashboardsCreated);

  const header = (
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
      <Typography variant="h1">Metrics</Typography>
      <Stack direction="row" alignItems="center" gap={1}>
        {/* Only offer the backend toggle when BOTH backends are configured for
            this integration: OpenSearch globally and this integration's Moesif
            dashboard (dashboardsCreated). */}
        {opensearchConfigured && dashboardsCreated && backendSelector}
        {dashboardsCreated && (
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={() => refetchEmbed()} disabled={fetchingEmbed}>
              <RefreshCw size={18} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    </Stack>
  );

  // Early returns
  const loadingContext = isComponent ? loadingComponent : loadingComponents;
  if (loadingProject || loadingContext || loadingEnvironments) {
    return (
      <PageContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </PageContent>
    );
  }
  if (!project) {
    return <NotFound message="Project not found" backTo={resourceUrl(broaden(scope)!, 'overview')} backLabel="Back to Organization" />;
  }
  if (isComponent && !singleComponent) {
    return <NotFound message="Component not found" backTo={resourceUrl(broaden(scope)!, 'overview')} backLabel="Back to Project" />;
  }
  if (environments.length === 0) {
    return (
      <PageContent>
        {header}
        <EmptyListing icon={<BarChart3 size={48} />} title="No environments" description="Configure an environment to view metrics." />
      </PageContent>
    );
  }

  // Project scope: an integration must be selected before we can check or set
  // its Moesif configuration (config is stored per project + integration combo).
  if (!isComponent && !targetComponentId) {
    return (
      <PageContent>
        {header}
        <Card variant="outlined" sx={{ maxWidth: 720, mx: 'auto', mt: 2 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Select an integration
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Moesif metrics are configured per integration. Select an integration to configure or view its metrics.
            </Typography>
            {moesifComponents.length > 0 ? (
              <Select value={integrationFilter} onChange={(e) => setIntegrationFilter(e.target.value as string)} size="small" sx={{ minWidth: 240 }} inputProps={{ 'aria-label': 'Integration' }}>
                <MenuItem value="all">Select an integration…</MenuItem>
                {moesifComponents.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.displayName}
                  </MenuItem>
                ))}
              </Select>
            ) : (
              <EmptyListing icon={<BarChart3 size={48} />} title="No integrations" description="Create a BI or MI integration to configure Moesif metrics." />
            )}
          </CardContent>
        </Card>
      </PageContent>
    );
  }

  // Resolving whether this integration is configured for Moesif metrics.
  if (loadingMoesifConfig) {
    return (
      <PageContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </PageContent>
    );
  }

  // Dashboard not linked yet: show the Moesif intro and the setup flow. The user
  // configures their runtime to publish metrics, imports the dashboard template
  // into Moesif and makes its workspace public; the entered Management API Key +
  // selected Moesif Application ID are then sent to the backend, which discovers
  // the imported workspace id and persists it (setting the `dashboardsCreated`
  // flag). The Collector Application ID itself is not stored. On success the
  // config query is invalidated and the metrics view below is shown.
  if (!dashboardsCreated) {
    return (
      <PageContent>
        {header}
        {/* Neither backend configured for this integration (no OpenSearch and no
            linked Moesif dashboard): explain that observability must be set up
            with either provider before the metrics view is available. */}
        {!opensearchConfigured && (
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            To enable the metrics view you need to setup observability with either Moesif or OpenSearch. Refer the documentation{' '}
            <a href={OPENSEARCH_SETUP_GUIDE_DEFAULT} target="_blank" rel="noreferrer">
              {OPENSEARCH_SETUP_GUIDE_DEFAULT}
            </a>{' '}
            for details.
          </Typography>
        )}
        <Typography variant="h4" sx={{ mt: 5, mb: 3, color: 'warning.main' }}>
          Configure metrics with Moesif
        </Typography>
        <Typography color="text.secondary">
          <strong>Moesif</strong>
          {MOESIF_DESCRIPTION} Refer the documentation{' '}
          <a href={MOESIF_SETUP_GUIDE} target="_blank" rel="noreferrer">
            {MOESIF_SETUP_GUIDE}
          </a>{' '}
          for details.
        </Typography>
        <MoesifDashboardCard
          componentId={targetComponentId}
          isMI={isMI}
          creating={createDashboards.isPending}
          error={createDashboards.error}
          onCreate={(token, moesifAppId) => createDashboards.mutate({ componentId: targetComponentId, managementApiKey: token, moesifAppId })}
        />

        {/* Nothing configured yet (no OpenSearch backend and no Moesif dashboard
            linked): offer OpenSearch as an alternative. The setup guide depends
            on the integration's runtime technology (MI vs. other runtimes). */}
        {!opensearchConfigured && (
          <>
            <Divider sx={{ my: 4 }} />
            <Typography variant="h4" sx={{ mb: 2, color: 'warning.main' }}>
              Configure metrics with OpenSearch
            </Typography>
            <Typography color="text.secondary">
              Follow the guide to setup observability with OpenSearch :{' '}
              <a href={isMI ? OPENSEARCH_SETUP_GUIDE_MI : OPENSEARCH_SETUP_GUIDE_DEFAULT} target="_blank" rel="noreferrer">
                {isMI ? OPENSEARCH_SETUP_GUIDE_MI : OPENSEARCH_SETUP_GUIDE_DEFAULT}
              </a>
            </Typography>
          </>
        )}
      </PageContent>
    );
  }

  // Linked, but the user chose to update the stored Management API Key + Moesif
  // Application ID. Re-links the dashboard via the backend discovery flow
  // (overwriting the stored credentials and workspace id) and, on success,
  // returns to the metrics view with a freshly-minted embed token.
  if (editingDashboard) {
    return (
      <PageContent>
        {header}
        <MoesifDashboardCard
          componentId={targetComponentId}
          isEdit
          isMI={isMI}
          creating={createDashboards.isPending}
          error={createDashboards.error}
          onCancel={() => setEditingDashboard(false)}
          onCreate={(token, moesifAppId) => createDashboards.mutate({ componentId: targetComponentId, managementApiKey: token, moesifAppId }, { onSuccess: () => setEditingDashboard(false) })}
        />
      </PageContent>
    );
  }

  return (
    <PageContent>
      {header}

      {!isComponent && moesifComponents.length > 0 && (
        <Stack direction="row" gap={2} sx={{ mb: 3 }} flexWrap="wrap" alignItems="center">
          <Select value={integrationFilter} onChange={(e) => setIntegrationFilter(e.target.value as string)} size="small" sx={{ minWidth: 160 }} inputProps={{ 'aria-label': 'Integration' }}>
            <MenuItem value="all">Select an integration…</MenuItem>
            {moesifComponents.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.displayName}
              </MenuItem>
            ))}
          </Select>
          <Button variant="outlined" size="small" sx={{ ml: 'auto' }} onClick={() => setEditingDashboard(true)}>
            Edit dashboard credentials
          </Button>
        </Stack>
      )}
      {isComponent && (
        <Stack direction="row" gap={1} sx={{ mb: 3 }} justifyContent="flex-end">
          <Button variant="outlined" size="small" onClick={() => setEditingDashboard(true)}>
            Edit dashboard credentials
          </Button>
        </Stack>
      )}

      {loadingEmbed ? (
        <CircularProgress size={28} sx={{ display: 'block', mx: 'auto', my: 6 }} />
      ) : embedError ? (
        <Stack alignItems="center" gap={2} sx={{ py: 6 }}>
          <Alert
            severity="error"
            sx={{ width: '100%', maxWidth: 720 }}
            action={
              <Button color="inherit" size="small" onClick={() => refetchEmbed()} disabled={fetchingEmbed}>
                Retry
              </Button>
            }>
            {(embedError as Error).message || 'Failed to load the Moesif metrics dashboard.'}
          </Alert>
        </Stack>
      ) : embed ? (
        <iframe
          key={embed.accessToken}
          title="Moesif metrics dashboard"
          src={embed.embedUrl}
          // The embed URL points at the third-party Moesif dashboard and carries
          // a short-lived token, so constrain what the framed content can do:
          // deny top-level navigation and don't leak the tokenized URL via the
          // Referer header.
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer"
          style={{ width: '100%', height: 'calc(100vh - 220px)', minHeight: 600, border: 'none' }}
        />
      ) : (
        <CircularProgress size={28} sx={{ display: 'block', mx: 'auto', my: 6 }} />
      )}
    </PageContent>
  );
}
