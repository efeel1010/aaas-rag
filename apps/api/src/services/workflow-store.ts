/**
 * Workflow 存储服务 —— workflows / workflow_nodes / workflow_edges / workflow_runs
 * 的 CRUD、启停与运行日志。
 *
 * 约定：
 *  - nodes / edges 以「整体提交」方式维护：create 全量插入，update 传数组即全量替换；
 *  - 节点 data 存 workflow_nodes.data；边的 condition 存 workflow_edges.data.condition；
 *  - workflows.graph 冗余一份完整图配置（nodes/edges），主数据仍在 nodes/edges；
 *  - 运行（run）仅在 status=published 时放行，运行结果落 workflow_runs。
 */
import { eq } from 'drizzle-orm';
import { workflowEdges, workflowNodes, workflowRuns, workflows } from '@pulse/db';
import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowEdgeCondition,
  WorkflowNodeType,
  WorkflowRunResult,
  WorkflowRunView,
  WorkflowStatus,
  WorkflowView,
} from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { WorkflowEdgeDefinition, WorkflowGraphDefinition, WorkflowNodeDefinition } from './workflow-engine/types.js';

type WorkflowRow = typeof workflows.$inferSelect;
type WorkflowNodeRow = typeof workflowNodes.$inferSelect;
type WorkflowEdgeRow = typeof workflowEdges.$inferSelect;
type WorkflowRunRow = typeof workflowRuns.$inferSelect;

/** 边 condition 从 data 列还原（data = { condition }） */
function edgeConditionOf(row: WorkflowEdgeRow): WorkflowEdgeCondition | null {
  const data = row.data as { condition?: WorkflowEdgeCondition } | null;
  return data?.condition ?? null;
}

function toNodeView(row: WorkflowNodeRow): WorkflowView['nodes'][number] {
  return {
    id: row.id,
    workflowId: row.workflowId,
    type: row.type as WorkflowNodeType,
    name: row.name,
    data: row.data,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEdgeView(row: WorkflowEdgeRow): WorkflowView['edges'][number] {
  return {
    id: row.id,
    workflowId: row.workflowId,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    sourceHandle: row.sourceHandle,
    targetHandle: row.targetHandle,
    condition: edgeConditionOf(row),
    createdAt: row.createdAt.toISOString(),
  };
}

function toView(row: WorkflowRow, nodes: WorkflowNodeRow[], edges: WorkflowEdgeRow[]): WorkflowView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as WorkflowStatus,
    version: row.version,
    nodes: nodes.map(toNodeView),
    edges: edges.map(toEdgeView),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toGraphDefinition(row: WorkflowRow, nodes: WorkflowNodeRow[], edges: WorkflowEdgeRow[]): WorkflowGraphDefinition {
  return {
    id: row.id,
    name: row.name,
    status: row.status as WorkflowStatus,
    nodes: nodes.map(
      (n): WorkflowNodeDefinition => ({
        id: n.id,
        type: n.type as WorkflowNodeType,
        name: n.name,
        data: n.data,
      }),
    ),
    edges: edges.map(
      (e): WorkflowEdgeDefinition => ({
        id: e.id,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
        condition: edgeConditionOf(e),
      }),
    ),
  };
}

async function findRow(id: string): Promise<WorkflowRow> {
  const rows = await getDb().select().from(workflows).where(eq(workflows.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('工作流', id);
  return row;
}

async function findNodes(workflowId: string): Promise<WorkflowNodeRow[]> {
  return getDb().select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
}

async function findEdges(workflowId: string): Promise<WorkflowEdgeRow[]> {
  return getDb().select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId));
}

/** 全量替换节点与边（create / update 共用） */
async function replaceGraph(workflowId: string, input: CreateWorkflowInput): Promise<void> {
  await getDb().delete(workflowEdges).where(eq(workflowEdges.workflowId, workflowId));
  await getDb().delete(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
  if (input.nodes.length > 0) {
    await getDb().insert(workflowNodes).values(
      input.nodes.map((n) => ({
        id: n.id,
        workflowId,
        type: n.type,
        name: n.name ?? null,
        data: n.data as unknown as Record<string, unknown>,
        position: n.position,
      })),
    );
  }
  if (input.edges.length > 0) {
    await getDb().insert(workflowEdges).values(
      input.edges.map((e) => ({
        id: e.id,
        workflowId,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
        data: e.condition !== undefined ? { condition: e.condition } : null,
      })),
    );
  }
  await getDb()
    .update(workflows)
    .set({ graph: { nodes: input.nodes, edges: input.edges }, updatedAt: new Date() })
    .where(eq(workflows.id, workflowId));
}

export const workflowStore = {
  async list(): Promise<WorkflowView[]> {
    const rows = await getDb().select().from(workflows).orderBy(workflows.createdAt);
    const views: WorkflowView[] = [];
    for (const row of rows) {
      const [nodes, edges] = await Promise.all([findNodes(row.id), findEdges(row.id)]);
      views.push(toView(row, nodes, edges));
    }
    return views;
  },

  async get(id: string): Promise<WorkflowView> {
    const row = await findRow(id);
    const [nodes, edges] = await Promise.all([findNodes(id), findEdges(id)]);
    return toView(row, nodes, edges);
  },

  async create(input: CreateWorkflowInput): Promise<WorkflowView> {
    const inserted = await getDb()
      .insert(workflows)
      .values({
        name: input.name,
        description: input.description,
        status: input.status ?? 'draft',
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('创建工作流失败');
    await replaceGraph(row.id, input);
    return this.get(row.id);
  },

  async update(id: string, patch: UpdateWorkflowInput): Promise<WorkflowView> {
    const existing = await findRow(id);
    const data: Partial<typeof workflows.$inferInsert> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.status !== undefined) data.status = patch.status;
    // 图结构「整体替换」：nodes / edges 任一提供即视为图变更，未提供的一侧沿用现有图
    const hasGraph = patch.nodes !== undefined || patch.edges !== undefined;
    // 图结构或状态变更时版本号 +1
    const nextVersion = hasGraph || patch.status !== undefined ? existing.version + 1 : existing.version;
    await getDb()
      .update(workflows)
      .set({ ...data, version: nextVersion, updatedAt: new Date() })
      .where(eq(workflows.id, id));
    if (hasGraph) {
      const currentNodes = await findNodes(id);
      const currentEdges = await findEdges(id);
      const nodes: CreateWorkflowInput['nodes'] =
        patch.nodes !== undefined
          ? (patch.nodes as CreateWorkflowInput['nodes'])
          : (currentNodes.map((n) => ({
              id: n.id,
              type: n.type as WorkflowNodeType,
              name: n.name ?? undefined,
              data: n.data ?? {},
              position: (n.position as { x: number; y: number }) ?? undefined,
            })) as unknown as CreateWorkflowInput['nodes']);
      const edges: CreateWorkflowInput['edges'] =
        patch.edges !== undefined
          ? (patch.edges as CreateWorkflowInput['edges'])
          : (currentEdges.map((e) => ({
              id: e.id,
              sourceNodeId: e.sourceNodeId,
              targetNodeId: e.targetNodeId,
              sourceHandle: e.sourceHandle ?? undefined,
              targetHandle: e.targetHandle ?? undefined,
              condition: edgeConditionOf(e) ?? undefined,
            })) as unknown as CreateWorkflowInput['edges']);
      await replaceGraph(id, {
        name: existing.name,
        description: existing.description ?? undefined,
        nodes,
        edges,
      } as unknown as CreateWorkflowInput);
    }
    return this.get(id);
  },

  async remove(id: string): Promise<{ id: string }> {
    await findRow(id);
    // workflow_nodes / workflow_edges / workflow_runs 由 FK cascade 清理
    await getDb().delete(workflows).where(eq(workflows.id, id));
    return { id };
  },

  /** 启停：设置状态（draft / published / archived），版本号 +1 */
  async setStatus(id: string, status: WorkflowStatus): Promise<WorkflowView> {
    const row = await findRow(id);
    if (row.status === status) return this.get(id);
    await getDb()
      .update(workflows)
      .set({ status, version: row.version + 1, updatedAt: new Date() })
      .where(eq(workflows.id, id));
    return this.get(id);
  },

  /**
   * 运行入口：装配可执行图定义。
   * 仅 published 放行（draft 未定稿 / archived 已下线不允许运行）。
   */
  async loadGraphForRun(id: string): Promise<WorkflowGraphDefinition> {
    const row = await findRow(id);
    if (row.status !== 'published') {
      throw new ConflictError(`工作流「${row.name}」当前为 ${row.status}，仅 published 状态可运行`);
    }
    const [nodes, edges] = await Promise.all([findNodes(id), findEdges(id)]);
    return toGraphDefinition(row, nodes, edges);
  },

  // ---------------- 运行日志 ----------------

  async recordRun(result: WorkflowRunResult): Promise<void> {
    await getDb().insert(workflowRuns).values({
      id: result.runId,
      workflowId: result.workflowId,
      status: result.status,
      inputs: result.inputs,
      outputs: result.outputs,
      nodeResults: result.nodeResults,
      error: result.error,
      durationMs: result.durationMs,
    });
  },

  async listRuns(workflowId: string): Promise<WorkflowRunView[]> {
    await findRow(workflowId);
    const rows = await getDb()
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId))
      .orderBy(workflowRuns.createdAt);
    return rows.map(toRunView);
  },

  async getRun(runId: string): Promise<WorkflowRunView> {
    const rows = await getDb().select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('工作流运行记录', runId);
    return toRunView(row);
  },
};

function toRunView(row: WorkflowRunRow): WorkflowRunView {
  return {
    runId: row.id,
    workflowId: row.workflowId,
    status: row.status as 'success' | 'failed',
    inputs: row.inputs,
    outputs: row.outputs ?? {},
    nodeResults: (row.nodeResults as WorkflowRunView['nodeResults']) ?? [],
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    durationMs: row.durationMs,
  };
}
