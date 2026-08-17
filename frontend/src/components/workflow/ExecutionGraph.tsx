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

import { alpha, Box, IconButton, Stack, Tooltip, Typography, useTheme } from '@wso2/oxygen-ui';
import { Clock, Play, X } from '@wso2/oxygen-ui-icons-react';
import { useMemo, useState } from 'react';
import type { ExecutionGraph, ExecutionGraphEdge, ExecutionGraphNode } from '../../api/workflows';
import CodeViewer from '../CodeViewer';
import { extractNodeExecutionDetail, formatDuration, humanizeKey, splitQualifiedName, type NodeExecutionDetail } from './helpers';
import { StatusChip } from './shared';
import { iconForType, paletteColor, statusColorName, typeLabel } from './graphVisuals';

// ── Layout constants (px). The graph flows top→bottom, one row per dependency layer, and each row is
// centred horizontally against the widest one so a linear run reads as a single centred column. ──
const NODE_W = 220;
const NODE_H = 66;
const V_GAP = 54; // vertical space between layers
const H_GAP = 32; // horizontal space between sibling nodes within a layer
const PAD = 24; // canvas padding around the node block
// Height of the start pill. It's laid out in a normal full-height slot but drawn at the bottom of it,
// so the edge leaving it — drawn from the slot's bottom edge — meets the pill exactly.
const START_H = 34;

// Id of the synthetic start node. Namespaced so it can't collide with a runtime-reported node id.
const START_NODE_ID = '__wf_start__';

interface PositionedNode extends ExecutionGraphNode {
  x: number;
  y: number;
}

interface Layout {
  nodes: PositionedNode[];
  edges: ExecutionGraphEdge[];
  width: number;
  height: number;
}

/**
 * Prepends a synthetic start node with an edge to every root (no incoming edge) node, so a run always
 * reads as beginning from one point at the top of the graph. It then becomes the only node with no
 * incoming edge, which is what puts it alone on the first row below — above the real first step(s).
 * (A cyclic graph has no roots, so it gets no edges and simply shares row 0; a DAG shouldn't have any.)
 * It's layout-only: it has no execution detail in the history and isn't selectable.
 */
function withStartNode(graph: ExecutionGraph): ExecutionGraph {
  const nodes = graph.nodes ?? [];
  if (nodes.some((n) => n.id === START_NODE_ID)) return graph;
  const ids = new Set(nodes.map((n) => n.id));
  // Mirror layoutDag's edge filtering, so an edge naming a missing node can't mask a real root.
  const hasIncoming = new Set((graph.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => e.target));
  const roots = nodes.filter((n) => !hasIncoming.has(n.id));

  return {
    nodes: [{ id: START_NODE_ID, label: 'Start', type: 'START' }, ...nodes],
    edges: [...roots.map((n) => ({ source: START_NODE_ID, target: n.id })), ...(graph.edges ?? [])],
  };
}

/**
 * Lays a DAG out into top→bottom layers using longest-path layering, then orders nodes within each
 * layer by the barycenter (mean position) of their already-placed predecessors to reduce edge
 * crossings. Cyclic/unreachable nodes (a DAG shouldn't have them) fall back to layer 0 so nothing is
 * dropped. Each layer is centred horizontally against the widest one.
 */
function layoutDag(graph: ExecutionGraph): Layout {
  const nodes = graph.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (graph.edges ?? []).filter((e) => byId.has(e.source) && byId.has(e.target));

  const succ = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  nodes.forEach((n) => {
    succ.set(n.id, []);
    preds.set(n.id, []);
    indeg.set(n.id, 0);
  });
  edges.forEach((e) => {
    succ.get(e.source)!.push(e.target);
    preds.get(e.target)!.push(e.source);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  });

  // Longest-path layering via Kahn's algorithm: a node sits one layer below its deepest parent.
  const layer = new Map<string, number>();
  const remaining = new Map(indeg);
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  queue.forEach((id) => layer.set(id, 0));
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const next = (layer.get(id) ?? 0) + 1;
    for (const t of succ.get(id) ?? []) {
      layer.set(t, Math.max(layer.get(t) ?? 0, next));
      remaining.set(t, (remaining.get(t) ?? 0) - 1);
      if ((remaining.get(t) ?? 0) === 0) queue.push(t);
    }
  }
  nodes.forEach((n) => {
    if (!layer.has(n.id)) layer.set(n.id, 0); // cycle guard: never drop a node
  });

  // Group by layer, preserving input order as the initial within-layer order.
  const layers = new Map<number, string[]>();
  nodes.forEach((n) => {
    const l = layer.get(n.id)!;
    (layers.get(l) ?? layers.set(l, []).get(l)!).push(n.id);
  });
  const maxLayer = Math.max(0, ...layers.keys());

  // Barycenter ordering, sweeping top→bottom so each layer sees final positions of the previous ones.
  const order = new Map<string, number>();
  for (let l = 0; l <= maxLayer; l++) {
    let ids = layers.get(l) ?? [];
    if (l > 0) {
      ids = ids
        .map((id, i) => {
          const ps = preds.get(id) ?? [];
          const placed = ps.map((p) => order.get(p)).filter((v): v is number => v !== undefined);
          const bary = placed.length ? placed.reduce((s, v) => s + v, 0) / placed.length : i;
          return { id, bary, i };
        })
        .sort((a, b) => a.bary - b.bary || a.i - b.i)
        .map((o) => o.id);
      layers.set(l, ids);
    }
    ids.forEach((id, i) => order.set(id, i));
  }

  const rowWidth = (count: number) => count * NODE_W + Math.max(0, count - 1) * H_GAP;
  const maxRowWidth = Math.max(NODE_W, ...[...layers.values()].map((ids) => rowWidth(ids.length)));

  const positioned: PositionedNode[] = [];
  for (let l = 0; l <= maxLayer; l++) {
    const ids = layers.get(l) ?? [];
    const xOffset = (maxRowWidth - rowWidth(ids.length)) / 2;
    ids.forEach((id, i) => {
      positioned.push({
        ...byId.get(id)!,
        x: PAD + xOffset + i * (NODE_W + H_GAP),
        y: PAD + l * (NODE_H + V_GAP),
      });
    });
  }

  return {
    nodes: positioned,
    edges,
    width: PAD * 2 + maxRowWidth,
    height: PAD * 2 + maxLayer * (NODE_H + V_GAP) + NODE_H,
  };
}

/** Cubic-bezier path from the bottom edge of the source node to the top edge of the target. */
function edgePath(s: PositionedNode, t: PositionedNode): string {
  const sx = s.x + NODE_W / 2;
  const sy = s.y + NODE_H;
  const tx = t.x + NODE_W / 2;
  const ty = t.y;
  const dy = Math.max(V_GAP * 0.6, (ty - sy) * 0.5);
  return `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`;
}

function GraphNodeCard({ node, selected, durationMs, onSelect }: { node: PositionedNode; selected: boolean; durationMs: number | null; onSelect: () => void }) {
  const theme = useTheme();
  const color = paletteColor(theme, statusColorName(node.status));
  // Only the task name is shown; the workflow qualifier is dropped because every node in a graph
  // belongs to the same workflow (shown in the drawer header), so it's redundant and made ACTIVITY
  // nodes read as the full `workflow-…` path while HUMAN_TASK nodes stayed short. The raw label
  // remains available in the tooltip.
  const { task } = splitQualifiedName(node.label);
  const Icon = iconForType(node.type);
  const subtitle = typeLabel(node.type);
  const tooltip = `${node.label}${node.status ? ` — ${humanizeKey(node.status.toLowerCase())}` : ''}`;

  return (
    <Tooltip title={tooltip} placement="top" arrow>
      <Box
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        sx={{
          position: 'absolute',
          left: node.x,
          top: node.y,
          width: NODE_W,
          height: NODE_H,
          boxSizing: 'border-box',
          px: 1.25,
          py: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          borderRadius: 1.5,
          border: '1px solid',
          borderColor: selected ? color : 'divider',
          borderLeft: `4px solid ${color}`,
          bgcolor: 'background.paper',
          boxShadow: selected ? 6 : 1,
          outline: selected ? `2px solid ${alpha(color, 0.5)}` : 'none',
          outlineOffset: 2,
          cursor: 'pointer',
          transition: 'box-shadow 0.15s, outline-color 0.15s',
          '&:hover': { boxShadow: 4 },
          // Keyboard focus must stay visible even when the node isn't selected, since `outline` is
          // otherwise 'none' for unselected nodes.
          '&:focus-visible': { outline: `2px solid ${color}`, boxShadow: 6 },
        }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 1, flexShrink: 0, color, bgcolor: alpha(color, 0.12) }}>
          <Icon size={18} />
        </Box>
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task ?? node.label}
          </Typography>
          <Stack direction="row" alignItems="center" gap={0.5} sx={{ minWidth: 0 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {subtitle}
            </Typography>
            {durationMs != null && (
              <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                <Clock size={11} />
                {formatDuration(durationMs)}
              </Typography>
            )}
          </Stack>
        </Stack>
        {node.status && <Box role="img" sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: color }} aria-label={node.status} />}
      </Box>
    </Tooltip>
  );
}

/**
 * The graph's entry marker: a compact, non-interactive pill (it has no step to inspect). Aligned to
 * the bottom of its layout slot so the arrow down to the first step starts at the pill's own edge.
 */
function StartNodeMarker({ node }: { node: PositionedNode }) {
  return (
    <Box sx={{ position: 'absolute', left: node.x, top: node.y, width: NODE_W, height: NODE_H, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <Stack direction="row" alignItems="center" gap={0.75} sx={{ height: START_H, px: 1.5, borderRadius: START_H / 2, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', color: 'text.secondary' }}>
        <Play size={13} />
        <Typography variant="caption" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {node.label}
        </Typography>
      </Stack>
    </Box>
  );
}

/** Side panel showing a selected node's execution time, input and result, mapped from the history. */
function NodeDetailPanel({ node, detail, hasHistory, onClose }: { node: ExecutionGraphNode; detail: NodeExecutionDetail; hasHistory: boolean; onClose: () => void }) {
  const { task } = splitQualifiedName(node.label);

  return (
    <Box sx={{ width: { xs: '100%', md: '45%' }, flexShrink: 0, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper', alignSelf: 'stretch' }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.label}>
            {task ?? node.label}
          </Typography>
          <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {typeLabel(node.type)}
            </Typography>
            {detail.status && <StatusChip status={detail.status} />}
            {detail.durationMs != null && (
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Clock size={13} />
                {formatDuration(detail.durationMs)}
              </Typography>
            )}
          </Stack>
        </Stack>
        <IconButton size="small" aria-label="close node details" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </Stack>

      <Stack gap={2} sx={{ p: 2 }}>
        {!hasHistory ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            History is not available, so this step's input and result can't be shown.
          </Typography>
        ) : (
          <>
            {detail.error && (
              <Box sx={{ px: 1.5, py: 1, borderRadius: 1, border: '1px solid', borderColor: 'error.main', color: 'error.main', bgcolor: (t) => alpha(t.palette.error.main, 0.08) }}>
                <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>
                  Error
                </Typography>
                <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                  {detail.error}
                </Typography>
              </Box>
            )}
            {detail.input !== null ? (
              <CodeViewer code={detail.input} language="json" title="Input" height="30vh" expandable showLineNumbers={false} />
            ) : (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                No input recorded for this step.
              </Typography>
            )}
            {detail.result !== null ? (
              <CodeViewer code={detail.result} language="json" title="Result" height="30vh" expandable showLineNumbers={false} />
            ) : (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {detail.status === 'COMPLETED' ? 'This step completed with no return value.' : detail.status ? 'No result — this step has not completed.' : 'No result recorded for this step.'}
              </Typography>
            )}
          </>
        )}
      </Stack>
    </Box>
  );
}

/**
 * Renders a workflow execution's dependency graph as a top→bottom, centre-aligned node-link DAG.
 * Clicking a node opens a side panel with that step's input and result, recovered from `events`
 * (the raw workflow history) by matching the node to its scheduled/initiated + close events.
 */
export default function ExecutionGraph({ graph, events = [] }: { graph: ExecutionGraph; events?: Array<Record<string, unknown>> }) {
  const theme = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Resolve each node's execution detail (input / result / status / duration) once from the history.
  const detailById = useMemo(() => new Map((graph.nodes ?? []).map((n) => [n.id, extractNodeExecutionDetail(n, events)])), [graph, events]);
  // Laid out once per graph so selecting a node doesn't re-run the layering pass.
  const layout = useMemo(() => layoutDag(withStartNode(graph)), [graph]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  if (!graph.nodes || graph.nodes.length === 0) {
    return <Typography sx={{ py: 4, textAlign: 'center', color: 'text.secondary' }}>No execution graph available.</Typography>;
  }

  const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  const selectedDetail = selectedNode ? detailById.get(selectedNode.id) : undefined;
  const edgeColor = theme.palette.text.disabled;
  const markerId = 'wf-graph-arrow';

  return (
    <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems="flex-start">
      <Box sx={{ flex: 1, minWidth: 0, border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'auto', maxHeight: '60vh', bgcolor: 'action.hover' }}>
        <Box sx={{ position: 'relative', width: layout.width, height: layout.height, mx: 'auto' }}>
          <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden>
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={edgeColor} />
              </marker>
            </defs>
            {layout.edges.map((e, i) => {
              const s = nodeById.get(e.source);
              const t = nodeById.get(e.target);
              if (!s || !t) return null;
              return <path key={i} d={edgePath(s, t)} fill="none" stroke={edgeColor} strokeWidth={1.5} markerEnd={`url(#${markerId})`} />;
            })}
          </svg>
          {layout.nodes.map((n) =>
            n.id === START_NODE_ID ? (
              <StartNodeMarker key={n.id} node={n} />
            ) : (
              <GraphNodeCard key={n.id} node={n} selected={n.id === selectedId} durationMs={detailById.get(n.id)?.durationMs ?? null} onSelect={() => setSelectedId((cur) => (cur === n.id ? null : n.id))} />
            ),
          )}
        </Box>
      </Box>
      {selectedNode && selectedDetail && <NodeDetailPanel node={selectedNode} detail={selectedDetail} hasHistory={events.length > 0} onClose={() => setSelectedId(null)} />}
    </Stack>
  );
}
