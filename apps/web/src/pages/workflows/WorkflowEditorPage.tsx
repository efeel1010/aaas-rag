/**
 * 工作流编辑器 —— reactflow 画布 + 左侧节点面板 + 右侧属性面板 + 保存/运行测试。
 * 布局：上（工具栏）/ 左（节点面板）/ 中（画布）/ 右（属性面板）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CreateWorkflowInput, WorkflowStatus } from '@pulse/contracts';
import { useWorkflow, useCreateWorkflow, useUpdateWorkflow } from '../../hooks/useWorkflows.js';
import { useModels } from '../../hooks/useModels.js';
import { useDatasets } from '../../hooks/useDatasets.js';
import {
  NODE_TYPE_META,
  createRfNode,
  initialRfGraph,
  rfEdgesToInput,
  rfNodesToInput,
  validateGraph,
  viewEdgesToRf,
  viewNodesToRf,
  type RfEdge,
  type RfNode,
  type WorkflowEdgeData,
  type WorkflowNodeData,
  type WorkflowNodeType,
} from '../../lib/workflow.js';
import { WorkflowNode } from './WorkflowNode.js';
import { NodePalette } from './parts/NodePalette.js';
import { EdgePropertyPanel, NodePropertyPanel } from './parts/NodeConfigEditor.js';
import { RunTestModal } from './parts/RunTestModal.js';
import { Button } from '../../components/ui/Button.js';
import { Input, Select } from '../../components/ui/Input.js';
import { Badge, statusTone } from '../../components/ui/Badge.js';
import { Icon } from '../../components/ui/Icon.js';
import { FullPageLoader } from '../../components/ui/Spinner.js';
import { Modal } from '../../components/ui/Modal.js';
import { ApiCallLogs } from '../../components/ui/ApiCallLogs.js';
import { WorkflowRunHistory } from '../../components/ui/WorkflowRunHistory.js';
import { useToast } from '../../components/ui/Toast.js';

const nodeTypes = {
  start: WorkflowNode,
  llm: WorkflowNode,
  knowledge_retrieval: WorkflowNode,
  intent: WorkflowNode,
  condition: WorkflowNode,
  iteration: WorkflowNode,
  code: WorkflowNode,
  http_request: WorkflowNode,
  template: WorkflowNode,
  end: WorkflowNode,
};

const STATUS_OPTIONS: Array<{ value: WorkflowStatus; label: string }> = [
  { value: 'draft', label: '草稿' },
  { value: 'published', label: '发布' },
  { value: 'archived', label: '归档' },
];

function EditorInner() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = Boolean(id);

  const { data: wf, isLoading } = useWorkflow(id);
  const createMutation = useCreateWorkflow();
  const updateMutation = useUpdateWorkflow(id ?? '');
  const { data: models } = useModels();
  const { data: datasets } = useDatasets();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<WorkflowStatus>('draft');
  const [nodes, setNodes, onNodesChange] = useNodesState<RfNode>(initialRfGraph());
  const [edges, setEdges, onEdgesChange] = useEdgesState<RfEdge>([]);
  const [selectedNode, setSelectedNode] = useState<Node<WorkflowNodeData> | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge<WorkflowEdgeData> | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);

  const { screenToFlowPosition } = useReactFlow();

  // 编辑模式回显
  useEffect(() => {
    if (!wf) return;
    setName(wf.name);
    setDescription(wf.description ?? '');
    setStatus(wf.status);
    setNodes(viewNodesToRf(wf.nodes));
    setEdges(viewEdgesToRf(wf.edges));
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [wf]);

  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((eds) => addEdge({ ...conn, data: {} as WorkflowEdgeData }, eds));
    },
    [setEdges],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('application/reactflow') as WorkflowNodeType | '';
      if (!type) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const newNode = createRfNode(type, position);
      setNodes((nds) => nds.concat(newNode));
      setSelectedNode(newNode);
      setSelectedEdge(null);
    },
    [screenToFlowPosition, setNodes],
  );

  const updateNodeData = useCallback(
    (nodeId: string, patch: { label?: string; config?: Record<string, unknown> }) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
      setSelectedNode((prev) => (prev && prev.id === nodeId ? { ...prev, data: { ...prev.data, ...patch } } : prev));
    },
    [setNodes],
  );

  const updateEdgeCondition = useCallback(
    (edgeId: string, condition: Record<string, unknown> | undefined) => {
      setEdges((eds) =>
        eds.map((e) => (e.id === edgeId ? { ...e, data: condition ? { condition } : {} } : e)),
      );
      setSelectedEdge((prev) =>
        prev && prev.id === edgeId
          ? { ...prev, data: condition ? { condition } : {} }
          : prev,
      );
    },
    [setEdges],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNode(null);
    },
    [setNodes, setEdges],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      setEdges((eds) => eds.filter((e) => e.id !== edgeId));
      setSelectedEdge(null);
    },
    [setEdges],
  );

  const llmModels = useMemo(
    () =>
      (models ?? [])
        .filter((m) => m.modelType === 'llm' && m.status === 'active')
        .map((m) => ({ value: m.id, label: m.name })),
    [models],
  );
  const rerankModels = useMemo(
    () =>
      (models ?? [])
        .filter((m) => m.modelType === 'rerank' && m.status === 'active')
        .map((m) => ({ value: m.id, label: m.name })),
    [models],
  );
  const datasetOptions = useMemo(
    () =>
      (datasets ?? [])
        .filter((d) => d.status === 'active')
        .map((d) => ({ value: d.id, label: d.name })),
    [datasets],
  );

  const nodeNames = useMemo(
    () =>
      Object.fromEntries(
        nodes.map((n) => [n.id, { label: n.data.label, type: n.type ?? '' }]),
      ),
    [nodes],
  );
  const startNode = nodes.find((n) => n.type === 'start');
  const startInputs = useMemo(
    () =>
      ((startNode?.data.config.inputs ?? []) as Array<Record<string, unknown>>).map((f) => ({
        name: String(f.name ?? ''),
        label: f.label as string | undefined,
        type: f.type as string | undefined,
        required: f.required as boolean | undefined,
        default: f.default,
      })),
    [startNode],
  );

  const selectedEdgeSourceType = selectedEdge
    ? nodes.find((n) => n.id === selectedEdge.source)?.type ?? ''
    : '';

  const save = async () => {
    if (!name.trim()) {
      toast.error('请输入工作流名称');
      return;
    }
    const input: CreateWorkflowInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      status,
      nodes: rfNodesToInput(nodes),
      edges: rfEdgesToInput(edges),
    };
    const valid = validateGraph(input, isEdit);
    if (!valid.ok) {
      toast.error(`图校验失败：${valid.message}`);
      return;
    }
    try {
      if (isEdit && id) {
        const updated = await updateMutation.mutateAsync(input);
        toast.success(`工作流「${updated.name}」已保存`);
      } else {
        const created = await createMutation.mutateAsync(input);
        toast.success('工作流已创建');
        navigate(`/workflows/${created.id}`, { replace: true });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  if (isEdit && isLoading) return <FullPageLoader />;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      {/* 工具栏 */}
      <div className="flex h-auto min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2">
        <Link to="/workflows" className="flex shrink-0 items-center gap-1 text-[13px] text-ink-3 hover:text-ink">
          <Icon name="chevron-left" size={14} />
          工作流
        </Link>
        <div className="h-6 w-px shrink-0 bg-line-soft" />
        <div className="flex min-w-0 flex-[2] items-center gap-3">
          <Input
            className="h-8 min-w-0 flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="工作流名称"
          />
          <Input
            className="h-8 min-w-0 flex-[1.5]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
          />
        </div>
        <div className="w-28 shrink-0">
          <Select
            className="h-8"
            value={status}
            onChange={(e) => setStatus(e.target.value as WorkflowStatus)}
            options={STATUS_OPTIONS}
          />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Badge tone={statusTone(status)} dot>
            {STATUS_OPTIONS.find((s) => s.value === status)?.label}
          </Badge>
          <Button
            variant="secondary"
            icon={<Icon name="play" size={14} />}
            onClick={() => {
              if (!isEdit) {
                toast.info('请先保存工作流，再进行运行测试');
                return;
              }
              setRunOpen(true);
            }}
          >
            运行测试
          </Button>
          {isEdit && id && (
            <Button
              variant="secondary"
              icon={<Icon name="terminal" size={14} />}
              onClick={() => setLogsOpen(true)}
            >
              调用日志
            </Button>
          )}
          {isEdit && id && (
            <Button
              variant="secondary"
              icon={<Icon name="clock" size={14} />}
              onClick={() => setRunsOpen(true)}
            >
              运行历史
            </Button>
          )}
          <Button
            icon={<Icon name="check" size={14} />}
            onClick={save}
            loading={createMutation.isPending || updateMutation.isPending}
          >
            保存
          </Button>
        </div>
      </div>

      {/* 主体：左节点面板 / 画布 / 右属性面板 */}
      <div className="flex min-h-0 flex-1">
        <NodePalette />

        <div className="relative min-w-0 flex-1 bg-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => {
              setSelectedNode(n);
              setSelectedEdge(null);
            }}
            onEdgeClick={(_, e) => {
              setSelectedEdge(e);
              setSelectedNode(null);
            }}
            onPaneClick={() => {
              setSelectedNode(null);
              setSelectedEdge(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.3}
            maxZoom={2}
            defaultEdgeOptions={{ type: 'smoothstep', animated: false }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
            <Controls />
            <MiniMap
              pannable
              zoomable
              bgColor="var(--color-canvas)"
              maskColor="rgba(0,0,0,0.3)"
              nodeColor={(n) => NODE_TYPE_META[n.type as WorkflowNodeType]?.color ?? '#7c5cff'}
            />
          </ReactFlow>
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-surface/80 px-2 py-1 font-mono text-[11px] text-ink-3 backdrop-blur">
            {nodes.length} 节点 · {edges.length} 连线
          </div>
        </div>

        {/* 右侧属性面板 */}
        <div className="flex w-80 shrink-0 flex-col border-l border-line-soft bg-surface">
          <div className="border-b border-line-soft px-4 py-2.5 text-xs font-semibold text-ink-3">
            属性面板
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {selectedNode && (
              <NodePropertyPanel
                node={selectedNode}
                onChange={updateNodeData}
                onDelete={deleteNode}
                llmModels={llmModels}
                datasets={datasetOptions}
                rerankModels={rerankModels}
              />
            )}
            {selectedEdge && (
              <EdgePropertyPanel
                edge={selectedEdge}
                sourceType={selectedEdgeSourceType}
                onChange={updateEdgeCondition}
                onDelete={deleteEdge}
              />
            )}
            {!selectedNode && !selectedEdge && (
              <div className="space-y-3 py-6 text-center text-sm text-ink-3">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-ink-3">
                  <Icon name="box" size={22} />
                </span>
                <p>选择一个节点或连线<br />以编辑配置</p>
                <div className="rounded-lg bg-surface-2 p-3 text-left text-xs leading-relaxed text-ink-3">
                  从左侧面板拖入节点；从一个节点右侧端口拖到另一个节点左侧端口创建连线。
                  <br /><br />
                  <b className="text-ink-2">意图/条件节点</b>：选中其出边连线，在面板中配置分支条件。
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <RunTestModal
        open={runOpen}
        onClose={() => setRunOpen(false)}
        workflowId={id ?? ''}
        startInputs={startInputs}
        nodeNames={nodeNames}
      />

      <Modal
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        width="xl"
        title="API 调用日志"
        description="第三方通过独立 Token 调用本工作流的记录（调用方、时间、问答内容、成功失败）"
      >
        {id ? <ApiCallLogs resourceType="workflow" resourceId={id} /> : null}
      </Modal>

      <Modal
        open={runsOpen}
        onClose={() => setRunsOpen(false)}
        width="xl"
        title="运行历史（调用 Trace）"
        description="每次运行的节点级执行明细：输入/输出、各节点状态与耗时"
      >
        {id ? <WorkflowRunHistory workflowId={id} /> : null}
      </Modal>
    </div>
  );
}

export function WorkflowEditorPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  if (isEdit) {
    return (
      <ReactFlowProvider>
        <EditorInner />
      </ReactFlowProvider>
    );
  }
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}
