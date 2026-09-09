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
import { Accordion, AccordionDetails, AccordionSummary, Alert, Button, CircularProgress, Divider, IconButton, MenuItem, PageContent, Select, Stack, TextField, Tooltip, Typography } from '@wso2/oxygen-ui';
import { BarChart3, ChevronDown, Download, RefreshCw } from '@wso2/oxygen-ui-icons-react';
import { useMemo, useState, type JSX } from 'react';
import { useProjectByHandler, useComponentByHandler, useComponents, useEnvironments, useComponentRuntimes, useComponentRuntimesByEnvironments, useProjectRuntimesByEnvironments, type GqlRuntime } from '../api/queries';
import { useMoesifMetricsConfig, useCreateMoesifDashboards, useMoesifDashboardEmbed } from '../api/metricsMoesif';
import { MI_DEPLOYMENT_TOML_SNIPPET, MI_LOG4J2_SNIPPET, miFluentBitEnv, downloadMoesifMiFluentBitFiles } from '../assets/moesifMiMetrics';
import CodeBoxWithCopy from '../components/CodeBoxWithCopy';
import MoesifCanvas from '../components/MoesifCanvas';
import { runtimeOptionLabel } from '../utils/moesifRuntimeOptions';
import EmptyListing from '../components/EmptyListing';
import NotFound from '../components/NotFound';
import { resourceUrl, broaden, hasComponent } from '../nav';
import type { MetricsPageProps } from './MetricsOpenSearch';

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

// WSO2 MI Moesif metrics setup guide, linked from the MI runtime instructions
// for further guidance (the MI flow enables analytics + a Fluent Bit sidecar).
const MI_MOESIF_METRICS_GUIDE = 'https://mi.docs.wso2.com/en/latest/observe-and-manage/classic-observability-metrics/moesif-metrics/setup/';

// Build the metrics-only Config.toml snippet for publishing metrics to Moesif.
// Based on https://ballerina.io/learn/supported-observability-tools-and-platforms/moesif/
function moesifConfigToml(applicationId: string): string {
  return `[ballerina.observe]
metricsEnabled = true
metricsReporter = "moesif"

[ballerinax.moesif]
applicationId = "${applicationId}"`;
}

// A collapsible step section. Each main step from the observability user story is
// rendered as an accordion so the setup flow stays compact; the first step is
// expanded by default.
function MoesifStep({ title, defaultExpanded, children }: { title: string; defaultExpanded?: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <Accordion defaultExpanded={defaultExpanded} disableGutters sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 1.5, '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ChevronDown size={18} />} sx={{ bgcolor: 'action.hover', '&:hover': { bgcolor: 'action.selected' } }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 2 }}>{children}</AccordionDetails>
    </Accordion>
  );
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
      {isMI ? <MoesifMiRuntimeInstructions applicationId={applicationId} /> : <MoesifBiRuntimeInstructions applicationId={applicationId} />}

      <Alert severity="info" sx={{ mt: 2 }}>
        <strong>Restart the runtime</strong> after applying this configuration for metrics to start flowing.
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
        Add the import to <strong>main.bal</strong>:
      </Typography>
      <CodeBoxWithCopy code={MOESIF_MAIN_BAL_IMPORT} />

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, mt: 2 }}>
        Add the metrics configuration to <strong>Config.toml</strong>, replacing <strong>&lt;MOESIF_COLLECTOR_APPLICATION_ID&gt;</strong> with the <strong>Collector Application ID</strong> from Step 01 before running the runtime:
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
        Moesif. Then, run <strong>`docker compose up -d`</strong> to start Fluent Bit to publish metrics to Moesif.
      </Typography>
      <Button size="small" variant="outlined" startIcon={<Download size={14} />} onClick={() => downloadMoesifMiFluentBitFiles(applicationId)} sx={{ mb: 1, alignSelf: 'flex-start', py: 0.25, px: 1, fontSize: 12 }}>
        Download Fluent Bit config
      </Button>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, mt: 1 }}>
        The generated <strong>.env</strong> looks like this:
      </Typography>
      <CodeBoxWithCopy code={miFluentBitEnv(applicationId)} />

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        For further guidance, refer the{' '}
        <a href={MI_MOESIF_METRICS_GUIDE} target="_blank" rel="noreferrer">
          WSO2 MI Moesif metrics documentation
        </a>
        .
      </Typography>
    </>
  );
}

// Set up the Moesif metrics dashboard for an integration. Renders the runtime
// configuration instructions (so the runtime publishes metrics to Moesif) and
// the steps to import + link the metrics dashboard. The user downloads the ICP
// metrics template, imports it into Moesif (creating the "Application Metrics"
// dashboard and its workspace), then provides the Moesif Management API Key to
// link the metrics canvas. This is sent to the backend and persisted against the
// integration (setting the `dashboardsCreated` flag) so the embed can build the
// canvas URL.
//
// Note: the org id + app id are derived on the backend from the Management API
// Key (a Moesif-issued JWT carrying `org` and `app` claims), and the canvas auth
// token is minted on demand from the same key, so the user only supplies the
// Management API Key here.
//
// When `isEdit` is set the card is in update mode for an already-linked
// dashboard: the user supplies a new Management API Key to re-link (overwriting
// the stored value). An optional Cancel action returns to the metrics view.
function MoesifDashboardCard({ onCreate, creating, error, isEdit, isMI, onCancel }: { onCreate: (managementApiKey: string) => void; creating: boolean; error: unknown; isEdit?: boolean; isMI?: boolean; onCancel?: () => void }): JSX.Element {
  const [managementApiKey, setManagementApiKey] = useState('');

  // The Collector Application ID is derived on the backend from the Management
  // API Key, so it isn't known while filling in this form; show a placeholder in
  // the runtime Config.toml snippet.
  const effectiveAppId = '<MOESIF_COLLECTOR_APPLICATION_ID>';

  const trimmedManagementApiKey = managementApiKey.trim();

  return (
    <Stack sx={{ mt: 2 }}>
      {isEdit && (
        <Typography variant="h6" sx={{ mb: 2 }}>
          Update dashboard credentials
        </Typography>
      )}

      {/* Step 1: prepare Moesif for the environment. */}
      <MoesifStep title="Step 01: Prepare Moesif" defaultExpanded>
        <Typography variant="body2" color="text.secondary">
          Using{' '}
          <a href="https://www.moesif.com/wrap/basic" target="_blank" rel="noreferrer">
            Moesif Basic
          </a>
          , create one application per ICP environment you want to track and copy its <strong>Collector Application ID</strong>.
        </Typography>
      </MoesifStep>

      {/* Step 2: configure the runtime to publish metrics to Moesif. */}
      <MoesifStep title="Step 02: Publish metrics from your runtime">
        <MoesifInstructionsContent applicationId={effectiveAppId} isMI={isMI} />
      </MoesifStep>

      {/* Step 3: link the canvas with a Management API Key. */}
      <MoesifStep title="Step 03: Load the dashboard">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Once metrics are flowing to Moesif, create a <strong>Management API Key</strong> with the <strong>access_tokens: create</strong> and <strong>events: read</strong> scopes, then paste it below to load the metrics dashboard. The Organization ID,
          Application ID and a short-lived canvas token are derived from it. Treated as a secret; never stored in the browser.
        </Typography>

        <TextField label="Management API Key" placeholder="Paste your Moesif Management API Key" value={managementApiKey} onChange={(e) => setManagementApiKey(e.target.value)} type="password" fullWidth size="small" sx={{ mb: 2 }} autoComplete="off" />

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
          <Button variant="contained" disabled={!trimmedManagementApiKey || creating} onClick={() => onCreate(trimmedManagementApiKey)}>
            {isEdit ? (creating ? 'Updating…' : 'Update credentials') : creating ? 'Linking…' : 'Link canvas'}
          </Button>
        </Stack>
      </MoesifStep>
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

  // The technologies present among the project's Moesif-capable integrations, in
  // a stable order. BI and MI publish different metrics and therefore have
  // separate canvas templates, so an "all integrations" view can only aggregate
  // integrations of one technology at a time.
  const technologies = useMemo(() => ['BI', 'MI'].filter((technology) => moesifComponents.some((component) => component.componentType === technology)), [moesifComponents]);

  // Project-scope integration selection. `all:BI` / `all:MI` aggregate every
  // integration of that technology (the canvas is then filtered by the runtime
  // ids of all of them); any other value is a single integration's id. Empty
  // until the user picks, so the default below can follow the technologies that
  // are actually present.
  const [integrationFilter, setIntegrationFilter] = useState('');
  // A Moesif application maps to a specific environment of an integration, so
  // the Moesif configuration is stored per (integration, environment). The
  // environment selector picks which environment's config is viewed/linked;
  // defaults to the first environment until the user chooses one.
  const [envFilter, setEnvFilter] = useState('');
  // When set, the dashboard-credentials edit form is shown for an already-linked
  // integration so the user can update the stored Management API Key + Moesif
  // Application ID (re-linking the dashboard via the backend discovery flow).
  const [editingDashboard, setEditingDashboard] = useState(false);

  const componentId = isComponent ? (singleComponent?.id ?? '') : '';

  // Default to aggregating the first technology present, so project scope opens
  // on data like the OpenSearch views' "All Integrations" default instead of on
  // an integration picker. A stale or unsupported selection falls back to it.
  const defaultIntegrationFilter = technologies.length > 0 ? `all:${technologies[0]}` : '';
  const filterIsKnown = integrationFilter.startsWith('all:') ? technologies.includes(integrationFilter.slice(4)) : moesifComponents.some((component) => component.id === integrationFilter);
  const effectiveIntegrationFilter = filterIsKnown ? integrationFilter : defaultIntegrationFilter;

  // The technology being aggregated at project scope ('' when a single
  // integration is selected or at component scope).
  const aggregateTechnology = !isComponent && effectiveIntegrationFilter.startsWith('all:') ? effectiveIntegrationFilter.slice(4) : '';
  const isAggregate = aggregateTechnology !== '';

  // The integration (project + component combo) whose Moesif configuration is
  // being viewed/configured. Component scope targets the single component;
  // project scope targets a Moesif-capable integration chosen via the filter.
  // Re-check the selected ID against the filtered list so a stale or manually
  // supplied unsupported value can never be used for Moesif requests.
  const selectedProjectComponentId = moesifComponents.some((component) => component.id === effectiveIntegrationFilter) ? effectiveIntegrationFilter : '';

  // In aggregate mode there is no single target integration, but the config,
  // embed and link resolvers all take an integration id to authorize the request
  // against. The stored Moesif credentials are keyed by environment and shared by
  // every integration in it, so any integration of the aggregated technology
  // resolves the same canvas: the first one stands in for the group.
  const aggregateComponentId = isAggregate ? (moesifComponents.find((component) => component.componentType === aggregateTechnology)?.id ?? '') : '';
  const targetComponentId = isComponent ? componentId : selectedProjectComponentId || aggregateComponentId;

  // A Moesif application maps to a specific environment, but an integration is
  // only deployed to (has runtimes in) a subset of the project's environments.
  // It is misleading to offer environments where the integration has no runtime
  // publishing data to Moesif, so the environment selector is filtered to only
  // the environments that have runtimes: this integration's runtimes when one is
  // targeted, or any project runtime of the aggregated technology otherwise.
  const environmentIds = useMemo(() => environments.map((e) => e.id), [environments]);
  const {
    envsWithRuntimes,
    isLoading: loadingComponentRuntimesByEnv,
    isError: componentRuntimesByEnvError,
    refetch: refetchComponentRuntimesByEnv,
  } = useComponentRuntimesByEnvironments(projectId, targetComponentId, environmentIds, !isAggregate && !!targetComponentId);
  const { runtimesByEnv: projectRuntimesByEnv, isLoading: loadingProjectRuntimesByEnv, isError: projectRuntimesByEnvError, refetch: refetchProjectRuntimesByEnv } = useProjectRuntimesByEnvironments(projectId, environmentIds, isAggregate);

  // The aggregated runtimes per environment: every project runtime whose
  // technology matches the canvas template being rendered.
  const aggregateRuntimesByEnv = useMemo(() => {
    if (!isAggregate) return {} as Record<string, GqlRuntime[]>;
    const byEnv: Record<string, GqlRuntime[]> = {};
    for (const [envId, envRuntimes] of Object.entries(projectRuntimesByEnv)) {
      byEnv[envId] = envRuntimes.filter((runtime) => runtime.runtimeType === aggregateTechnology);
    }
    return byEnv;
  }, [isAggregate, projectRuntimesByEnv, aggregateTechnology]);

  const loadingRuntimesByEnv = isAggregate ? loadingProjectRuntimesByEnv : loadingComponentRuntimesByEnv;
  const runtimesByEnvError = isAggregate ? projectRuntimesByEnvError : componentRuntimesByEnvError;
  const refetchRuntimesByEnv = isAggregate ? refetchProjectRuntimesByEnv : refetchComponentRuntimesByEnv;
  const availableEnvironments = environments.filter((e) => (isAggregate ? (aggregateRuntimesByEnv[e.id]?.length ?? 0) > 0 : envsWithRuntimes.has(e.id)));

  // Default to the first environment that has runtimes; ignore a stale/explicit
  // selection that no longer has runtimes so we never load config/dashboards for
  // an environment the integration isn't deployed to.
  const effectiveEnvId = (envFilter && availableEnvironments.some((e) => e.id === envFilter) ? envFilter : availableEnvironments[0]?.id) || '';

  // The technology in view drives which canvas template is rendered and which
  // runtime setup instructions are shown (MI uses the Fluent Bit sidecar flow; BI
  // uses the built-in reporter). Resolved from the single component at component
  // scope, and from the selected integration or aggregated technology at project
  // scope.
  const targetComponent = isComponent ? singleComponent : moesifComponents.find((component) => component.id === targetComponentId);
  const isMI = isAggregate ? aggregateTechnology === 'MI' : targetComponent?.componentType === 'MI';

  // Whether this integration's Moesif metrics dashboard has been created/linked.
  // This single flag comes from the backend and drives the setup vs. dashboard
  // views below.
  const { data: moesifConfig, isLoading: loadingMoesifConfig } = useMoesifMetricsConfig(targetComponentId || undefined, effectiveEnvId || undefined);
  const createDashboards = useCreateMoesifDashboards();
  const dashboardsCreated = !!moesifConfig?.dashboardsCreated;

  // Once the dashboards exist, mint a short-lived workspace access token and
  // build the iframe embed URL. The hook refetches before the token expires.
  const { data: embed, isLoading: loadingEmbed, isFetching: fetchingEmbed, error: embedError, refetch: refetchEmbed } = useMoesifDashboardEmbed(targetComponentId || undefined, effectiveEnvId || undefined, dashboardsCreated);

  // The canvas is scoped to the runtimes in view: their ids are passed to the
  // canvas as the `runtimeId` context filter (see MoesifCanvas CANVAS_INIT) so
  // charts only show metrics tagged with these runtimes. Fetched only once the
  // dashboard is linked and an integration + environment are selected; in
  // aggregate mode the runtimes already come from the per-environment project
  // queries, so no extra request is made.
  const { data: runtimes = [] } = useComponentRuntimes(effectiveEnvId, projectId, targetComponentId, dashboardsCreated && !isAggregate);
  // Runtime filter options for the canvas' `runtimeId` context filter: `value` is
  // the actual runtime id (matched against the metric tag) and `label` names the
  // owning integration alongside the runtime — "integration1 (runtime1)" — in
  // both scopes, so a runtime reads the same whether the list covers one
  // integration or every integration of the aggregated technology.
  const runtimeOptions = useMemo(() => (isAggregate ? (aggregateRuntimesByEnv[effectiveEnvId] ?? []) : runtimes).map((r) => ({ label: runtimeOptionLabel(r), value: r.runtimeId })), [isAggregate, aggregateRuntimesByEnv, effectiveEnvId, runtimes]);

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

  // A Moesif application maps to a specific environment, so the user picks which
  // environment's config is viewed/linked. Placed above the "Metrics" title,
  // shown once an integration is targeted (the config is per integration +
  // environment).
  const envSelector =
    targetComponentId && availableEnvironments.length > 0 ? (
      <Select value={effectiveEnvId} onChange={(e) => setEnvFilter(e.target.value as string)} size="small" sx={{ minWidth: 140 }} inputProps={{ 'aria-label': 'Environment' }}>
        {availableEnvironments.map((e) => (
          <MenuItem key={e.id} value={e.id}>
            {e.name}
          </MenuItem>
        ))}
      </Select>
    ) : null;

  // Project-scope integration selector. Like the OpenSearch metrics view it opens
  // on all integrations rather than forcing a choice; the aggregate entries come
  // first, one per technology present (BI and MI have separate canvas templates,
  // so they cannot be shown together), followed by the individual integrations.
  const integrationSelector =
    !isComponent && moesifComponents.length > 0 ? (
      <Select value={effectiveIntegrationFilter} onChange={(e) => setIntegrationFilter(e.target.value as string)} size="small" sx={{ minWidth: 200 }} inputProps={{ 'aria-label': 'Integration' }}>
        {technologies.map((technology) => (
          <MenuItem key={technology} value={`all:${technology}`}>
            {technologies.length > 1 ? `All ${technology} Integrations` : 'All Integrations'}
          </MenuItem>
        ))}
        {moesifComponents.map((c) => (
          <MenuItem key={c.id} value={c.id}>
            {c.displayName}
          </MenuItem>
        ))}
      </Select>
    ) : null;

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

  // Project scope with nothing Moesif can report on: no integration selection
  // (or aggregate view) is possible until a BI/MI integration exists.
  if (!isComponent && !targetComponentId) {
    return (
      <PageContent>
        {header}
        <EmptyListing icon={<BarChart3 size={48} />} title="No integrations" description="Create a BI or MI integration to configure Moesif metrics." />
      </PageContent>
    );
  }

  // Resolving which environments this integration has runtimes in (to filter the
  // environment selector). Wait for the check before deciding what to render so we
  // don't briefly show a setup/dashboard view for an environment without runtimes.
  if (loadingRuntimesByEnv) {
    return (
      <PageContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </PageContent>
    );
  }

  // A per-environment runtimes request failed. We can't tell whether the
  // integration has runtimes, so surface the error with a retry rather than
  // falling through to the "No runtimes" empty state (which would mask the
  // failure and offer no way to recover).
  if (runtimesByEnvError) {
    return (
      <PageContent>
        {header}
        <Stack alignItems="center" gap={2} sx={{ py: 6 }}>
          <Alert
            severity="error"
            sx={{ width: '100%', maxWidth: 720 }}
            action={
              <Button color="inherit" size="small" onClick={() => refetchRuntimesByEnv()} disabled={loadingRuntimesByEnv}>
                Retry
              </Button>
            }>
            Failed to check which environments have runtimes for this integration.
          </Alert>
        </Stack>
      </PageContent>
    );
  }

  // Nothing in view has runtimes in any environment: there is nothing publishing
  // metrics to Moesif, so we don't offer any environment or load a dashboard.
  // Keep the integration selector (project scope) so another integration or
  // technology can be chosen.
  if (availableEnvironments.length === 0) {
    return (
      <PageContent>
        {header}
        {integrationSelector && (
          <Stack direction="row" gap={2} sx={{ mb: 3 }} flexWrap="wrap" alignItems="center">
            {integrationSelector}
          </Stack>
        )}
        <EmptyListing
          icon={<BarChart3 size={48} />}
          title="No runtimes"
          description={
            isAggregate
              ? `No ${aggregateTechnology} integration in this project has runtimes in any environment. Deploy an integration to a runtime to view its Moesif metrics.`
              : 'This integration has no runtimes in any environment. Deploy the integration to a runtime to view its Moesif metrics.'
          }
        />
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
        {envSelector && (
          <Stack direction="row" sx={{ mt: 2, mb: 4 }}>
            {envSelector}
          </Stack>
        )}
        {header}
        {/* Keep the integration/technology selector available during setup: the
            runtime instructions below are technology-specific (BI vs MI). */}
        {integrationSelector && (
          <Stack direction="row" gap={2} sx={{ mb: 3 }} flexWrap="wrap" alignItems="center">
            {integrationSelector}
          </Stack>
        )}
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
        <MoesifDashboardCard isMI={isMI} creating={createDashboards.isPending} error={createDashboards.error} onCreate={(managementApiKey) => createDashboards.mutate({ componentId: targetComponentId, environmentId: effectiveEnvId, managementApiKey })} />

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
        {envSelector && (
          <Stack direction="row" sx={{ mt: 2, mb: 4 }}>
            {envSelector}
          </Stack>
        )}
        {header}
        <MoesifDashboardCard
          isEdit
          isMI={isMI}
          creating={createDashboards.isPending}
          error={createDashboards.error}
          onCancel={() => setEditingDashboard(false)}
          onCreate={(managementApiKey) => createDashboards.mutate({ componentId: targetComponentId, environmentId: effectiveEnvId, managementApiKey }, { onSuccess: () => setEditingDashboard(false) })}
        />
      </PageContent>
    );
  }

  return (
    <PageContent>
      {envSelector && (
        <Stack direction="row" sx={{ mt: 2, mb: 4 }}>
          {envSelector}
        </Stack>
      )}
      {header}

      {integrationSelector && (
        <Stack direction="row" gap={2} sx={{ mb: 3 }} flexWrap="wrap" alignItems="center">
          {integrationSelector}
          <Button variant="outlined" size="small" sx={{ ml: 'auto' }} onClick={() => setEditingDashboard(true)}>
            Edit dashboard credentials
          </Button>
        </Stack>
      )}
      {isComponent && (
        <Stack direction="row" gap={2} sx={{ mb: 3 }} justifyContent="flex-end">
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
        <MoesifCanvas key={`${effectiveEnvId}:${embed.embedUrl}`} embedUrl={embed.embedUrl} token={embed.token} isMI={isMI} runtimeIds={runtimeOptions} onRefreshToken={() => refetchEmbed()} />
      ) : (
        <CircularProgress size={28} sx={{ display: 'block', mx: 'auto', my: 6 }} />
      )}
    </PageContent>
  );
}
