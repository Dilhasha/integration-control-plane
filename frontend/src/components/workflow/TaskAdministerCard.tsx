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
import { Alert, Button, Chip, Stack, TextField, Typography } from '@wso2/oxygen-ui';
import { useState } from 'react';
import { escapeRoleName, unescapeRoleName } from './helpers';
import { ActionCard, DetailRow, IdText, NotProvided, SectionCard, type WorkflowScope } from './shared';
import { useExtendTaskDeadline, useReassignTask, type TaskAudience, type TaskSummary } from '../../api/workflows';
import type { Toast } from './AdminPortal';

// Administrators are named beside the audience, whichever the task's kind.
export function AdministratorsRow({ task }: { task: TaskSummary }): JSX.Element {
  const roles = task.administratorRoles ?? [];
  const users = task.administratorUsers ?? [];
  return (
    <DetailRow label="Administrators">
      {roles.length || users.length ? (
        <Stack direction="row" gap={0.5} flexWrap="wrap">
          {roles.map((role) => (
            <Chip key={`r:${role}`} label={unescapeRoleName(role)} size="small" variant="outlined" />
          ))}
          {users.map((user) => (
            <Chip key={`u:${user}`} label={<IdText id={user} />} size="small" />
          ))}
        </Stack>
      ) : (
        <NotProvided />
      )}
    </DetailRow>
  );
}

export function completedAsLabel(completedAs?: string): string | undefined {
  if (completedAs === 'administrator') return 'As an administrator';
  if (completedAs === 'audience') return 'As the audience';
  return undefined;
}

// One entry per line: a role name may itself contain a comma, so commas never separate entries.
const listOf = (text: string): string[] =>
  text
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);

// The runtime's stored form, one per line, exactly as it will be sent back when left unchanged.
const linesOf = (values?: string[]): string => (values ?? []).join('\n');

// What an administrator may do to a pending task besides deciding it: hand it to a new
// audience, or move or clear its deadline. Every act is recorded in the task's history.
export default function TaskAdministerCard({
  scope,
  task,
  kind,
  disabled,
  onDone,
  onToast,
}: {
  scope: WorkflowScope;
  task: TaskSummary;
  kind: 'HUMAN_TASK' | 'REVIEW_ACTIVITY';
  disabled?: boolean;
  onDone: () => void;
  onToast: (t: Toast) => void;
}): JSX.Element | null {
  const reassign = useReassignTask(scope, kind);
  const extend = useExtendTaskDeadline(scope, kind);
  const [mode, setMode] = useState<'none' | 'reassign' | 'deadline'>('none');
  const [userRoles, setUserRoles] = useState(linesOf(task.userRoles));
  const [users, setUsers] = useState(linesOf(task.users));
  const [excludedRoles, setExcludedRoles] = useState(linesOf(task.excludedRoles));
  const [excludedUsers, setExcludedUsers] = useState(linesOf(task.excludedUsers));
  const [minutes, setMinutes] = useState('60');
  const [err, setErr] = useState('');

  if (task.canAdminister !== true) return null;
  const busy = disabled || reassign.isPending || extend.isPending;

  const fail = (e: unknown, fallback: string) => setErr(e instanceof Error && e.message ? e.message : fallback);

  const submitReassign = () => {
    const audience: TaskAudience = {
      userRoles: listOf(userRoles).map(escapeRoleName),
      users: listOf(users),
      excludedRoles: listOf(excludedRoles).map(escapeRoleName),
      excludedUsers: listOf(excludedUsers),
    };
    if (audience.userRoles!.length === 0 && audience.users!.length === 0) {
      setErr('Name at least one role or user.');
      return;
    }
    setErr('');
    reassign.mutate(
      { taskId: task.taskId, audience },
      {
        onSuccess: () => {
          onDone();
          onToast({ severity: 'success', message: 'Task reassigned.' });
        },
        onError: (e) => fail(e, 'Failed to reassign the task.'),
      },
    );
  };

  const submitDeadline = (clear: boolean) => {
    const timeoutMillis = Math.round(Number(minutes) * 60_000);
    if (!clear && (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0)) {
      setErr('Enter the minutes from now, greater than zero.');
      return;
    }
    setErr('');
    extend.mutate(
      { taskId: task.taskId, timeoutMillis: clear ? null : timeoutMillis },
      {
        onSuccess: () => {
          onDone();
          onToast({ severity: 'success', message: clear ? 'Deadline cleared.' : 'Deadline extended.' });
        },
        onError: (e) => fail(e, 'Failed to change the deadline.'),
      },
    );
  };

  const toggle = (next: 'reassign' | 'deadline') => {
    setErr('');
    setMode((m) => (m === next ? 'none' : next));
  };

  return (
    <SectionCard title="Administer">
      <Stack gap={2}>
        <Typography variant="body2" color="text.secondary">
          You administer this task. Each action below is recorded in its history under your name.
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={1.5}>
          <ActionCard
            title="Reassign"
            subtitle="Hand the task to a new audience."
            info="Replaces who may complete the task. The current audience is refused from then on; anyone eligible before who already acted keeps their record."
            selected={mode === 'reassign'}
            disabled={busy}
            onClick={() => toggle('reassign')}
          />
          <ActionCard
            title="Change Deadline"
            subtitle="Extend from now, or remove it."
            info="A new deadline is counted from now, replacing the one the task was created with. Clearing it leaves the task open until someone decides."
            selected={mode === 'deadline'}
            disabled={busy}
            onClick={() => toggle('deadline')}
          />
        </Stack>
        {err && (
          <Alert severity="error" onClose={() => setErr('')}>
            {err}
          </Alert>
        )}
        {mode === 'reassign' && (
          <Stack gap={1.5} sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 2 }}>
            <TextField id="reassign-roles" label="Roles" helperText="One per line. Anyone holding one of these may complete the task." value={userRoles} onChange={(e) => setUserRoles(e.target.value)} fullWidth size="small" multiline minRows={2} />
            <TextField id="reassign-users" label="Users" helperText="One user id per line." value={users} onChange={(e) => setUsers(e.target.value)} fullWidth size="small" multiline minRows={2} />
            <TextField id="reassign-excluded-roles" label="Excluded roles" value={excludedRoles} onChange={(e) => setExcludedRoles(e.target.value)} fullWidth size="small" multiline minRows={1} />
            <TextField id="reassign-excluded-users" label="Excluded users" value={excludedUsers} onChange={(e) => setExcludedUsers(e.target.value)} fullWidth size="small" multiline minRows={1} />
            <Stack direction="row" justifyContent="flex-end" gap={1}>
              <Button disabled={busy} onClick={() => setMode('none')}>
                Cancel
              </Button>
              <Button variant="contained" disabled={busy} onClick={submitReassign}>
                Reassign
              </Button>
            </Stack>
          </Stack>
        )}
        {mode === 'deadline' && (
          <Stack gap={1.5} sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 2 }}>
            <TextField id="deadline-minutes" label="Minutes from now" type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} size="small" sx={{ maxWidth: 240 }} />
            <Stack direction="row" justifyContent="flex-end" gap={1}>
              <Button disabled={busy} onClick={() => setMode('none')}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => submitDeadline(true)}>
                Clear deadline
              </Button>
              <Button variant="contained" disabled={busy} onClick={() => submitDeadline(false)}>
                Extend
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </SectionCard>
  );
}
