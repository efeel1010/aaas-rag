/**
 * 工作流「运行历史 Trace」 —— 列出历史运行，展开查看节点级执行明细。
 *
 * 数据链路：GET /workflows/:id/runs（已有端点），nodeResults 为节点级 Trace。
 */
import { useCallback, useEffect, useState } from 'react';
import type { WorkflowRunView } from '@pulse/contracts';
import { listRuns } from '../../api/workflows.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { EmptyState } from './EmptyState.js';
import { cn, formatTime } from '../../lib/format.js';

const NODE_TYPE_LABEL: Record<string, string> = {
  start: '开始',
  llm: 'LLM',
  knowledge_retrieval: '知识检索',
  intent: '意图判断',
  condition: '条件分支',
  iteration: '迭代',
  code: '代码',
  http_request: 'HTTP',
  template: '模板',
  end: '结束',
};

/** 节点明细行 */
function NodeTrace({ node }: { node: WorkflowRunView['nodeResults'][number] }) {
  const [open, setOpen] = useState(false);
  const ok = node.status === 'success';
  const duration = node.startedAt && node.endedAt
    ? Math.max(0, new Date(node.endedAt).getTime() - new Date(node.startedAt).getTime())
    : null;
  return (
    <div
      className={cn(
        'rounded-lg border bg-surface-2/60',
        ok ? 'border-line' : 'border-danger/40',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Badge tone={ok ? 'success' : 'danger'} dot>
          {ok ? '成功' : '失败'}
        </Badge>
        <span className="text-[13px] font-medium text-ink">{node.name ?? node.nodeId}</span>
        <span className="text-[11px] text-ink-3">{NODE_TYPE_LABEL[node.type] ?? node.type}</span>
        <span className="ml-auto text-[11px] font-mono text-ink-3">
          {duration !== null ? `${duration} ms` : ''}
        </span>
        <Icon name="chevron-down" size={12} className={cn('text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line-soft px-3 py-2.5">
          {node.error && <p className="text-xs text-danger">错误：{node.error}</p>}
          <pre className="max-h-56 overflow-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
            {JSON.stringify(node.output ?? {}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function WorkflowRunHistory({ workflowId }: { workflowId: string }) {
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await listRuns(workflowId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-14 text-sm text-ink-3">
        <Spinner size={16} /> 加载运行记录…
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon="alert"
        title="加载失败"
        description={error}
        action={<Button variant="secondary" onClick={() => void load()}>重试</Button>}
      />
    );
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        icon="terminal"
        title="暂无运行记录"
        description="在「运行测试」中执行工作流后，这里会记录每次运行的节点级执行明细（调用 Trace）。"
      />
    );
  }

  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <div key={run.runId} className="overflow-hidden rounded-xl border border-line bg-surface">
          <button
            type="button"
            onClick={() => setExpandedRun((cur) => (cur === run.runId ? null : run.runId))}
            className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/50"
          >
            <Badge tone={run.status === 'success' ? 'success' : 'danger'} dot>
              {run.status === 'success' ? '成功' : '失败'}
            </Badge>
            <span className="text-xs text-ink-3">{formatTime(run.createdAt)}</span>
            <span className="font-mono text-[11px] text-ink-3">run {run.runId.slice(0, 8)}</span>
            <span className="ml-auto flex items-center gap-3 text-[11px] text-ink-3">
              <span>节点 {run.nodeResults.length}</span>
              <span>{Math.round(run.durationMs)} ms</span>
              <Icon name="chevron-down" size={12} className={cn('transition-transform', expandedRun === run.runId && 'rotate-180')} />
            </span>
          </button>

          {expandedRun === run.runId && (
            <div className="border-t border-line-soft px-4 py-3">
              {run.error && <p className="mb-2 text-xs text-danger">错误：{run.error}</p>}
              {/* 输入输出 */}
              <div className="mb-3 grid gap-3 lg:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] font-medium text-ink-3">输入 inputs</div>
                  <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
                    {JSON.stringify(run.inputs ?? {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 text-[11px] font-medium text-ink-3">输出 outputs</div>
                  <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
                    {JSON.stringify(run.outputs ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
              {/* 节点级 Trace */}
              <div className="mb-1 text-[11px] font-medium text-ink-3">节点执行明细（{run.nodeResults.length}）</div>
              <div className="space-y-1.5">
                {run.nodeResults.length === 0 && (
                  <p className="py-2 text-xs text-ink-3">无节点明细</p>
                )}
                {run.nodeResults.map((n) => (
                  <NodeTrace key={n.nodeId} node={n} />
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}