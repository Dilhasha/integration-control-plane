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

import { Alert, Box, Button, Card, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, ListingTable, Snackbar, Stack, TextField, Tooltip, Typography } from '@wso2/oxygen-ui';
import { Eye, RefreshCw } from '@wso2/oxygen-ui-icons-react';
import { useState } from 'react';
import SchemaFormFields from './SchemaFormFields';
import { buildFormResult, formatTime, gatewayScope, humanizeKey, ownerLabel, ownerScope, parseFormSchema, sectionTitleSx, sortByStartTimeDesc, unescapeRoleName, type PortalScope } from './helpers';
import { DetailRow, StatusChip, SubmitError, WorkflowIdLink, type WorkflowScope } from './shared';
import { ReviewActivities, StatusFilter } from './AdminPortal';
import Authorized from '../Authorized';
import { Permissions } from '../../constants/permissions';
import { useCompleteHumanTask, useFailHumanTask, useHumanTask, useHumanTasks, type HumanTask } from '../../api/workflows';

const emptySx = { py: 4, textAlign: 'center', color: 'text.secondary' } as const;

// Statuses a human task reports. Pending is the default: it is the work waiting on the user, and the
// rest are the history that used to live in its own view.
const HUMAN_TASK_STATUSES = ['All', 'PENDING', 'COMPLETED', 'FAILED', 'TERMINATED'];

/**
 * Maps a runtime human-task status to its display status: a pending task's child workflow
 * reports RUNNING (shown as PENDING). Failed tasks report FAILED directly.
 */
const taskDisplayStatus = (s?: string) => (s === 'RUNNING' ? 'PENDING' : s);

/**
 * Display name for a human task: the title when set, else the task name with its
 * `<workflowType>.` qualifier stripped (runtime reports names as e.g. `placeOrderWorkflow.approveOrder`).
 */
function taskDisplayName(t?: HumanTask): string {
  if (!t) return '';
  if (t.title) return t.title;
  if (t.taskName) {
    const prefix = t.parentWorkflowType ? `${t.parentWorkflowType}.` : '';
    return prefix && t.taskName.startsWith(prefix) ? t.taskName.slice(prefix.length) : t.taskName;
  }
  return t.taskId;
}

type Toast = { severity: 'success' | 'error'; message: string } | null;

/**
 * Hosts the two user-facing workflow views. Which one shows is decided by the page's tabs, so this
 * only dispatches and owns the toast both views report through.
 */
export default function UserPortal({ targets, environmentId, taskQueue, view }: PortalScope & { view: 'tasks' | 'reviews' }) {
  const scope: PortalScope = { targets, environmentId, taskQueue };
  const [toast, setToast] = useState<Toast>(null);

  return (
    <>
      {view === 'tasks' ? <MyTasks scope={scope} onToast={setToast} /> : <ReviewActivities scope={scope} onToast={setToast} />}

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

function TaskTable({ tasks, onOpen, environmentId, integrationLabel }: { tasks: HumanTask[]; onOpen: (t: HumanTask) => void; environmentId: string; integrationLabel?: (taskQueue?: string) => string }) {
  return (
    <ListingTable>
      <ListingTable.Head>
        <ListingTable.Row>
          <ListingTable.Cell>Task</ListingTable.Cell>
          <ListingTable.Cell>Workflow Name</ListingTable.Cell>
          {integrationLabel && <ListingTable.Cell>Integration</ListingTable.Cell>}
          <ListingTable.Cell>Workflow ID</ListingTable.Cell>
          <ListingTable.Cell>Status</ListingTable.Cell>
          <ListingTable.Cell>Started</ListingTable.Cell>
          <ListingTable.Cell>Open</ListingTable.Cell>
        </ListingTable.Row>
      </ListingTable.Head>
      <ListingTable.Body>
        {tasks.map((t) => (
          <ListingTable.Row key={t.taskId}>
            <ListingTable.Cell>
              <Stack direction="row" alignItems="center" gap={1}>
                <Typography variant="body2">{taskDisplayName(t)}</Typography>
                {taskDisplayStatus(t.status) === 'PENDING' && t.canComplete === false && (
                  <Tooltip title="You do not have a matching role to complete this task">
                    <Chip label="Read-only" size="small" variant="outlined" sx={{ fontSize: 10, height: 18 }} />
                  </Tooltip>
                )}
              </Stack>
            </ListingTable.Cell>
            <ListingTable.Cell>
              <Typography variant="body2">{t.parentWorkflowType ?? '—'}</Typography>
            </ListingTable.Cell>
            {integrationLabel && (
              <ListingTable.Cell>
                <Typography variant="body2">{integrationLabel(t.taskQueue)}</Typography>
              </ListingTable.Cell>
            )}
            <ListingTable.Cell>
              <WorkflowIdLink workflowId={t.parentWorkflowId} environmentId={environmentId} />
            </ListingTable.Cell>
            <ListingTable.Cell>
              <StatusChip status={taskDisplayStatus(t.status)} />
            </ListingTable.Cell>
            <ListingTable.Cell>{formatTime(t.startTime)}</ListingTable.Cell>
            <ListingTable.Cell>
              <Tooltip title="Open task">
                <IconButton size="small" onClick={() => onOpen(t)} aria-label="Open task">
                  <Eye size={16} />
                </IconButton>
              </Tooltip>
            </ListingTable.Cell>
          </ListingTable.Row>
        ))}
      </ListingTable.Body>
    </ListingTable>
  );
}

function MyTasks({ scope, onToast }: { scope: PortalScope; onToast: (t: Toast) => void }) {
  // Opened against the integration that owns the task, per the task's own task queue.
  const [open, setOpen] = useState<HumanTask | null>(null);
  const [status, setStatus] = useState('PENDING');
  const { data: page, isLoading, error, refetch, isFetching } = useHumanTasks(gatewayScope(scope), { status: status === 'All' ? undefined : status, taskQueue: scope.taskQueue, limit: 50 });
  const tasks = sortByStartTimeDesc(page?.items ?? []);
  const multi = scope.targets.length > 1;

  return (
    <>
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 2 }} flexWrap="wrap">
        <StatusFilter options={HUMAN_TASK_STATUSES} value={status} onChange={setStatus} />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw size={16} style={{ animation: isFetching ? 'spin 1s linear infinite' : 'none' }} />
          </IconButton>
        </Tooltip>
      </Stack>

      {isLoading ? (
        <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
      ) : error ? (
        <Typography sx={emptySx}>{error instanceof Error ? error.message : 'Failed to load tasks.'}</Typography>
      ) : tasks.length === 0 ? (
        <Typography sx={emptySx}>{status === 'All' ? 'No tasks.' : `No ${status.toLowerCase()} tasks.`}</Typography>
      ) : (
        <TaskTable tasks={tasks} onOpen={setOpen} environmentId={scope.environmentId} integrationLabel={multi ? (taskQueue) => ownerLabel(scope, taskQueue) : undefined} />
      )}

      {open && <TaskDetailDialog scope={ownerScope(scope, open.taskQueue)} taskId={open.taskId} actionable={taskDisplayStatus(open.status) === 'PENDING'} onClose={() => setOpen(null)} onToast={onToast} />}
    </>
  );
}

/** Extracts key/value pairs from the task's `payload` JSON object; null when absent or empty. */
function payloadDetailEntries(payload: unknown): Array<[string, string]> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
}

function TaskDetailDialog({ scope, taskId, actionable, onClose, onToast }: { scope: WorkflowScope; taskId: string; actionable?: boolean; onClose: () => void; onToast: (t: Toast) => void }) {
  const { data: task, isLoading, error: taskError } = useHumanTask(scope, taskId);
  const complete = useCompleteHumanTask(scope);
  const fail = useFailHumanTask(scope);
  const [mode, setMode] = useState<'view' | 'complete' | 'fail'>('view');
  const [resultText, setResultText] = useState('{}');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const busy = complete.isPending || fail.isPending;
  const canComplete = task?.canComplete !== false;
  const eligibleRoles = task?.eligibleRoles ?? (Array.isArray(task?.roles) ? (task.roles as string[]) : undefined) ?? task?.userRoles;
  const payloadDetails = payloadDetailEntries(task?.payload);
  const formFields = parseFormSchema(task?.formSchema);

  const setFormValue = (name: string, value: string | boolean) => {
    setFormValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const mutateComplete = (result: unknown) => {
    setSubmitError(null);
    complete.mutate(
      { taskId, result },
      {
        onSuccess: () => {
          onToast({ severity: 'success', message: 'Task completed.' });
          onClose();
        },
        onError: (e) => setSubmitError(e instanceof Error && e.message ? e.message : 'Failed to complete task.'),
      },
    );
  };

  const submitComplete = () => {
    // With a form schema, build the result from the generated form; otherwise fall back to raw JSON.
    if (formFields) {
      const { result, errors } = buildFormResult(formFields, formValues);
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return;
      }
      mutateComplete(result);
      return;
    }

    let result: unknown;
    try {
      result = resultText.trim() ? JSON.parse(resultText) : {};
    } catch {
      setErr('Result must be valid JSON.');
      return;
    }
    mutateComplete(result);
  };

  const submitFail = () => {
    if (!reason.trim()) {
      setErr('Reason is required.');
      return;
    }
    setSubmitError(null);
    fail.mutate(
      { taskId, reason: reason.trim() },
      {
        onSuccess: () => {
          onToast({ severity: 'success', message: 'Task marked as failed.' });
          onClose();
        },
        onError: (e) => setSubmitError(e instanceof Error && e.message ? e.message : 'Failed to fail the task.'),
      },
    );
  };

  // Returns to the initial view, keeping entered values but clearing validation errors.
  const backToView = () => {
    setMode('view');
    setErr('');
    setFieldErrors({});
    setSubmitError(null);
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={sectionTitleSx}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <span>{task ? taskDisplayName(task) : taskId}</span>
          {task?.status && <StatusChip status={taskDisplayStatus(task.status)} />}
        </Stack>
      </DialogTitle>
      <DialogContent>
        {isLoading ? (
          <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
        ) : taskError || !task ? (
          <Typography sx={emptySx}>{taskError instanceof Error ? taskError.message : 'Failed to load task details.'}</Typography>
        ) : (
          <Stack gap={2} sx={{ mt: 1 }}>
            <SubmitError message={submitError} onClear={() => setSubmitError(null)} />
            {task?.description && (
              <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
                <Typography variant="subtitle2" sx={{ px: 2, py: 1.5, ...sectionTitleSx }}>
                  Description
                </Typography>
                <Divider />
                <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
                  {task.description}
                </Typography>
              </Card>
            )}

            <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
              <Typography variant="subtitle2" sx={{ px: 2, py: 1.5, ...sectionTitleSx }}>
                Task Detail
              </Typography>
              <Divider />
              <Stack gap={1.25} sx={{ px: 2, py: 2 }}>
                <DetailRow label="Created">{formatTime(task?.startTime)}</DetailRow>
                <DetailRow label="Eligible Roles">
                  {eligibleRoles?.length ? (
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {eligibleRoles.map((role) => (
                        <Chip key={role} label={unescapeRoleName(role)} size="small" variant="outlined" />
                      ))}
                    </Stack>
                  ) : (
                    '—'
                  )}
                </DetailRow>
                {payloadDetails?.map(([key, value]) => (
                  <DetailRow key={key} label={humanizeKey(key)}>
                    {value}
                  </DetailRow>
                ))}
              </Stack>
            </Card>

            {mode === 'complete' &&
              (formFields ? (
                <SchemaFormFields fields={formFields} values={formValues} errors={fieldErrors} onChange={setFormValue} />
              ) : (
                <TextField
                  label="Result (JSON)"
                  fullWidth
                  multiline
                  minRows={4}
                  value={resultText}
                  onChange={(e) => {
                    setResultText(e.target.value);
                    setErr('');
                  }}
                  error={!!err}
                  helperText={err || 'Payload submitted as the task result.'}
                  slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
                />
              ))}
            {mode === 'fail' && (
              <TextField
                label="Reason"
                fullWidth
                required
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setErr('');
                }}
                error={!!err}
                helperText={err}
              />
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose}>Close</Button>
        {/* Acting on human tasks requires the workflow manage-human-tasks permission. */}
        <Authorized permissions={[Permissions.WORKFLOW_MANAGE_HUMAN_TASKS]}>
          {actionable && !!task && mode === 'view' && (
            <>
              <Button color="warning" disabled={busy} onClick={() => setMode('fail')}>
                Fail
              </Button>
              <Tooltip title={canComplete ? '' : 'You do not have a matching role to complete this task'}>
                <span>
                  <Button variant="contained" disabled={busy || !canComplete} onClick={() => setMode('complete')}>
                    Complete
                  </Button>
                </span>
              </Tooltip>
            </>
          )}
          {mode !== 'view' && (
            <Button disabled={busy} onClick={backToView}>
              Back
            </Button>
          )}
          {mode === 'complete' && (
            <Button variant="contained" disabled={busy} onClick={submitComplete}>
              {complete.isPending ? 'Completing…' : 'Submit Completion'}
            </Button>
          )}
          {mode === 'fail' && (
            <Button variant="contained" color="warning" disabled={busy} onClick={submitFail}>
              {fail.isPending ? 'Submitting…' : 'Fail Task'}
            </Button>
          )}
        </Authorized>
      </DialogActions>
    </Dialog>
  );
}
