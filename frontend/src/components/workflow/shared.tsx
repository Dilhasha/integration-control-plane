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

import { Alert, Box, Chip, Collapse, Link, Stack, Typography } from '@wso2/oxygen-ui';
import { ChevronRight } from '@wso2/oxygen-ui-icons-react';
import { useState, type JSX, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { resourceUrl, useScope } from '../../nav';
import CodeViewer from '../CodeViewer';
import { STATUS_COLORS } from './helpers';

export interface WorkflowScope {
  componentId: string;
  environmentId: string;
}

/**
 * Returns a handler that opens the Workflows admin view pre-filtered by a workflow ID — the same
 * destination as the start-workflow dialog's "View Running Workflow" action.
 */
function useViewWorkflowById(environmentId: string): (workflowId: string) => void {
  const navigate = useNavigate();
  const scope = useScope();
  return (workflowId: string) => {
    navigate(`${resourceUrl(scope, 'workflows')}?tab=management&workflowId=${encodeURIComponent(workflowId)}&env=${encodeURIComponent(environmentId)}`);
  };
}

/** Renders a workflow ID as a monospace link that opens the Workflows admin view filtered by that ID. */
export function WorkflowIdLink({ workflowId, environmentId, onNavigate }: { workflowId?: string; environmentId: string; onNavigate?: () => void }): JSX.Element {
  const viewWorkflow = useViewWorkflowById(environmentId);
  if (!workflowId) return <Typography sx={{ fontFamily: 'monospace', fontSize: 12 }}>—</Typography>;
  return (
    <Link
      component="button"
      type="button"
      onClick={() => {
        onNavigate?.();
        viewWorkflow(workflowId);
      }}
      sx={{ fontFamily: 'monospace', fontSize: 12, textAlign: 'left', wordBreak: 'break-all', cursor: 'pointer', color: 'text.primary', textDecorationColor: 'inherit' }}>
      {workflowId}
    </Link>
  );
}

/** Renders a status string as a colour-coded chip. */
export function StatusChip({ status }: { status?: string }): JSX.Element {
  const normalized = (status ?? '').toUpperCase();
  const color = STATUS_COLORS[normalized] ?? 'default';
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase().replace(/_/g, ' ') : '—';
  return <Chip label={label} size="small" color={color} variant="outlined" />;
}

/** A label/value row used in task and activity detail cards. String children render as body text. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <Stack direction="row" gap={2}>
      <Typography variant="body2" sx={{ width: 140, flexShrink: 0, fontWeight: 600, color: 'text.disabled' }}>
        {label}
      </Typography>
      {typeof children === 'string' ? (
        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
          {children}
        </Typography>
      ) : (
        children
      )}
    </Stack>
  );
}

/**
 * Dialog-level banner for a submission the runtime rejected. Generated forms only pre-check required
 * fields and type coercion, so schema constraints (pattern / minimum / format / nested shape) are
 * caught server-side — and that message has to be shown inline, because a toast pops behind the open
 * dialog it belongs to. Renders nothing when there is no error.
 */
export function SubmitError({ message, onClear }: { message: string | null; onClear: () => void }): JSX.Element | null {
  if (!message) return null;
  return (
    <Alert severity="error" onClose={onClear} sx={{ '& .MuiAlert-message': { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }}>
      {message}
    </Alert>
  );
}

/** A compact, theme-consistent expandable panel for revealing a JSON schema/payload. */
export function SchemaDisclosure({ schema, label = 'Click to see Input Schema' }: { schema: string; label?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      <Stack
        direction="row"
        alignItems="center"
        gap={0.5}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        sx={{ px: 1.5, py: 1, cursor: 'pointer', userSelect: 'none', bgcolor: 'action.hover', '&:hover': { bgcolor: 'action.selected' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
        <ChevronRight size={16} style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }} />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
      </Stack>
      <Collapse in={open}>
        <Box sx={{ p: 1 }}>
          <CodeViewer code={schema} language="json" showCopyButton maxHeight="40vh" showLineNumbers={false} />
        </Box>
      </Collapse>
    </Box>
  );
}
