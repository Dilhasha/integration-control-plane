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

import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Drawer, IconButton, ListingTable, Snackbar, Stack, Tab, Tabs, TextField, Typography } from '@wso2/oxygen-ui';
import { Ban, OctagonX, PauseCircle, PlayCircle, X } from '@wso2/oxygen-ui-icons-react';
import { useState } from 'react';
import CodeViewer from '../CodeViewer';
import ExecutionGraph from './ExecutionGraph';
import WorkflowTimeline from './WorkflowTimeline';
import { useWorkflowExecutionGraph, useWorkflowHistory, useWorkflowInfo, useWorkflowLifecycle, type WorkflowLifecycleAction } from '../../api/workflows';
import { extractWorkflowInput, jsonPretty } from './helpers';
import { StatusChip, type WorkflowScope } from './shared';
import Authorized from '../Authorized';
import { Permissions } from '../../constants/permissions';
import { useLayout } from '../../contexts/LayoutContext';

// The drawer fills the main content area only — right-anchored, its left edge lands at the sidebar
// width so the left navigation stays visible. `sidebarWidth` is supplied live so the panel tracks
// the sidebar's collapsed/expanded state.
const drawerPaperSx = (sidebarWidth: number) => ({ '& .MuiDrawer-paper': { width: `calc(100% - ${sidebarWidth}px)`, position: 'fixed', top: 64, height: 'calc(100% - 64px)', borderLeft: '1px solid', borderColor: 'divider' } });
const headerSx = { px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' };
const emptySx = { py: 4, textAlign: 'center', color: 'text.secondary' };

export default function WorkflowDetailDrawer({ scope, workflowId, onClose }: { scope: WorkflowScope; workflowId: string; onClose: () => void }) {
  const [tab, setTab] = useState(0);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState<{ severity: 'success' | 'error'; message: string } | null>(null);
  const { sidebarWidth } = useLayout();

  const { data: info, isLoading: loadingInfo, error: infoError } = useWorkflowInfo(scope, workflowId);
  // History is loaded eagerly: the Timeline tab derives the start input from it, renders the timeline,
  // and the History tab renders the raw events.
  const { data: history = [], isLoading: loadingHistory } = useWorkflowHistory(scope, workflowId);
  // Fetched for the Execution Graph tab (1) and also the Timeline tab (0), which uses the graph's
  // authoritative node types to fix categories/icons the history alone can't determine.
  const { data: graph, isLoading: loadingGraph } = useWorkflowExecutionGraph(scope, tab === 0 || tab === 1 ? workflowId : null);
  const lifecycle = useWorkflowLifecycle(scope);

  const status = (info?.status as string | undefined) ?? '';
  const startInput = extractWorkflowInput(history as Array<Record<string, unknown>>);

  // Lifecycle actions narrowed by status: a running instance can be suspended/cancelled/terminated,
  // a suspended one resumed/cancelled/terminated; closed instances (completed, failed, terminated,
  // canceled, timed out) get no actions. Note: the runtime currently reports suspended instances
  // as RUNNING (suspend is a signal, not a Temporal status), so SUSPENDED only takes effect once
  // the runtime exposes it.
  const normalizedStatus = status.toUpperCase();
  const isRunning = normalizedStatus === 'RUNNING';
  const isSuspended = normalizedStatus === 'SUSPENDED';
  const showActions = isRunning || isSuspended;

  const runAction = (action: WorkflowLifecycleAction, actionReason?: string) => {
    lifecycle.mutate(
      { workflowId, action, reason: actionReason },
      {
        onSuccess: () => setToast({ severity: 'success', message: `Workflow ${action} requested.` }),
        onError: (e) => setToast({ severity: 'error', message: e instanceof Error ? e.message : `Failed to ${action}.` }),
      },
    );
  };

  const historyEventKeys = history.length > 0 ? Object.keys(history[0]).slice(0, 5) : [];

  return (
    <Drawer anchor="right" open variant="persistent" sx={drawerPaperSx(sidebarWidth)} onClose={onClose}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={headerSx}>
        <Stack direction="row" alignItems="center" gap={1.5} sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {workflowId}
          </Typography>
          {status && <StatusChip status={status} />}
        </Stack>
        <IconButton size="small" aria-label="close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </Stack>

      {/* Lifecycle actions — only for users who can manage workflow executions */}
      {showActions && (
        <Authorized permissions={[Permissions.WORKFLOW_MANAGE_WORKFLOWS]}>
          <Stack direction="row" gap={1} sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {isRunning && (
              <Button size="small" variant="outlined" startIcon={<PauseCircle size={14} />} disabled={lifecycle.isPending} onClick={() => runAction('suspend')}>
                Suspend
              </Button>
            )}
            {isSuspended && (
              <Button size="small" variant="outlined" startIcon={<PlayCircle size={14} />} disabled={lifecycle.isPending} onClick={() => runAction('resume')}>
                Resume
              </Button>
            )}
            <Button size="small" variant="outlined" color="warning" startIcon={<Ban size={14} />} disabled={lifecycle.isPending} onClick={() => runAction('cancel')}>
              Cancel
            </Button>
            <Button size="small" variant="outlined" color="error" startIcon={<OctagonX size={14} />} disabled={lifecycle.isPending} onClick={() => setTerminateOpen(true)}>
              Terminate
            </Button>
          </Stack>
        </Authorized>
      )}

      <Box sx={{ px: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, '& .MuiTabs-flexContainer': { justifyContent: 'flex-end' } }}>
          <Tab label="Timeline" />
          <Tab label="Execution Graph" />
          <Tab label="History" />
        </Tabs>

        {tab === 0 && (
          <Stack gap={2}>
            {/* Info: start input and execution info side by side, then the run's timeline. */}
            {loadingInfo ? (
              <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
            ) : infoError || !info ? (
              <Typography sx={emptySx}>Could not load workflow info.</Typography>
            ) : (
              <Stack direction="row" gap={1.5} sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {startInput !== null && (
                  <Box sx={{ flex: 1, minWidth: 280 }}>
                    <CodeViewer code={startInput} language="json" title="Start input" height="20vh" expandable showLineNumbers={false} />
                  </Box>
                )}
                <Box sx={{ flex: 1, minWidth: 280 }}>
                  <CodeViewer code={jsonPretty(info)} language="json" title="Execution info" height="20vh" expandable showLineNumbers={false} />
                </Box>
              </Stack>
            )}
            {loadingHistory ? (
              <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
            ) : history.length === 0 ? (
              <Typography sx={emptySx}>No history events.</Typography>
            ) : (
              <WorkflowTimeline events={history as Array<Record<string, unknown>>} graph={graph} />
            )}
          </Stack>
        )}

        {tab === 2 &&
          (loadingHistory ? (
            <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
          ) : history.length === 0 ? (
            <Typography sx={emptySx}>No history events.</Typography>
          ) : (
            <ListingTable>
              <ListingTable.Head>
                <ListingTable.Row>
                  {historyEventKeys.map((k) => (
                    <ListingTable.Cell key={k}>{k}</ListingTable.Cell>
                  ))}
                </ListingTable.Row>
              </ListingTable.Head>
              <ListingTable.Body>
                {history.map((ev, i) => (
                  <ListingTable.Row key={i}>
                    {historyEventKeys.map((k) => (
                      <ListingTable.Cell key={k}>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {typeof ev[k] === 'object' ? JSON.stringify(ev[k]) : String(ev[k] ?? '—')}
                        </Typography>
                      </ListingTable.Cell>
                    ))}
                  </ListingTable.Row>
                ))}
              </ListingTable.Body>
            </ListingTable>
          ))}

        {tab === 1 &&
          (loadingGraph ? (
            <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', py: 4 }} />
          ) : !graph ? (
            <Typography sx={emptySx}>No execution graph available.</Typography>
          ) : (
            <ExecutionGraph graph={graph} events={history as Array<Record<string, unknown>>} />
          ))}
      </Box>

      <Dialog open={terminateOpen} onClose={() => setTerminateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Terminate Workflow</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Terminate <strong>{workflowId}</strong> immediately? This cannot be undone.
          </DialogContentText>
          <TextField label="Reason (optional)" fullWidth size="small" value={reason} onChange={(e) => setReason(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTerminateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              runAction('terminate', reason);
              setTerminateOpen(false);
              setReason('');
            }}>
            Terminate
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={toast !== null} autoHideDuration={4000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)} sx={{ width: '100%' }}>
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Drawer>
  );
}
