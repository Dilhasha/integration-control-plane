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

import { Accordion, AccordionDetails, AccordionSummary, Alert, Button, Checkbox, Chip, CircularProgress, FormControlLabel, IconButton, ListItemText, MenuItem, PageContent, Select, Stack, TextField, Tooltip, Typography } from '@wso2/oxygen-ui';
import { ChevronDown, ChevronRight, Copy, Download, RefreshCw, ScrollText, X } from '@wso2/oxygen-ui-icons-react';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Link } from 'react-router';
import { useProjectByHandler, useComponentByHandler, useComponents, useEnvironments, useRuntimes, useComponentRuntimes, useComponentRuntimesByEnvironments } from '../api/queries';
import { useInfiniteLogs, type LogRow, type LogsRequest } from '../api/logs';
import { useMoesifLogsConfig, useCreateMoesifLogsDashboards, useMoesifLogsEmbed } from '../api/logsMoesif';
import { isMoesifEnabled } from '../config/api';
import { downloadMoesifBiLogsFluentBitFiles } from '../assets/moesifBiLogs';
import { getMoesifLogsCanvasTemplate } from '../assets/moesifLogsCanvasTemplate';
import CodeBoxWithCopy from '../components/CodeBoxWithCopy';
import MoesifCanvas from '../components/MoesifCanvas';
import EmptyListing from '../components/EmptyListing';
import NotFound from '../components/NotFound';
import SearchField from '../components/SearchField';
import { resourceUrl, broaden, hasComponent, type ProjectScope, type ComponentScope } from '../nav';

const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'] as const;

// value in hours; 'custom' handled separately
const TIME_PRESETS: { label: string; hours: number }[] = [
  { label: 'Past 10 minutes', hours: 1 / 6 },
  { label: 'Past 30 minutes', hours: 0.5 },
  { label: 'Past 1 hour', hours: 1 },
  { label: 'Past 24 hours', hours: 24 },
  { label: 'Past 7 days', hours: 168 },
  { label: 'Past 30 days', hours: 720 },
];
const DEFAULT_HOURS = 720; // 30 days fallback when filter cleared
const AUTO_FETCH_INTERVAL = 10_000;
const PAGE_SIZE = 500;

const LEVEL_COLORS: Record<string, string> = { ERROR: '#e53935', WARN: '#f9a825', INFO: '#1e88e5', DEBUG: '#78909c' };

// Short description shown when introducing Moesif on the logs setup view. The
// leading "Moesif" is rendered in bold at the call site. Kept in sync with the
// metrics setup wording (see MetricsMoesif).
const MOESIF_DESCRIPTION = ' (a WSO2 company) allows you to observe your service integrations with real-time monitoring, behavioral analytics, and AI-powered insights into API adoption and usage.';

// Documentation guide for setting up Moesif-backed observability, referenced
// from the Moesif intro on the logs setup view.
const MOESIF_SETUP_GUIDE = 'https://wso2.com/integration-platform/docs/manage/icp/observability-setup';

// Documentation guides for setting up OpenSearch-backed observability, offered
// as an alternative. The guide differs by runtime technology: MI (Micro
// Integrator) has its own docs, while other runtimes (BI) use the general ICP
// observability setup guide.
const OPENSEARCH_SETUP_GUIDE_DEFAULT = 'https://wso2.com/integration-platform/docs/manage/icp/observability-setup';
const OPENSEARCH_SETUP_GUIDE_MI = 'https://mi.docs.wso2.com/en/latest/install-and-setup/install/adding-observability-for-icp/';

// BI (Ballerina) log-to-file configuration. The BI application reads logs from
// this file for observability, so the runtime is configured to emit JSON logs to
// a file destination.
const BI_LOG_FILE_CONFIG_TOML = `[ballerina.log]
format = "json"

[[ballerina.log.destinations]]
# Replace /path/to/your/bi/logs with the absolute path to the BI application's log directory
path = "/path/to/your/bi/logs/app.log"`;

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

// Setup instructions shown when no logs observability backend is configured.
// Mirrors the metrics setup structure: Moesif is offered first (when enabled)
// with the main steps from the observability user story rendered as collapsible
// sections, followed by OpenSearch as an alternative. When Moesif is disabled
// only the OpenSearch section is shown.
function LogsSetupInstructions({ isMI, moesifFormSlot }: { isMI?: boolean; moesifFormSlot?: JSX.Element }): JSX.Element {
  const moesifEnabled = isMoesifEnabled();
  const opensearchGuide = isMI ? OPENSEARCH_SETUP_GUIDE_MI : OPENSEARCH_SETUP_GUIDE_DEFAULT;

  return (
    <Stack sx={{ width: '100%', textAlign: 'left' }}>
      {moesifEnabled && (
        <>
          <Typography variant="h4" sx={{ mb: 1, color: 'warning.main' }}>
            Configure logs with Moesif
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            <strong>Moesif</strong>
            {MOESIF_DESCRIPTION}{' '}
            <a href={MOESIF_SETUP_GUIDE} target="_blank" rel="noreferrer">
              View the setup guide
            </a>
            .
          </Typography>

          {/* Step 1: prepare Moesif for the environment. */}
          <MoesifStep title="Step 01: Prepare Moesif" defaultExpanded>
            <Typography variant="body2" color="text.secondary">
              Using{' '}
              <a href="https://www.moesif.com/wrap/basic" target="_blank" rel="noreferrer">
                Moesif Basic
              </a>, create one application per ICP environment you want to track and copy its <strong>Collector Application ID</strong>.
            </Typography>
          </MoesifStep>

          {/* Step 2: configure the runtime to write + publish logs to Moesif. */}
          <MoesifStep title="Step 02: Publish logs from your runtime">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Write JSON logs to a file by adding this to your runtime's <strong>Config.toml</strong>:
            </Typography>
            <CodeBoxWithCopy code={BI_LOG_FILE_CONFIG_TOML} />
            <Alert severity="info" sx={{ mt: 2, mb: 2 }}>
              <strong>Restart the runtime</strong> after applying this configuration.
            </Alert>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Download the Fluent Bit bundle, set the Collector Application ID, service name, environment and BI log directory in <strong>.env</strong>, then run <strong>docker compose up -d</strong>. On Windows, use a Windows-style path and enable the drive under Docker Desktop file sharing.
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<Download size={14} />}
              onClick={() => downloadMoesifBiLogsFluentBitFiles('<MOESIF_COLLECTOR_APPLICATION_ID>')}
              sx={{ mt: 1, alignSelf: 'flex-start', py: 0.25, px: 1, fontSize: 12 }}>
              Download Fluent Bit config
            </Button>
          </MoesifStep>

          {/* Step 3: link the canvas with a Management API Key (rendered only when
              an integration + environment are resolved so the mutation has a target). */}
          {moesifFormSlot && <MoesifStep title="Step 03: Load the dashboard">{moesifFormSlot}</MoesifStep>}
        </>
      )}

      <Typography variant="h4" sx={{ mt: moesifEnabled ? 4 : 0, mb: 2, color: 'warning.main' }}>
        Configure logs with OpenSearch
      </Typography>
      <Typography color="text.secondary">
        Follow the guide to setup observability with OpenSearch :{' '}
        <a href={opensearchGuide} target="_blank" rel="noreferrer">
          {opensearchGuide}
        </a>
      </Typography>
    </Stack>
  );
}

// Credential form to link an integration's Moesif logs canvas. Mirrors the
// metrics MoesifDashboardCard: the user supplies a Moesif Management API Key
// (a JWT the backend derives the org + app ids from), then the backend persists
// the shared canvas credentials and flips the `logsConfigured` flag. The canvas
// auth token is minted on demand by the backend from this key, so no separate
// canvas token is entered here. The Management API Key is treated as a secret.
function MoesifLogsCredentialForm({ onCreate, creating, error }: { onCreate: (managementApiKey: string) => void; creating: boolean; error: unknown }): JSX.Element {
  const [managementApiKey, setManagementApiKey] = useState('');
  const trimmedManagementApiKey = managementApiKey.trim();

  return (
    <Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Once logs are flowing to Moesif, create a <strong>Management API Key</strong> with the <strong>access_tokens: create</strong> and <strong>events: read</strong> scopes, then paste it below to load the logs dashboard. The Organization ID, Application ID and a short-lived canvas token are derived from it. Treated as a secret; never stored in the browser.
      </Typography>
      <Stack sx={{ maxWidth: 640 }}>
        <TextField
          label="Management API Key"
          placeholder="Paste your Moesif Management API Key"
          value={managementApiKey}
          onChange={(e) => setManagementApiKey(e.target.value)}
          type="password"
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          autoComplete="off"
        />
        {!!error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {(error as Error).message || 'Failed to link the Moesif logs canvas.'}
          </Alert>
        )}
        <Button variant="contained" sx={{ alignSelf: 'flex-start' }} disabled={!trimmedManagementApiKey || creating} onClick={() => onCreate(trimmedManagementApiKey)}>
          {creating ? 'Linking…' : 'Link canvas'}
        </Button>
      </Stack>
    </Stack>
  );
}

// Renders the embedded Moesif logs canvas for a linked integration. Fetches the
// canvas embed URL + auth token from the backend and drives the same iframe
// postMessage handshake as the metrics canvas, but posts the application logs
// canvas template (getMoesifLogsCanvasTemplate) instead of the metrics one. The
// canvas is scoped to this integration's runtimes via the `runtimeId` context
// filter. An Edit action lets the user re-link with new credentials.
function MoesifLogsCanvasView({
  componentId,
  environmentId,
  projectId,
  isMI,
  onEdit,
}: {
  componentId: string;
  environmentId: string;
  projectId: string;
  isMI: boolean;
  onEdit: () => void;
}): JSX.Element {
  const { data: embed, isLoading: loadingEmbed, isFetching: fetchingEmbed, error: embedError, refetch: refetchEmbed } = useMoesifLogsEmbed(componentId || undefined, environmentId || undefined, true);
  const { data: runtimes = [] } = useComponentRuntimes(environmentId, projectId, componentId, true);
  const runtimeOptions = useMemo(() => runtimes.map((r) => ({ label: r.runtimeName ?? r.runtimeId, value: r.runtimeId })), [runtimes]);
  const logsTemplate = useMemo(() => getMoesifLogsCanvasTemplate(), []);

  return (
    <Stack sx={{ width: '100%' }}>
      <Stack direction="row" gap={2} sx={{ mb: 2 }} justifyContent="flex-end" alignItems="center">
        <Tooltip title="Refresh">
          <span>
            <IconButton size="small" aria-label="Refresh logs canvas" onClick={() => refetchEmbed()} disabled={fetchingEmbed}>
              <RefreshCw size={18} />
            </IconButton>
          </span>
        </Tooltip>
        <Button variant="outlined" size="small" onClick={onEdit}>
          Edit canvas credentials
        </Button>
      </Stack>
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
            {(embedError as Error).message || 'Failed to load the Moesif logs dashboard.'}
          </Alert>
        </Stack>
      ) : embed ? (
        <MoesifCanvas key={`${environmentId}:${embed.embedUrl}`} embedUrl={embed.embedUrl} token={embed.token} isMI={isMI} runtimeIds={runtimeOptions} onRefreshToken={() => refetchEmbed()} template={logsTemplate} />
      ) : (
        <CircularProgress size={28} sx={{ display: 'block', mx: 'auto', my: 6 }} />
      )}
    </Stack>
  );
}

// Moesif logs experience for the "observability unavailable" state of the logs
// view. Reads whether the integration's Moesif logs canvas is linked and either
// (a) shows the embedded logs canvas, or (b) shows the logs setup instructions
// with the credential form. Falls back to the plain instructions (no form) when
// an integration/environment isn't resolved or Moesif is disabled.
function MoesifLogsSection({
  componentId,
  environmentId,
  projectId,
  isMI,
}: {
  componentId: string | undefined;
  environmentId: string | undefined;
  projectId: string;
  isMI: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const moesifEnabled = isMoesifEnabled();
  const canQuery = moesifEnabled && !!componentId && !!environmentId;
  const { data: logsConfig, isLoading: loadingConfig } = useMoesifLogsConfig(canQuery ? componentId : undefined, canQuery ? environmentId : undefined);
  const createLogs = useCreateMoesifLogsDashboards();
  const logsConfigured = !!logsConfig?.logsConfigured;

  // The credential form is wired whenever we have a concrete target
  // (integration + environment) for the mutation, independent of the config
  // query state. This keeps step 4 visible while the config is still loading
  // and when Moesif is enabled but the integration is not yet linked.
  const formSlot =
    moesifEnabled && componentId && environmentId ? (
      <MoesifLogsCredentialForm
        creating={createLogs.isPending}
        error={createLogs.error}
        onCreate={(managementApiKey) => createLogs.mutate({ componentId, environmentId, managementApiKey })}
      />
    ) : undefined;

  // Resolving the logs config: show the instructions (with the credential form
  // when a target is available) while it loads so the page isn't blank and
  // step 4 doesn't disappear (the config only gates the embedded-canvas vs.
  // form choice).
  if (canQuery && loadingConfig) {
    return <LogsSetupInstructions isMI={isMI} moesifFormSlot={formSlot} />;
  }

  // Linked, but the user chose to re-link with new credentials.
  if (logsConfigured && editing && componentId && environmentId) {
    return (
      <Stack sx={{ width: '100%', textAlign: 'left' }}>
        <Typography variant="h4" sx={{ mb: 2, color: 'warning.main' }}>
          Update logs canvas credentials
        </Typography>
        <MoesifLogsCredentialForm
          creating={createLogs.isPending}
          error={createLogs.error}
          onCreate={(managementApiKey) => createLogs.mutate({ componentId, environmentId, managementApiKey }, { onSuccess: () => setEditing(false) })}
        />
        <Button variant="text" sx={{ alignSelf: 'flex-start', mt: 1 }} onClick={() => setEditing(false)} disabled={createLogs.isPending}>
          Cancel
        </Button>
      </Stack>
    );
  }

  // Linked: render the embedded logs canvas.
  if (logsConfigured && componentId && environmentId) {
    return <MoesifLogsCanvasView componentId={componentId} environmentId={environmentId} projectId={projectId} isMI={isMI} onEdit={() => setEditing(true)} />;
  }

  // Not linked (or no target resolved): show the setup instructions, with the
  // credential form embedded when a target is available.
  return <LogsSetupInstructions isMI={isMI} moesifFormSlot={formSlot} />;
}

const DISPLAY_FIELDS: { key: keyof LogRow; label: string }[] = [
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'level', label: 'Log Level' },
  { key: 'logLine', label: 'Log Entry' },
  { key: 'class', label: 'Class' },
  { key: 'logFilePath', label: 'Log File Path' },
  { key: 'appName', label: 'App Name' },
  { key: 'module', label: 'Module' },
  { key: 'serviceType', label: 'Service Type' },
  { key: 'app', label: 'App' },
  { key: 'deployment', label: 'Deployment' },
  { key: 'artifactContainer', label: 'Artifact Container' },
  { key: 'product', label: 'Product' },
  { key: 'icpRuntimeId', label: 'Runtime ID' },
  { key: 'logAttributes', label: 'Log Attributes' },
  { key: 'componentVersion', label: 'Component Version' },
  { key: 'componentVersionId', label: 'Component Version ID' },
  { key: 'error', label: 'Error' },
];

function levelColor(level: string): string {
  return LEVEL_COLORS[level] ?? '#78909c';
}

function formatValue(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function copyLog(log: LogRow) {
  const text = `${new Date(log.timestamp).toLocaleString()} [${log.level}] ${log.logLine}`;
  navigator.clipboard.writeText(text);
}

function downloadLogs(logs: LogRow[]) {
  const text = logs.map((l) => `${new Date(l.timestamp).toLocaleString()} [${l.level}] ${l.logLine}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Convert a Date to a datetime-local input value (YYYY-MM-DDTHH:MM) */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isUnavailable(error: unknown): boolean {
  if (!error) return false;
  const status = (error as any).status;
  const message = (error as Error).message ?? '';
  return status === 503 || message.includes('Observability service is unavailable') || message.includes('OpenSearch service is unavailable');
}

function LogEntry({ log, expanded, onToggle }: { log: LogRow; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <Stack
        direction="row"
        alignItems="center"
        onClick={onToggle}
        sx={{
          fontFamily: 'monospace',
          fontSize: 12,
          px: 0.5,
          py: 0.25,
          cursor: 'pointer',
          borderRadius: 1,
          minHeight: 32,
          '&:hover': { bgcolor: 'action.hover' },
          '&:hover .log-actions': { visibility: 'visible' },
        }}>
        <IconButton size="small" aria-label={expanded ? 'Collapse log entry' : 'Expand log entry'} sx={{ p: 0, mr: 0.5 }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </IconButton>
        <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12, color: levelColor(log.level), whiteSpace: 'nowrap', mr: 1 }}>
          {new Date(log.timestamp).toLocaleString()}
        </Typography>
        <Chip label={log.level} size="small" sx={{ fontFamily: 'monospace', fontSize: 10, height: 18, mr: 1, bgcolor: levelColor(log.level), color: '#fff', fontWeight: 700 }} />
        {log.serviceType && (
          <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap', mr: 1 }}>
            {log.serviceType}
          </Typography>
        )}
        <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {log.logLine}
        </Typography>
        <Stack direction="row" className="log-actions" sx={{ visibility: 'hidden', ml: 1, flexShrink: 0 }}>
          <Tooltip title="Copy">
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                copyLog(log);
              }}>
              <Copy size={14} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
      {expanded && (
        <Stack sx={{ pl: 5, pb: 1, fontFamily: 'monospace', fontSize: 12, bgcolor: 'background.default', borderRadius: 1, mx: 0.5, mb: 0.5 }}>
          {DISPLAY_FIELDS.map(({ key, label }) => {
            const val = formatValue(log[key]);
            if (!val) return null;
            return (
              <Stack key={key} direction="row" sx={{ borderBottom: '1px solid', borderColor: 'divider', py: 0.5, gap: 2 }}>
                <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, minWidth: 160, flexShrink: 0 }}>
                  {label}
                </Typography>
                <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {key === 'timestamp' ? new Date(val).toLocaleString() : val}
                </Typography>
              </Stack>
            );
          })}
        </Stack>
      )}
    </>
  );
}

export default function RuntimeLogs(scope: ProjectScope | ComponentScope): JSX.Element {
  const { data: project, isLoading: loadingProject } = useProjectByHandler(scope.project);
  const projectId = project?.id ?? '';
  const { data: singleComponent, isLoading: loadingComponent } = useComponentByHandler(projectId, hasComponent(scope) ? scope.component : undefined);
  const { data: allComponents = [], isLoading: loadingComponents } = useComponents(scope.org, projectId);
  const { data: environments = [], isLoading: loadingEnvironments } = useEnvironments(projectId);

  const allComponentIds = hasComponent(scope) ? (singleComponent ? [singleComponent.id] : []) : allComponents.map((c) => c.id);

  const [integrationFilter, setIntegrationFilter] = useState('all');
  const [envFilter, setEnvFilter] = useState<string[]>([]);
  const [levelFilter, setLevelFilter] = useState<string[]>([]);
  const [timePreset, setTimePreset] = useState<string>('Past 24 hours');
  const [customStart, setCustomStart] = useState(() => toLocalInput(new Date(Date.now() - 24 * 3600_000)));
  const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()));
  const [searchPhrase, setSearchPhrase] = useState('');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [autoFetch, setAutoFetch] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const componentIds = !hasComponent(scope) && integrationFilter !== 'all' ? [integrationFilter] : allComponentIds;

  // Only offer environments where the targeted integration actually has runtimes,
  // matching the metrics view: it is misleading to query logs (or load the Moesif
  // logs canvas) for an environment the integration isn't deployed to. This
  // filtering applies when a specific integration is targeted (component scope or
  // a chosen integration); the aggregate "All Integrations" view keeps all
  // environments since runtimes may span several integrations.
  const runtimeCheckComponentId = hasComponent(scope) ? (singleComponent?.id ?? '') : integrationFilter !== 'all' ? integrationFilter : '';
  const environmentIds = useMemo(() => environments.map((e) => e.id), [environments]);
  const { envsWithRuntimes } = useComponentRuntimesByEnvironments(projectId, runtimeCheckComponentId, environmentIds, !!runtimeCheckComponentId);
  const availableEnvironments = runtimeCheckComponentId ? environments.filter((e) => envsWithRuntimes.has(e.id)) : environments;
  const availableEnvIds = availableEnvironments.map((e) => e.id);

  // Drop any selected environments that are no longer available (e.g. after
  // switching to an integration that isn't deployed to them) so requests never
  // target an environment without runtimes.
  const effectiveEnvFilter = envFilter.filter((id) => availableEnvIds.includes(id));

  // Calculate selected environments for request logic
  const selectedEnvIds = effectiveEnvFilter.length > 0 ? effectiveEnvFilter : availableEnvIds;
  const selectedEnvs = environments.filter((e) => selectedEnvIds.includes(e.id));
  const primaryEnv = selectedEnvs[0];

  // Derive selected component id from current selection (matching runtimeLinkComponent logic)
  const selectedComponentId = useMemo(() => {
    const isComponentScope = hasComponent(scope);
    if (isComponentScope) return singleComponent?.id ?? '';
    if (integrationFilter !== 'all') return integrationFilter;
    return allComponentIds[0] ?? '';
  }, [scope, singleComponent, integrationFilter, allComponentIds]);

  // Derive selected environment id from current selection (matching request logic)
  const selectedEnvId = (effectiveEnvFilter.length > 0 ? effectiveEnvFilter[0] : primaryEnv?.id) ?? '';

  // Fetch runtimes to check if they are MI type (for per-runtime log download link)
  const { data: runtimes = [] } = useRuntimes(selectedEnvId, projectId, selectedComponentId);
  const hasMIRuntimes = useMemo(() => runtimes.some((r) => r.runtimeType === 'MI'), [runtimes]);

  // Determine which component to link to for per-runtime logs
  const runtimeLinkComponent = useMemo(() => {
    const isComponentScope = hasComponent(scope);
    if (isComponentScope) return singleComponent;
    if (integrationFilter !== 'all') {
      return allComponents.find((c) => c.id === integrationFilter);
    }
    return undefined;
  }, [scope, singleComponent, integrationFilter, allComponents]);
  const componentIdsKey = componentIds.join(',');
  const envIdsKey = selectedEnvIds.join(',');
  const levelFilterKey = levelFilter.join(',');

  const logsRequest = useMemo<LogsRequest | null>(() => {
    if (componentIds.length === 0 || !primaryEnv) return null;
    let startTime: string;
    let endTime: string;
    if (timePreset === 'custom') {
      startTime = new Date(customStart).toISOString();
      endTime = new Date(customEnd).toISOString();
    } else {
      const preset = TIME_PRESETS.find((p) => p.label === timePreset);
      const hours = preset?.hours ?? DEFAULT_HOURS;
      const now = new Date();
      startTime = new Date(now.getTime() - hours * 3600_000).toISOString();
      endTime = now.toISOString();
    }
    return {
      componentIdList: componentIds,
      environmentId: primaryEnv.id,
      environmentList: selectedEnvIds,
      logLevels: levelFilter,
      startTime,
      endTime,
      limit: PAGE_SIZE,
      sort: sortDir,
      region: 'US',
      searchPhrase,
    };
    // componentIdsKey / envIdsKey / levelFilterKey stabilize array refs (new array every render)
  }, [componentIdsKey, envIdsKey, levelFilterKey, timePreset, customStart, customEnd, searchPhrase, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute fresh startTime/endTime on every call so auto-fetch and manual refresh always
  // query the correct window relative to the current clock, not the stale memoized timestamps.
  const getTimeRange = useCallback(() => {
    if (timePreset === 'custom') {
      return { startTime: new Date(customStart).toISOString(), endTime: new Date(customEnd).toISOString() };
    }
    const preset = TIME_PRESETS.find((p) => p.label === timePreset);
    const hours = preset?.hours ?? DEFAULT_HOURS;
    const now = new Date();
    return { startTime: new Date(now.getTime() - hours * 3600_000).toISOString(), endTime: now.toISOString() };
  }, [timePreset, customStart, customEnd]);

  const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteLogs(logsRequest, autoFetch ? AUTO_FETCH_INTERVAL : false, getTimeRange);

  // Disable auto-fetch when observability service is unavailable
  useEffect(() => {
    if (isUnavailable(error)) {
      setAutoFetch(false);
    }
  }, [error]);

  const logs = useMemo(() => data?.pages.flat() ?? [], [data]);
  const filtersDisabled = isUnavailable(error);

  const filteredLogs = logs;

  const toggle = (i: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  // Infinite scroll: observe the sentinel at the bottom of the list
  const sentinelRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    const el = sentinelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight + 200) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const loadingContext = hasComponent(scope) ? loadingComponent : loadingComponents;
  if (loadingProject || loadingContext || loadingEnvironments) {
    return (
      <PageContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </PageContent>
    );
  }
  if (hasComponent(scope) && !singleComponent) {
    return <NotFound message="Component not found" backTo={resourceUrl(broaden(scope)!, 'overview')} backLabel="Back to Project" />;
  }
  if (!hasComponent(scope) && allComponents.length === 0) {
    return (
      <PageContent>
        <EmptyListing icon={<ScrollText size={48} />} title="No components" description="Add a component to view runtime logs." />
      </PageContent>
    );
  }
  if (componentIds.length > 0 && environments.length === 0) {
    return (
      <PageContent>
        <EmptyListing icon={<ScrollText size={48} />} title="No environments" description="Configure an environment to view runtime logs." />
      </PageContent>
    );
  }

  return (
    <PageContent>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h1">Runtime Logs</Typography>
        {!hasComponent(scope) && (
          <Select value={integrationFilter} onChange={(e) => setIntegrationFilter(e.target.value as string)} size="small" sx={{ minWidth: 200 }} inputProps={{ 'aria-label': 'Integration' }} disabled={filtersDisabled}>
            <MenuItem value="all">All Integrations</MenuItem>
            {allComponents.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.displayName || c.name}
              </MenuItem>
            ))}
          </Select>
        )}
      </Stack>

      {filtersDisabled && (
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          To enable the logs view you need to setup observability with either Moesif or OpenSearch. Refer the documentation{' '}
          <a href={OPENSEARCH_SETUP_GUIDE_DEFAULT} target="_blank" rel="noreferrer">
            {OPENSEARCH_SETUP_GUIDE_DEFAULT}
          </a>{' '}
          for details.
        </Typography>
      )}

      {!filtersDisabled && (
        <Stack direction="row" gap={1.5} sx={{ mb: 1 }} flexWrap="wrap" alignItems="center">
          {availableEnvironments.length > 0 && (
            <Select
              multiple
              value={effectiveEnvFilter}
              onChange={(e) => setEnvFilter(e.target.value as string[])}
              displayEmpty
              renderValue={(selected) => {
                const sel = selected as string[];
                if (sel.length === 0) return 'All Environments';
                return availableEnvironments
                  .filter((env) => sel.includes(env.id))
                  .map((env) => env.name)
                  .join(', ');
              }}
              size="small"
              sx={{ minWidth: 160 }}
              inputProps={{ 'aria-label': 'Environment' }}
              disabled={filtersDisabled}>
              {availableEnvironments.map((e) => (
                <MenuItem key={e.id} value={e.id}>
                  <Checkbox checked={effectiveEnvFilter.includes(e.id)} size="small" sx={{ p: 0, mr: 1 }} />
                  <ListItemText primary={e.name} />
                </MenuItem>
              ))}
            </Select>
          )}

          <Select
            multiple
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as string[])}
            displayEmpty
            renderValue={(selected) => {
              const sel = selected as string[];
              if (sel.length === 0) return 'All Levels';
              return sel.join(', ');
            }}
            size="small"
            sx={{ minWidth: 120 }}
            inputProps={{ 'aria-label': 'Log level' }}
            disabled={filtersDisabled}>
            {LOG_LEVELS.map((l) => (
              <MenuItem key={l} value={l}>
                <Checkbox checked={levelFilter.includes(l)} size="small" sx={{ p: 0, mr: 1 }} />
                <ListItemText primary={l} />
              </MenuItem>
            ))}
          </Select>

          <Stack direction="row" alignItems="center" gap={0.5}>
            <Select
              value={timePreset}
              onChange={(e) => {
                const v = e.target.value as string;
                setTimePreset(v);
                if (v === 'custom') {
                  setCustomEnd(toLocalInput(new Date()));
                  setCustomStart(toLocalInput(new Date(Date.now() - 24 * 3600_000)));
                }
              }}
              size="small"
              sx={{ minWidth: 160 }}
              inputProps={{ 'aria-label': 'Time range' }}
              disabled={filtersDisabled}>
              {TIME_PRESETS.map((p) => (
                <MenuItem key={p.label} value={p.label}>
                  {p.label}
                </MenuItem>
              ))}
              <MenuItem value="custom">Custom</MenuItem>
            </Select>
            {timePreset !== '' && (
              <Tooltip title="Clear time filter (defaults to 30 days)">
                <IconButton size="small" onClick={() => setTimePreset('')} disabled={filtersDisabled}>
                  <X size={14} />
                </IconButton>
              </Tooltip>
            )}
          </Stack>

          <Select value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')} size="small" sx={{ minWidth: 120 }} inputProps={{ 'aria-label': 'Sort direction' }} disabled={filtersDisabled}>
            <MenuItem value="desc">Newest first</MenuItem>
            <MenuItem value="asc">Oldest first</MenuItem>
          </Select>

          <SearchField value={searchPhrase} onChange={setSearchPhrase} placeholder="Search logs..." sx={{ minWidth: 200, flex: 1 }} disabled={filtersDisabled} />

          <FormControlLabel control={<Checkbox checked={autoFetch} onChange={(_, c) => setAutoFetch(c)} size="small" disabled={filtersDisabled} />} label="Auto Fetch" sx={{ mr: 0, whiteSpace: 'nowrap' }} slotProps={{ typography: { variant: 'body2' } }} />
          <Tooltip title="Download logs">
            <IconButton size="small" aria-label="Download logs" onClick={() => downloadLogs(filteredLogs)} disabled={filtersDisabled || filteredLogs.length === 0}>
              <Download size={18} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh">
            <span>
              <IconButton size="small" aria-label="Refresh" onClick={() => refetch()} disabled={filtersDisabled || !logsRequest}>
                <RefreshCw size={16} />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      )}

      {!filtersDisabled && timePreset === 'custom' && (
        <Stack direction="row" gap={1.5} sx={{ mb: 2 }} alignItems="center">
          <TextField type="datetime-local" size="small" label="Start" value={customStart} onChange={(e) => setCustomStart(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} disabled={filtersDisabled} />
          <TextField type="datetime-local" size="small" label="End" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} disabled={filtersDisabled} />
          <Button variant="contained" size="small" onClick={() => refetch()} disabled={filtersDisabled}>
            Apply
          </Button>
        </Stack>
      )}

      {filteredLogs.length > 0 && !isLoading && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, textAlign: 'right' }}>
          {filteredLogs.length} {filteredLogs.length === 1 ? 'entry' : 'entries'} loaded{hasNextPage ? ' — scroll or click "Load more" for additional results' : ''}
        </Typography>
      )}

      {isLoading ? (
        <CircularProgress size={28} sx={{ display: 'block', mx: 'auto', my: 6 }} />
      ) : error ? (
        isUnavailable(error) ? (
          <Stack gap={2} sx={{ py: 6, width: '100%' }}>
            {hasMIRuntimes && runtimeLinkComponent?.handler && (
              <Typography color="text.secondary">
                You can still download{' '}
                <Link
                  to={hasComponent(scope) ? resourceUrl(scope, 'runtimes') : resourceUrl({ level: 'components', org: scope.org, project: scope.project, component: runtimeLinkComponent.handler }, 'runtimes')}
                  style={{ textDecoration: 'underline', cursor: 'pointer' }}>
                  per-runtime logs
                </Link>
                .
              </Typography>
            )}
            <MoesifLogsSection componentId={selectedComponentId || undefined} environmentId={selectedEnvId || undefined} projectId={projectId} isMI={hasMIRuntimes} />
          </Stack>
        ) : (
          <Stack alignItems="center" gap={2} sx={{ py: 6 }}>
            <Typography color="error" textAlign="center">
              Failed to fetch logs: {(error as Error).message ?? 'Service unavailable'}
            </Typography>
            <Button variant="contained" startIcon={<RefreshCw size={16} />} onClick={() => refetch()}>
              Retry
            </Button>
          </Stack>
        )
      ) : filteredLogs.length === 0 ? (
        <EmptyListing icon={<ScrollText size={48} />} title="No logs found" description="Try a different time range or filters." />
      ) : (
        <Stack ref={scrollContainerRef} sx={{ bgcolor: 'background.paper', borderRadius: 1, border: '1px solid', borderColor: 'divider', overflow: 'auto', maxHeight: 'calc(100vh - 300px)' }}>
          {filteredLogs.map((log, i) => (
            <LogEntry key={i} log={log} expanded={expanded.has(i)} onToggle={() => toggle(i)} />
          ))}
          <div ref={sentinelRef} />
          {isFetchingNextPage && <CircularProgress size={20} sx={{ display: 'block', mx: 'auto', my: 1 }} />}
          {hasNextPage && !isFetchingNextPage && (
            <Button variant="text" size="small" onClick={() => fetchNextPage()} sx={{ display: 'block', mx: 'auto', my: 1 }}>
              Load more
            </Button>
          )}
          {!hasNextPage && filteredLogs.length > 0 && (
            <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ py: 1 }}>
              Showing {filteredLogs.length} log {filteredLogs.length === 1 ? 'entry' : 'entries'}
            </Typography>
          )}
        </Stack>
      )}
    </PageContent>
  );
}
