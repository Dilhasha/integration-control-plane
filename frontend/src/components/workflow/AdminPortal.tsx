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

import { Alert, Autocomplete, Box, Button, Card, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, ListingTable, MenuItem, Select, Snackbar, Stack, TextField, Tooltip, Typography } from '@wso2/oxygen-ui';
import { Copy, Eye, Play, RefreshCw } from '@wso2/oxygen-ui-icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { resourceUrl, useScope } from '../../nav';
import SearchField from '../SearchField';
import SchemaFormFields from './SchemaFormFields';
import WorkflowDetailDrawer from './WorkflowDetailDrawer';
import { buildFormResult, formatTime, formValuesFromObject, gatewayScope, ownerLabel, ownerScope, parseFormSchema, sectionTitleSx, sortByStartTimeDesc, splitQualifiedName, type PortalScope } from './helpers';
import { DetailRow, SchemaDisclosure, StatusChip, SubmitError, WorkflowIdLink, type WorkflowScope } from './shared';
import Authorized from '../Authorized';
import { Permissions } from '../../constants/permissions';
import {
  distinctWorkflowTypes,
  useReviewActivities,
  useReviewActivity,
  useReviewDecision,
  useStartWorkflow,
  useWorkflowDefinitionsAcross,
  useWorkflowInstances,
  type Owned,
  type ReviewDecision,
  type WorkflowDefinition,
  type WorkflowTarget,
} from '../../api/workflows';

const WORKFLOW_STATUSES = ['All', 'RUNNING', 'COMPLETED', 'FAILED', 'TERMINATED', 'CANCELED', 'TIMED_OUT'];
// Rejecting a review activity completes it (there is no REJECTED status).
const REVIEW_ACTIVITY_STATUSES = ['All', 'PENDING', 'COMPLETED', 'CANCELED', 'TERMINATED'];
const emptySx = { py: 4, textAlign: 'center', color: 'text.secondary' } as const;

const statusLabel = (s: string) => (s === 'All' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' '));

/** Converts a `datetime-local` input value to an ISO-8601 string, or undefined when empty/invalid. */
const localToIso = (v: string): string | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Formats a Date as a `datetime-local` input value (YYYY-MM-DDTHH:MM). */
const toLocalInput = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const ANY_TIME = 'Any time';
const CUSTOM_RANGE = 'Custom';
// Relative presets for the time-range dropdown (window length in milliseconds).
const TIME_PRESETS: { label: string; ms: number }[] = [
  { label: 'Past 10 minutes', ms: 10 * 60_000 },
  { label: 'Past 30 minutes', ms: 30 * 60_000 },
  { label: 'Past 1 hour', ms: 60 * 60_000 },
  { label: 'Past 24 hours', ms: 24 * 60 * 60_000 },
];

export type Toast = { severity: 'success' | 'error'; message: string } | null;

export type { PortalScope };

/** Integration filter, offered only when the portal spans more than one. */
function IntegrationFilter({ targets, value, onChange }: { targets: WorkflowTarget[]; value: WorkflowTarget | null; onChange: (v: WorkflowTarget | null) => void }) {
  return (
    <Autocomplete
      size="small"
      sx={{ width: 240 }}
      options={targets}
      value={value}
      getOptionLabel={(t) => t.componentName}
      isOptionEqualToValue={(a, b) => a.componentId === b.componentId}
      onChange={(_, v) => onChange(v)}
      renderInput={(params) => <TextField {...params} label="Integration" placeholder="All integrations" />}
    />
  );
}

/**
 * Warns that some integrations did not return their workflow definitions, so the workflow names on
 * offer — for filtering and for starting — may be short a few. Listing rows are unaffected: they
 * come from one runtime that answers for the whole project. Integrations with no workflow runtime
 * are not failures and never appear here.
 */
function DefinitionsUnavailableNotice({ failed }: { failed: { componentName: string; message: string }[] }) {
  if (failed.length === 0) return null;
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      {`Could not load workflow definitions from ${failed.map((f) => f.componentName).join(', ')}; some workflow names may be missing.`}
    </Alert>
  );
}

// ── Shared filter controls (used by the Workflows and Review Activities views) ─────

export function StatusFilter({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return <Autocomplete size="small" sx={{ width: 180 }} options={options} value={value} disableClearable getOptionLabel={statusLabel} onChange={(_, v) => onChange(v ?? 'All')} renderInput={(params) => <TextField {...params} label="Status" />} />;
}

function WorkflowNameFilter({ definitions, value, onChange }: { definitions: WorkflowDefinition[]; value: WorkflowDefinition | null; onChange: (v: WorkflowDefinition | null) => void }) {
  return (
    <Autocomplete
      size="small"
      sx={{ width: 240 }}
      options={definitions}
      value={value}
      getOptionLabel={(d) => d.workflowType}
      isOptionEqualToValue={(a, b) => a.workflowType === b.workflowType}
      onChange={(_, v) => onChange(v)}
      renderInput={(params) => <TextField {...params} label="Workflow name" placeholder="All workflows" />}
    />
  );
}

/** Owns the time-range dropdown (relative presets + custom bounds) and resolves it to ISO bounds. */
function useTimeRangeFilter() {
  const [timeRange, setTimeRange] = useState(ANY_TIME);
  const [customStart, setCustomStart] = useState(() => toLocalInput(new Date(Date.now() - 24 * 3600_000)));
  const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()));

  // Memoized so a relative preset snapshots "now" only when the selection changes —
  // recomputing every render would change the query key continuously and refetch in a loop.
  const bounds = useMemo<{ startTimeFrom?: string; startTimeTo?: string }>(() => {
    if (timeRange === ANY_TIME) return {};
    if (timeRange === CUSTOM_RANGE) return { startTimeFrom: localToIso(customStart), startTimeTo: localToIso(customEnd) };
    const preset = TIME_PRESETS.find((p) => p.label === timeRange);
    if (!preset) return {};
    const now = Date.now();
    return { startTimeFrom: new Date(now - preset.ms).toISOString(), startTimeTo: new Date(now).toISOString() };
  }, [timeRange, customStart, customEnd]);

  const controls = (
    <>
      <Select
        size="small"
        sx={{ minWidth: 170 }}
        value={timeRange}
        onChange={(e) => {
          const v = e.target.value as string;
          setTimeRange(v);
          if (v === CUSTOM_RANGE) {
            setCustomStart(toLocalInput(new Date(Date.now() - 24 * 3600_000)));
            setCustomEnd(toLocalInput(new Date()));
          }
        }}
        inputProps={{ 'aria-label': 'Time range' }}>
        <MenuItem value={ANY_TIME}>{ANY_TIME}</MenuItem>
        {TIME_PRESETS.map((p) => (
          <MenuItem key={p.label} value={p.label}>
            {p.label}
          </MenuItem>
        ))}
        <MenuItem value={CUSTOM_RANGE}>{CUSTOM_RANGE}</MenuItem>
      </Select>
      {timeRange === CUSTOM_RANGE && (
        <>
          <TextField label="Start from" type="datetime-local" size="small" value={customStart} onChange={(e) => setCustomStart(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="End on" type="datetime-local" size="small" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        </>
      )}
    </>
  );

  return { bounds, controls, active: timeRange !== ANY_TIME, reset: () => setTimeRange(ANY_TIME) };
}

export default function AdminPortal({ targets, environmentId, taskQueue, initialWorkflowType, initialWorkflowId }: PortalScope & { initialWorkflowType?: string; initialWorkflowId?: string }) {
  const scope: PortalScope = { targets, environmentId, taskQueue };
  const [toast, setToast] = useState<Toast>(null);
  // WorkflowsAdmin's filters live here rather than inside it: deep-link params seed them once, at
  // initial mount, and the whole portal remounts when those params change.
  const [status, setStatus] = useState('All');
  // The Autocomplete matches options by workflowType, so a minimal {workflowType} object selects it.
  const [selectedType, setSelectedType] = useState<WorkflowDefinition | null>(initialWorkflowType ? { workflowType: initialWorkflowType } : null);
  const [search, setSearch] = useState(initialWorkflowId ?? '');
  const timeFilter = useTimeRangeFilter();

  return (
    <>
      <WorkflowsAdmin scope={scope} onToast={setToast} status={status} setStatus={setStatus} selectedType={selectedType} setSelectedType={setSelectedType} search={search} setSearch={setSearch} timeFilter={timeFilter} />

      <Snackbar open={toast !== null} autoHideDuration={4000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)} sx={{ width: '100%' }}>
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </>
  );
}

// ── Workflows ────────────────────────────────────────────────────────────────

type TimeRangeFilter = ReturnType<typeof useTimeRangeFilter>;

// Filter state is owned by AdminPortal (lifted so it survives switching views), passed in here.
function WorkflowsAdmin({
  scope,
  onToast,
  status,
  setStatus,
  selectedType,
  setSelectedType,
  search,
  setSearch,
  timeFilter,
}: {
  scope: PortalScope;
  onToast: (t: Toast) => void;
  status: string;
  setStatus: (v: string) => void;
  selectedType: WorkflowDefinition | null;
  setSelectedType: (v: WorkflowDefinition | null) => void;
  search: string;
  setSearch: (v: string) => void;
  timeFilter: TimeRangeFilter;
}) {
  const [startOpen, setStartOpen] = useState(false);
  // The drawer opens against the integration that owns the run, per the row's own task queue.
  const [detail, setDetail] = useState<{ workflowId: string; taskQueue?: string } | null>(null);
  const [integration, setIntegration] = useState<WorkflowTarget | null>(null);

  const multi = scope.targets.length > 1;
  // Narrowing by integration is just a task-queue filter on the same gateway request.
  const taskQueue = integration?.handler ?? scope.taskQueue;
  const definitions = useWorkflowDefinitionsAcross(scope.targets, scope.environmentId);

  const filters = {
    status: status === 'All' ? undefined : status,
    workflowType: selectedType?.workflowType || undefined,
    workflowId: search || undefined,
    taskQueue,
    startTimeFrom: timeFilter.bounds.startTimeFrom,
    startTimeTo: timeFilter.bounds.startTimeTo,
    limit: 50,
  };
  const { data: page, isLoading, error, refetch, isFetching } = useWorkflowInstances(gatewayScope(scope), filters);
  const items = sortByStartTimeDesc(page?.items ?? []);
  const hasFilters = status !== 'All' || !!selectedType || !!search || !!integration || timeFilter.active;

  return (
    <>
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 2 }} flexWrap="wrap">
        <SearchField value={search} onChange={setSearch} placeholder="Search by workflow ID" sx={{ width: 280 }} />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw size={16} style={{ animation: isFetching ? 'spin 1s linear infinite' : 'none' }} />
          </IconButton>
        </Tooltip>
        <Authorized permissions={[Permissions.WORKFLOW_MANAGE_WORKFLOWS]}>
          <Button variant="contained" size="small" startIcon={<Play size={14} />} onClick={() => setStartOpen(true)}>
            Start New Workflow
          </Button>
        </Authorized>
      </Stack>

      <Stack direction="row" gap={1.5} sx={{ mb: 2 }} flexWrap="wrap" alignItems="center">
        <StatusFilter options={WORKFLOW_STATUSES} value={status} onChange={setStatus} />
        <WorkflowNameFilter definitions={distinctWorkflowTypes(definitions.items)} value={selectedType} onChange={setSelectedType} />
        {multi && <IntegrationFilter targets={scope.targets} value={integration} onChange={setIntegration} />}
        {timeFilter.controls}
        {hasFilters && (
          <Button
            size="small"
            onClick={() => {
              setStatus('All');
              setSelectedType(null);
              setSearch('');
              setIntegration(null);
              timeFilter.reset();
            }}>
            Clear
          </Button>
        )}
      </Stack>

      <DefinitionsUnavailableNotice failed={definitions.failed} />

      {isLoading ? (
        <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
      ) : error ? (
        <Typography sx={emptySx}>{error instanceof Error ? error.message : 'Failed to load workflows.'}</Typography>
      ) : items.length === 0 ? (
        <Typography sx={emptySx}>No workflows found.</Typography>
      ) : (
        <>
          <ListingTable>
            <ListingTable.Head>
              <ListingTable.Row>
                <ListingTable.Cell>Workflow ID</ListingTable.Cell>
                <ListingTable.Cell>Name</ListingTable.Cell>
                {multi && <ListingTable.Cell>Integration</ListingTable.Cell>}
                <ListingTable.Cell>Status</ListingTable.Cell>
                <ListingTable.Cell>Started</ListingTable.Cell>
                <ListingTable.Cell>Actions</ListingTable.Cell>
              </ListingTable.Row>
            </ListingTable.Head>
            <ListingTable.Body>
              {items.map((wf) => (
                <ListingTable.Row key={`${wf.workflowId}:${wf.runId ?? ''}`}>
                  <ListingTable.Cell>
                    <Typography sx={{ fontFamily: 'monospace', fontSize: 12 }}>{wf.workflowId}</Typography>
                  </ListingTable.Cell>
                  <ListingTable.Cell>{wf.workflowType ?? '—'}</ListingTable.Cell>
                  {multi && (
                    <ListingTable.Cell>
                      <Typography variant="body2">{ownerLabel(scope, wf.taskQueue)}</Typography>
                    </ListingTable.Cell>
                  )}
                  <ListingTable.Cell>
                    <StatusChip status={wf.status} />
                  </ListingTable.Cell>
                  <ListingTable.Cell>{formatTime(wf.startTime)}</ListingTable.Cell>
                  <ListingTable.Cell>
                    <Tooltip title="View details">
                      <IconButton size="small" onClick={() => setDetail({ workflowId: wf.workflowId, taskQueue: wf.taskQueue })} aria-label="View details">
                        <Eye size={16} />
                      </IconButton>
                    </Tooltip>
                  </ListingTable.Cell>
                </ListingTable.Row>
              ))}
            </ListingTable.Body>
          </ListingTable>
          {page?.hasMore && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, textAlign: 'center' }}>
              Showing the first {items.length}. Refine filters to narrow results.
            </Typography>
          )}
        </>
      )}

      {startOpen && <StartWorkflowDialog scope={scope} onClose={() => setStartOpen(false)} onToast={onToast} />}
      {detail && <WorkflowDetailDrawer scope={ownerScope(scope, detail.taskQueue)} workflowId={detail.workflowId} onClose={() => setDetail(null)} />}
    </>
  );
}

export function StartWorkflowDialog({ scope, initialWorkflowType, onClose, onToast }: { scope: PortalScope; initialWorkflowType?: string; onClose: () => void; onToast: (t: Toast) => void }) {
  // `/definitions` is runtime-local, so each definition already names the runtime hosting it. That
  // makes the chosen workflow the choice of integration too — no separate target picker needed, and
  // at project scope the dropdown is the union over every integration.
  const definitions = useWorkflowDefinitionsAcross(scope.targets, scope.environmentId);
  const multi = scope.targets.length > 1;
  const [selected, setSelected] = useState<Owned<WorkflowDefinition> | null>(null);
  const targetScope: WorkflowScope = { componentId: selected?.componentId ?? '', environmentId: scope.environmentId };
  const start = useStartWorkflow(targetScope);
  const [workflowId, setWorkflowId] = useState('');
  const [timeout, setTimeoutVal] = useState('');
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ workflowType: string; workflowId: string } | null>(null);
  const navigate = useNavigate();
  const navScope = useScope();

  // A deep link (e.g. Overview → "Start Workflow") names a workflow type only; bind it to a concrete
  // definition — and thereby to its runtime — once the definitions have loaded.
  useEffect(() => {
    if (!initialWorkflowType || selected) return;
    const match = definitions.items.find((d) => d.workflowType === initialWorkflowType);
    if (match) setSelected(match);
  }, [initialWorkflowType, selected, definitions.items]);

  // When the input schema parses into fields, a generated form replaces the raw JSON input.
  const formFields = selected ? parseFormSchema(selected.inputSchema) : null;

  const setFormValue = (name: string, value: string | boolean) => {
    setFormValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const submit = () => {
    if (!selected) return;
    setStartError(null);
    let parsedInput: unknown;
    if (formFields) {
      const { result, errors } = buildFormResult(formFields, formValues);
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return;
      }
      parsedInput = Object.keys(result).length > 0 ? result : undefined;
    }
    start.mutate(
      {
        workflowType: selected.workflowType,
        input: parsedInput,
        workflowId: workflowId.trim() || undefined,
        timeoutSeconds: timeout.trim() ? Number(timeout) : undefined,
      },
      {
        onSuccess: (wf) => {
          if (wf?.workflowId) {
            setStarted({ workflowType: selected.workflowType, workflowId: wf.workflowId });
          } else {
            onToast({ severity: 'success', message: `Started ${selected.workflowType}.` });
            onClose();
          }
        },
        onError: (e) => setStartError(e instanceof Error && e.message ? e.message : 'Failed to start workflow.'),
      },
    );
  };

  const copyWorkflowId = async () => {
    if (!started) return;
    try {
      await navigator.clipboard.writeText(started.workflowId);
      onToast({ severity: 'success', message: 'Workflow ID copied to clipboard.' });
    } catch {
      onToast({ severity: 'error', message: 'Failed to copy workflow ID.' });
    }
  };

  const viewInstance = () => {
    if (!started) return;
    onClose();
    navigate(`${resourceUrl(navScope, 'workflows')}?tab=management&workflowId=${encodeURIComponent(started.workflowId)}&env=${encodeURIComponent(scope.environmentId)}`);
  };

  if (started) {
    return (
      <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={sectionTitleSx}>Workflow Started</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mt: 1 }}>
            <strong>{started.workflowType}</strong> workflow started with workflow ID{' '}
            <Typography component="code" sx={{ fontFamily: 'monospace', fontSize: 13, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider', borderRadius: 0.5, px: 0.75, py: 0.25 }}>
              {started.workflowId}
            </Typography>
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
          <Button startIcon={<Copy size={14} />} onClick={copyWorkflowId}>
            Copy Workflow ID
          </Button>
          <Button variant="contained" startIcon={<Eye size={14} />} onClick={viewInstance}>
            View Running Workflow
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={sectionTitleSx}>Start Workflow</DialogTitle>
      <DialogContent>
        <Stack gap={2} sx={{ mt: 1 }}>
          <Autocomplete
            options={definitions.items}
            loading={definitions.isLoading}
            getOptionLabel={(d) => (multi ? `${d.workflowType} — ${d.componentName}` : d.workflowType)}
            value={selected}
            isOptionEqualToValue={(a, b) => a.workflowType === b.workflowType && a.componentId === b.componentId}
            onChange={(_, v) => {
              setSelected(v);
              // The input schema is per definition, so switching invalidates anything already typed.
              setFormValues({});
              setFieldErrors({});
              setStartError(null);
            }}
            renderInput={(params) => <TextField {...params} label="Workflow name" required placeholder="Select a workflow" />}
          />
          <DefinitionsUnavailableNotice failed={definitions.failed} />
          <SubmitError message={startError} onClear={() => setStartError(null)} />
          {formFields ? (
            <SchemaFormFields fields={formFields} values={formValues} errors={fieldErrors} onChange={setFormValue} />
          ) : (
            selected &&
            (selected.inputSchema ? (
              <SchemaDisclosure schema={selected.inputSchema} />
            ) : (
              <Typography variant="caption" color="text.secondary">
                No input schema defined for this workflow.
              </Typography>
            ))
          )}
          <Stack direction="row" gap={2}>
            <TextField label="Workflow ID (optional)" fullWidth size="small" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} />
            <TextField label="Timeout (seconds)" type="number" size="small" sx={{ width: 200 }} value={timeout} onChange={(e) => setTimeoutVal(e.target.value)} placeholder="e.g. 300" slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!selected || start.isPending} onClick={submit}>
          {start.isPending ? 'Starting…' : 'Start'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Review activities ───────────────────────────────────────────────────────────

/**
 * Review activities are human-in-the-loop decisions on gated or failed activities, so they belong
 * with the user's own work rather than with workflow administration — UserPortal renders this.
 */
export function ReviewActivities({ scope, onToast }: { scope: PortalScope; onToast: (t: Toast) => void }) {
  const [search, setSearch] = useState('');
  // Pending is what a reviewer is here for; the other statuses are a look back.
  const [status, setStatus] = useState('PENDING');
  const [selectedType, setSelectedType] = useState<WorkflowDefinition | null>(null);
  // Like the workflow list, the dialog opens against the integration that owns the row.
  const [open, setOpen] = useState<{ taskId: string; taskQueue?: string } | null>(null);
  const [integration, setIntegration] = useState<WorkflowTarget | null>(null);
  const timeFilter = useTimeRangeFilter();

  const multi = scope.targets.length > 1;
  const taskQueue = integration?.handler ?? scope.taskQueue;
  const definitions = useWorkflowDefinitionsAcross(scope.targets, scope.environmentId);
  const {
    data: page,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useReviewActivities(gatewayScope(scope), {
    status: status === 'All' ? undefined : status,
    parentWorkflowId: search || undefined,
    taskQueue,
    startTimeFrom: timeFilter.bounds.startTimeFrom,
    startTimeTo: timeFilter.bounds.startTimeTo,
    limit: 50,
  });

  // The review-activity API has no workflow-name filter; the qualified task name carries it, so filter client-side.
  const items = sortByStartTimeDesc((page?.items ?? []).filter((t) => !selectedType || splitQualifiedName(t.taskName ?? t.activityName).workflow === selectedType.workflowType));
  const hasFilters = status !== 'PENDING' || !!selectedType || !!search || !!integration || timeFilter.active;

  return (
    <>
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 2 }}>
        <SearchField value={search} onChange={setSearch} placeholder="Search by workflow ID" sx={{ width: 320 }} />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw size={16} style={{ animation: isFetching ? 'spin 1s linear infinite' : 'none' }} />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction="row" gap={1.5} sx={{ mb: 2 }} flexWrap="wrap" alignItems="center">
        <StatusFilter options={REVIEW_ACTIVITY_STATUSES} value={status} onChange={setStatus} />
        <WorkflowNameFilter definitions={distinctWorkflowTypes(definitions.items)} value={selectedType} onChange={setSelectedType} />
        {multi && <IntegrationFilter targets={scope.targets} value={integration} onChange={setIntegration} />}
        {timeFilter.controls}
        {hasFilters && (
          <Button
            size="small"
            onClick={() => {
              setStatus('PENDING');
              setSelectedType(null);
              setSearch('');
              setIntegration(null);
              timeFilter.reset();
            }}>
            Clear
          </Button>
        )}
      </Stack>

      <DefinitionsUnavailableNotice failed={definitions.failed} />

      {isLoading ? (
        <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
      ) : error ? (
        <Typography sx={emptySx}>{error instanceof Error ? error.message : 'Failed to load review activities.'}</Typography>
      ) : items.length === 0 ? (
        <Typography sx={emptySx}>No review activities found.</Typography>
      ) : (
        <ListingTable>
          <ListingTable.Head>
            <ListingTable.Row>
              <ListingTable.Cell>Activity Name</ListingTable.Cell>
              <ListingTable.Cell>Workflow Name</ListingTable.Cell>
              {multi && <ListingTable.Cell>Integration</ListingTable.Cell>}
              <ListingTable.Cell>Workflow ID</ListingTable.Cell>
              <ListingTable.Cell>Status</ListingTable.Cell>
              <ListingTable.Cell>Started</ListingTable.Cell>
              <ListingTable.Cell>View</ListingTable.Cell>
            </ListingTable.Row>
          </ListingTable.Head>
          <ListingTable.Body>
            {items.map((t) => {
              const qualified = splitQualifiedName(t.taskName ?? t.activityName);
              return (
                <ListingTable.Row key={t.taskId}>
                  <ListingTable.Cell>
                    <Typography variant="body2">{qualified.task ?? t.taskId}</Typography>
                  </ListingTable.Cell>
                  <ListingTable.Cell>
                    <Typography variant="body2">{qualified.workflow ?? '—'}</Typography>
                  </ListingTable.Cell>
                  {multi && (
                    <ListingTable.Cell>
                      <Typography variant="body2">{ownerLabel(scope, t.taskQueue)}</Typography>
                    </ListingTable.Cell>
                  )}
                  <ListingTable.Cell>
                    <WorkflowIdLink workflowId={t.parentWorkflowId} environmentId={scope.environmentId} />
                  </ListingTable.Cell>
                  <ListingTable.Cell>
                    <StatusChip status={t.status} />
                  </ListingTable.Cell>
                  <ListingTable.Cell>{formatTime(t.startTime)}</ListingTable.Cell>
                  <ListingTable.Cell>
                    <Tooltip title="Open activity">
                      <IconButton size="small" onClick={() => setOpen({ taskId: t.taskId, taskQueue: t.taskQueue })} aria-label="Open activity">
                        <Eye size={16} />
                      </IconButton>
                    </Tooltip>
                  </ListingTable.Cell>
                </ListingTable.Row>
              );
            })}
          </ListingTable.Body>
        </ListingTable>
      )}

      {open && <ReviewActivityDetailDialog scope={ownerScope(scope, open.taskQueue)} taskId={open.taskId} onClose={() => setOpen(null)} onToast={onToast} />}
    </>
  );
}

/**
 * Display name for a review activity: the task part of its qualified name
 * (e.g. `placeOrderWorkflow.validatePayment` → `validatePayment`), else the task ID.
 */
function reviewActivityDisplayName(taskName?: string, activityName?: string, fallback = ''): string {
  const { task } = splitQualifiedName(taskName ?? activityName);
  return task ?? fallback;
}

function ReviewActivityDetailDialog({ scope, taskId, onClose, onToast }: { scope: WorkflowScope; taskId: string; onClose: () => void; onToast: (t: Toast) => void }) {
  const { data: activity, isLoading, error: loadError } = useReviewActivity(scope, taskId);
  const decide = useReviewDecision(scope);
  const [mode, setMode] = useState<'view' | 'reject'>('view');
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  // Message from a rejected decision — shown inline; see SubmitError.
  const [decideError, setDecideError] = useState<string | null>(null);

  const formFields = parseFormSchema(activity?.formSchema);
  // Only a PENDING activity can be acted on; COMPLETED/CANCELED/TERMINATED are view-only.
  const canDecide = activity?.status === 'PENDING';
  const { workflow } = splitQualifiedName(activity?.taskName ?? activity?.activityName);
  const heading = activity?.title || reviewActivityDisplayName(activity?.taskName, activity?.activityName, taskId);

  // Seed the form from the activity's arguments once the detail loads (activityArgs conforms to formSchema).
  useEffect(() => {
    if (!activity) return;
    const fields = parseFormSchema(activity.formSchema);
    setFormValues(fields ? formValuesFromObject(fields, activity.activityArgs ?? {}) : {});
  }, [activity]);

  const setFormValue = (name: string, value: string | boolean) => {
    setFormValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const runDecision = (decision: ReviewDecision, input?: unknown, feedbackText?: string) => {
    setDecideError(null);
    decide.mutate(
      { taskId, decision, input, feedback: feedbackText },
      {
        onSuccess: () => {
          onToast({ severity: 'success', message: decision === 'reject' ? 'Activity rejected.' : 'Activity proceeded.' });
          onClose();
        },
        onError: (e) => setDecideError(e instanceof Error && e.message ? e.message : 'Action failed.'),
      },
    );
  };

  // Proceed always goes through proceed-with-input: with a form it submits the (possibly edited)
  // values; without one it reruns with the original, unedited arguments.
  const submitProceed = () => {
    if (formFields) {
      const { result, errors } = buildFormResult(formFields, formValues);
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return;
      }
      runDecision('proceed-with-input', result);
      return;
    }
    runDecision('proceed-with-input', activity?.activityArgs ?? {});
  };

  const busy = decide.isPending;

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={sectionTitleSx}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <span>{heading}</span>
          {activity?.status && <StatusChip status={activity.status} />}
        </Stack>
      </DialogTitle>
      <DialogContent>
        {isLoading ? (
          <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
        ) : loadError || !activity ? (
          <Typography sx={emptySx}>{loadError instanceof Error ? loadError.message : 'Failed to load activity details.'}</Typography>
        ) : (
          <Stack gap={2} sx={{ mt: 1 }}>
            <SubmitError message={decideError} onClear={() => setDecideError(null)} />
            {activity.description && (
              <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
                <Typography variant="subtitle2" sx={{ px: 2, py: 1.5, ...sectionTitleSx }}>
                  Description
                </Typography>
                <Divider />
                <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
                  {activity.description}
                </Typography>
              </Card>
            )}

            <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
              <Typography variant="subtitle2" sx={{ px: 2, py: 1.5, ...sectionTitleSx }}>
                Activity Detail
              </Typography>
              <Divider />
              <Stack gap={1.25} sx={{ px: 2, py: 2 }}>
                <DetailRow label="Task Name">{reviewActivityDisplayName(activity.taskName, activity.activityName, '—')}</DetailRow>
                <DetailRow label="Workflow Name">{workflow ?? '—'}</DetailRow>
                <DetailRow label="Parent Workflow ID">
                  <WorkflowIdLink workflowId={activity.parentWorkflowId} environmentId={scope.environmentId} onNavigate={onClose} />
                </DetailRow>
                <DetailRow label="Created">{formatTime(activity.startTime)}</DetailRow>
                {activity.errorMessage && <DetailRow label="Error">{activity.errorMessage}</DetailRow>}
              </Stack>
            </Card>

            {/* Editable form seeded from activityArgs when the activity is actionable; otherwise
                the arguments are shown read-only. */}
            {/* Fields generated from formSchema, populated from activityArgs. Editable when the
                activity is actionable; disabled (read-only) once decided. Falls back to a JSON
                view when there is no schema. */}
            {mode === 'view' &&
              (formFields ? (
                <SchemaFormFields fields={formFields} values={formValues} errors={fieldErrors} onChange={setFormValue} disabled={!canDecide} />
              ) : activity.activityArgs ? (
                <SchemaDisclosure schema={JSON.stringify(activity.activityArgs, null, 2)} label="Activity arguments" />
              ) : null)}

            {mode === 'reject' && <TextField label="Feedback (optional)" fullWidth multiline minRows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} helperText="Relayed to the workflow as the rejection reason." />}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose}>Close</Button>
        {/* Deciding a review activity requires the workflow manage permission. */}
        <Authorized permissions={[Permissions.WORKFLOW_MANAGE_WORKFLOWS]}>
          {canDecide && mode === 'view' && (
            <>
              <Button
                color="error"
                disabled={busy}
                onClick={() => {
                  setMode('reject');
                  setDecideError(null);
                }}>
                Reject
              </Button>
              <Button variant="contained" disabled={busy} onClick={submitProceed}>
                {busy ? 'Submitting…' : 'Proceed'}
              </Button>
            </>
          )}
          {canDecide && mode === 'reject' && (
            <>
              <Button
                disabled={busy}
                onClick={() => {
                  setMode('view');
                  setDecideError(null);
                }}>
                Back
              </Button>
              <Button variant="contained" color="error" disabled={busy} onClick={() => runDecision('reject', undefined, feedback.trim() || undefined)}>
                {busy ? 'Submitting…' : 'Submit Rejection'}
              </Button>
            </>
          )}
        </Authorized>
      </DialogActions>
    </Dialog>
  );
}
