import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowNodeResult,
  WorkflowRunResult,
  WorkflowRunView,
  WorkflowStatus,
  WorkflowView,
} from '@pulse/contracts';
import { del, get, patch, post, sseStream } from '../lib/api.js';
import type { SseEvent } from '../lib/api.js';

export function listWorkflows(): Promise<WorkflowView[]> {
  return get('/workflows');
}

export function getWorkflow(id: string): Promise<WorkflowView> {
  return get(`/workflows/${id}`);
}

export function createWorkflow(input: CreateWorkflowInput): Promise<WorkflowView> {
  return post('/workflows', input);
}

export function updateWorkflow(id: string, input: UpdateWorkflowInput): Promise<WorkflowView> {
  return patch(`/workflows/${id}`, input);
}

export function setWorkflowStatus(id: string, status: WorkflowStatus): Promise<WorkflowView> {
  return patch(`/workflows/${id}/status`, { status });
}

export function deleteWorkflow(id: string): Promise<{ id: string }> {
  return del(`/workflows/${id}`);
}

/** 一次性运行（非流式） */
export function runWorkflow(workflowId: string, inputs: Record<string, unknown>): Promise<WorkflowRunResult> {
  return post('/workflows/run', { workflowId, inputs, stream: false });
}

/** 流式运行 —— SSE 事件迭代器 */
export function runWorkflowStream(
  workflowId: string,
  inputs: Record<string, unknown>,
): AsyncGenerator<SseEvent> {
  return sseStream('/workflows/run/stream', { workflowId, inputs });
}

export function listRuns(workflowId: string): Promise<WorkflowRunView[]> {
  return get(`/workflows/${workflowId}/runs`);
}

/** 运行结果 → 节点 id 到结果的映射（画布高亮用） */
export function nodeResultsMap(results: WorkflowNodeResult[]): Map<string, WorkflowNodeResult> {
  return new Map(results.map((r) => [r.nodeId, r]));
}
