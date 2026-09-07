/**
 * workflows / workflow_nodes / workflow_edges / workflow_runs —— 工作流 DAG 与运行日志。
 */
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** draft | published | archived */
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  /** 兜底存放完整的图配置（冗余，主数据在 nodes/edges） */
  graph: jsonb('graph').$type<Record<string, unknown>>(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 工作流节点。id 使用 text 作为 DAG 内唯一键（对应前端画布节点的 id），
 * 与 workflow_edges 的 sourceNodeId / targetNodeId 直接对齐。
 */
export const workflowNodes = pgTable(
  'workflow_nodes',
  {
    /** DAG 内唯一键（与 edges 的 sourceNodeId/targetNodeId 对齐）；跨工作流可复用（复合主键） */
    id: text('id').notNull(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** start | llm | knowledge_retrieval | question_classifier | code | end ... */
    type: text('type').notNull(),
    name: text('name'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    /** 画布坐标 { x, y } */
    position: jsonb('position').$type<{ x: number; y: number }>(),
    configVersion: integer('config_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 复合主键 (workflow_id, id)：节点 id 只需在工作流内唯一，跨工作流可复用
    // （若 id 为全局单列主键，则不同工作流使用相同 id（n1/e1）会冲突）。
    primaryKey({ columns: [table.workflowId, table.id] }),
    index('workflow_nodes_workflow_id_idx').on(table.workflowId),
  ],
);

export const workflowEdges = pgTable(
  'workflow_edges',
  {
    id: text('id').notNull(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id').notNull(),
    targetNodeId: text('target_node_id').notNull(),
    sourceHandle: text('source_handle'),
    targetHandle: text('target_handle'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 复合主键 (workflow_id, id)：边 id 只需在工作流内唯一，跨工作流可复用
    primaryKey({ columns: [table.workflowId, table.id] }),
    index('workflow_edges_workflow_id_idx').on(table.workflowId),
  ],
);

/**
 * 工作流运行日志（每次 /run 或 /run/stream 执行记录一次）。
 * 节点级明细存 node_results（jsonb），便于回放与观测。
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** success | failed */
    status: text('status').notNull().default('success'),
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),
    outputs: jsonb('outputs').$type<Record<string, unknown>>(),
    nodeResults: jsonb('node_results').$type<unknown[]>(),
    error: text('error'),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('workflow_runs_workflow_id_idx').on(table.workflowId)],
);