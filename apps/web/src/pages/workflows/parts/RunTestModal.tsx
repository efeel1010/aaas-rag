/**
 * 工作流运行测试面板 —— 左侧对话框 + 右侧流程流转/状态。
 *  - 左：SSE 流式对话（样式复用 Agent 对话框），每轮一条用户消息 + 一条助手结果消息；
 *  - 右：当前选中轮的节点链路流转（节点时序 + 状态 + 最终输出）；
 *  - 多轮：历史作为 `history` 变量传入工作流（llm 节点 prompt 可用 {{history}} 引用）；
 *  - 支持全屏展开 / 收起。
 */
import { useEffect, useRef, useState } from 'react';
import type { WorkflowNodeResult, WorkflowNodeType } from '@pulse/contracts';
import { runWorkflowStream } from '../../../api/workflows.js';
import { Modal } from '../../../components/ui/Modal.js';
import { Input, Textarea } from '../../../components/ui/Input.js';
import { Button } from '../../../components/ui/Button.js';
import { Badge } from '../../../components/ui/Badge.js';
import { Icon } from '../../../components/ui/Icon.js';
import { Spinner } from '../../../components/ui/Spinner.js';
import { JsonView } from '../../../components/ui/JsonView.js';
import { Card } from '../../../components/ui/Table.js';
import { useToast } from '../../../components/ui/Toast.js';
import { NODE_TYPE_META } from '../../../lib/workflow.js';
import { cn } from '../../../lib/format.js';

interface RunTestModalProps {
  open: boolean;
  onClose: () => void;
  workflowId: string;
  /** start 节点声明的输入字段 */
  startInputs: Array<{ name: string; label?: string; type?: string; required?: boolean; default?: unknown }>;
  /** 节点名映射（展示链路用） */
  nodeNames: Record<string, { label: string; type: string }>;
}

interface NodeResultView {
  nodeId: string;
  name: string | null;
  type: string;
  status: 'success' | 'error';
  output: Record<string, unknown> | null;
  error: string | null;
}

/** 一轮对话：用户输入 + 工作流节点链路 + 最终输出 */
interface ChatTurn {
  id: string;
  query: string;
  results: NodeResultView[];
  outputs: Record<string, unknown> | null;
  error: string | null;
  running: boolean;
}

const nextId = (() => {
  let n = 0;
  return () => `turn-${Date.now()}-${++n}`;
})();

/** 由历史轮次生成供工作流消费的 history 变量（[{role, content}]） */
function buildHistory(turns: ChatTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns
    .filter((t) => !t.running && !t.error)
    .flatMap((t) => {
      const user: { role: 'user'; content: string } = { role: 'user', content: t.query };
      const content = t.outputs && Object.keys(t.outputs).length > 0 ? JSON.stringify(t.outputs) : '';
      const asst: { role: 'assistant'; content: string } = { role: 'assistant', content };
      return content ? [user, asst] : [user];
    });
}

/**
 * 把工作流输出渲染为「可读状态」在对话框中展示。
 * 优先展示主文本字段（report / answer / output / text / content / result）的完整内容，
 * 其余字段折叠展示；空输出给出提示。
 */
function ReadableOutputs({ outputs }: { outputs: Record<string, unknown> | null }) {
  if (!outputs || Object.keys(outputs).length === 0) {
    return <p className="text-[13px] text-ink-3">完成（无输出）</p>;
  }

  const entries = Object.entries(outputs);
  const MAIN_TEXT = ['report', 'answer', 'output', 'text', 'content', 'result', 'summary'];
  const mainIdx = entries.findIndex(([k, v]) => MAIN_TEXT.includes(k) && typeof v === 'string' && (v as string).trim().length > 0);
  const hasMain = mainIdx >= 0;

  // 主文本字段：完整展示
  if (hasMain) {
    const [key, value] = entries[mainIdx]!;
    const rest = entries.filter((_, i) => i !== mainIdx && value !== undefined && value !== null);
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-line-soft bg-surface p-2.5">
          <div className="mb-1 text-[11px] font-semibold text-ink-3">{key}</div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{value as string}</p>
        </div>
        {rest.length > 0 && (
          <div className="border-t border-dashed border-line pt-2">
            {rest.map(([k, v]) => (
              <div key={k} className="mb-1.5 last:mb-0">
                <div className="mb-0.5 text-[11px] font-medium text-ink-3">{k}</div>
                {typeof v === 'string' ? (
                  <p className="whitespace-pre-wrap text-[13px] text-ink-3">{v}</p>
                ) : (
                  <JsonView value={v} label={k} defaultCollapsed maxHeight={120} className="border-0 bg-transparent" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // 无主文本字段：逐字段可读展示
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k}>
          <div className="mb-0.5 text-[11px] font-medium text-ink-3">{k}</div>
          {typeof v === 'string' ? (
            <p className="whitespace-pre-wrap rounded-md bg-surface px-2.5 py-1.5 text-[13px] text-ink-2">{v}</p>
          ) : (
            <JsonView value={v} label={k} defaultCollapsed maxHeight={160} />
          )}
        </div>
      ))}
    </div>
  );
}

export function RunTestModal({ open, onClose, workflowId, startInputs, nodeNames }: RunTestModalProps) {
  const toast = useToast();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      const init: Record<string, string> = {};
      for (const f of startInputs) {
        if (f.default !== undefined && f.default !== null) init[f.name] = String(f.default);
        else init[f.name] = '';
      }
      setInputs(init);
      setQuery('');
      setTurns([]);
      setActiveTurnId(null);
    }
  }, [open, startInputs]);

  // 新消息出现时自动滚到底部
  useEffect(() => {
    chatBoxRef.current?.scrollTo({ top: chatBoxRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const patchTurn = (id: string, patch: Partial<ChatTurn>) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const run = async () => {
    if (running) return;
    const q = query.trim();
    if (!q) {
      toast.error('请输入对话内容');
      return;
    }
    // 必填校验：跳过名为 query 的字段（由上方大输入框校验），避免与独立 query state 冲突
    for (const f of startInputs) {
      if (f.name === 'query') continue;
      if (f.required && !String(inputs[f.name] ?? '').trim()) {
        toast.error(`请填写输入字段「${f.name}」`);
        return;
      }
    }
    const payload: Record<string, unknown> = {};
    for (const f of startInputs) {
      if (f.name === 'query') continue; // query 由大输入框注入
      const raw = String(inputs[f.name] ?? '').trim();
      if (raw === '' && !f.required) continue;
      if (f.type === 'number') payload[f.name] = Number(raw);
      else if (f.type === 'boolean') payload[f.name] = raw === 'true';
      else payload[f.name] = raw;
    }
    payload.query = q;
    // 多轮上下文：把已完成的历史轮次注入 history 变量
    payload.history = buildHistory(turns);

    const turnId = nextId();
    setActiveTurnId(turnId);
    setRunning(true);
    setQuery('');
    setTurns((prev) => [...prev, { id: turnId, query: q, results: [], outputs: null, error: null, running: true }]);
    try {
      const collected: NodeResultView[] = [];
      for await (const evt of runWorkflowStream(workflowId, payload)) {
        if (evt.event === 'node_end') {
          const d = evt.data;
          collected.push({
            nodeId: String(d.nodeId ?? ''),
            name: (d.name as string | null) ?? null,
            type: String(d.nodeType ?? ''),
            status: d.status === 'error' ? 'error' : 'success',
            output: (d.output as Record<string, unknown> | null) ?? null,
            error: (d.error as string | null) ?? null,
          });
          patchTurn(turnId, { results: [...collected] });
        } else if (evt.event === 'done') {
          const d = evt.data;
          const nodeResults = d.nodeResults as WorkflowNodeResult[] | undefined;
          const finalResults = Array.isArray(nodeResults)
            ? nodeResults.map((r) => ({
                nodeId: r.nodeId,
                name: r.name,
                type: r.type,
                status: r.status,
                output: r.output,
                error: r.error,
              }))
            : collected;
          patchTurn(turnId, {
            results: finalResults,
            outputs: (d.outputs as Record<string, unknown>) ?? null,
            running: false,
          });
        } else if (evt.event === 'error') {
          patchTurn(turnId, { error: (evt.data.message as string) ?? '运行失败', running: false });
        }
      }
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, running: false } : t)));
    } catch (e) {
      patchTurn(turnId, { error: e instanceof Error ? e.message : '运行失败', running: false });
    } finally {
      setRunning(false);
    }
  };

  const stopStream = () => {
    setRunning(false);
    setTurns((prev) => prev.map((t) => (t.running ? { ...t, running: false } : t)));
  };

  const clearAll = () => {
    setTurns([]);
    setActiveTurnId(null);
    toast.success('已清空对话');
  };

  const activeTurn = turns.find((t) => t.id === activeTurnId) ?? turns[turns.length - 1];

  const leftPanel = (
    <Card padded={false} className={cn('flex flex-col overflow-hidden', fullscreen ? 'h-full' : 'h-[62vh] min-h-[420px]')}>
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
        <span className="text-xs text-ink-3">SSE 流式对话 · 多轮</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={clearAll} disabled={running || turns.length === 0}>
            <Icon name="trash" size={13} />
            清空
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFullscreen(true)} icon={<Icon name="maximize" size={13} />}>
            全屏
          </Button>
        </div>
      </div>

      <div ref={chatBoxRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
              <Icon name="workflow" size={22} />
            </span>
            <p className="text-sm font-medium text-ink-2">开始工作流对话测试</p>
            <p className="max-w-xs text-xs text-ink-3">
              输入问题后触发工作流执行，右侧实时展示节点流转与最终输出。
            </p>
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-2">
            {/* 用户消息 */}
            <div className="flex justify-end">
              <div
                className="max-w-[85%] cursor-pointer rounded-xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-white"
                onClick={() => setActiveTurnId(t.id)}
              >
                <p className="whitespace-pre-wrap">{t.query}</p>
              </div>
            </div>
            {/* 助手结果：展示运行状态摘要，右侧详看流程 */}
            <div className="flex justify-start">
              <div
                className={cn(
                  'w-full max-w-[85%] cursor-pointer rounded-xl rounded-bl-sm border px-3.5 py-2.5 text-sm leading-relaxed',
                  t.running
                    ? 'border-line bg-surface-2 text-ink-2'
                    : t.error || t.results.some((r) => r.status === 'error')
                      ? 'border-danger/40 bg-danger-soft text-danger'
                      : 'border-line bg-surface-2 text-ink-2',
                  activeTurnId === t.id && 'ring-1 ring-primary/40',
                )}
                onClick={() => setActiveTurnId(t.id)}
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={t.running ? 'warning' : t.error || t.results.some((r) => r.status === 'error') ? 'danger' : 'success'}>
                    {t.running ? '运行中' : t.error || t.results.some((r) => r.status === 'error') ? '失败' : '成功'}
                  </Badge>
                  <Badge tone="info">{t.results.length} 个节点</Badge>
                  {t.results.some((r) => r.status === 'error') && (
                    <span className="text-xs text-danger">存在失败节点</span>
                  )}
                </div>
                {t.running ? (
                  <span className="flex items-center gap-1.5 text-ink-3">
                    <Spinner size={13} />
                    工作流执行中…
                  </span>
                ) : t.error ? (
                  <p className="whitespace-pre-wrap text-[13px] text-danger">{t.error}</p>
                ) : (
                  <ReadableOutputs outputs={t.outputs} />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-line-soft p-3">
        {/* 参数输入区：跳过名为 query 的字段 —— 大输入框即 query 输入，避免重复 */}
        {startInputs.filter((f) => f.name !== 'query').length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-ink-3">输入参数（Inputs）</span>
            {startInputs
              .filter((f) => f.name !== 'query')
              .map((f) => (
                <div key={f.name} className="w-32">
                  <Input
                    size="sm"
                    value={inputs[f.name] ?? ''}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [f.name]: e.target.value }))}
                    placeholder={f.label ?? f.name}
                  />
                </div>
              ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (running) stopStream();
                else void run();
              }
            }}
            placeholder="输入问题，触发工作流…（Enter 发送，Shift+Enter 换行）"
            className="resize-none"
          />
          {running ? (
            <Button onClick={stopStream} variant="danger" icon={<Icon name="stop" size={15} />}>
              停止
            </Button>
          ) : (
            <Button onClick={() => void run()} icon={<Icon name="send" size={15} />}>
              发送
            </Button>
          )}
        </div>
      </div>
    </Card>
  );

  const rightPanel = (
    <Card padded={false} className={cn('flex flex-col overflow-hidden', fullscreen ? 'h-full' : 'h-[62vh] min-h-[420px]')}>
      <div className="border-b border-line-soft px-4 py-2.5 text-xs font-semibold text-ink-3">
        流程流转 · 节点状态
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {!activeTurn ? (
          <p className="flex h-full items-center justify-center rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-ink-3">
            选择左侧任一对话，查看该轮的工作流节点流转与最终输出
          </p>
        ) : (
          <>
            {/* 运行状态汇总 */}
            <div className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-3 py-2">
              <span className="text-xs text-ink-3">本轮执行</span>
              <Badge
                tone={activeTurn.running ? 'warning' : activeTurn.error || activeTurn.results.some((r) => r.status === 'error') ? 'danger' : 'success'}
              >
                {activeTurn.running ? '运行中' : activeTurn.error || activeTurn.results.some((r) => r.status === 'error') ? '部分失败' : '全部成功'}
              </Badge>
            </div>

            {/* 节点链路（竖排时序） */}
            <div className="space-y-1">
              {activeTurn.results.length === 0 && activeTurn.running && (
                <div className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface-2 px-3 py-3 text-xs text-ink-3">
                  <Spinner size={12} />
                  等待节点流转…
                </div>
              )}
              {activeTurn.results.map((r, i) => {
                const meta = NODE_TYPE_META[r.type as WorkflowNodeType];
                const nm = nodeNames[r.nodeId];
                const label = r.name || nm?.label || meta?.label || r.nodeId;
                return (
                  <div key={`${r.nodeId}-${i}`} className="relative flex gap-2.5 pl-1">
                    {/* 竖线连接 */}
                    {i < activeTurn.results.length - 1 && (
                      <span className="absolute left-[19px] top-8 h-[calc(100%-20px)] w-px bg-line-soft" />
                    )}
                    <span
                      className={cn(
                        'z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                        r.status === 'success'
                          ? 'border-success/30 bg-success-soft text-success'
                          : 'border-danger/30 bg-danger-soft text-danger',
                      )}
                    >
                      <Icon name={meta?.icon ?? 'box'} size={14} />
                    </span>
                    <div className="min-w-0 flex-1 rounded-lg border border-line-soft bg-surface-2 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                          {i + 1}. {label}
                        </span>
                        <Badge tone={r.status === 'success' ? 'success' : 'danger'}>
                          {r.status === 'success' ? '成功' : '失败'}
                        </Badge>
                      </div>
                      {r.error && <p className="mt-1 text-[11px] leading-relaxed text-danger">{r.error}</p>}
                      {r.output && Object.keys(r.output).length > 0 && (
                        <div className="mt-1.5">
                          <JsonView
                            value={r.output}
                            label="output"
                            defaultCollapsed
                            maxHeight={fullscreen ? 220 : 140}
                            className="border-0 bg-transparent"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 最终输出 */}
            {activeTurn.outputs && Object.keys(activeTurn.outputs).length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-semibold text-ink-3">最终输出（Outputs）</div>
                <JsonView value={activeTurn.outputs} label="outputs" maxHeight={fullscreen ? 280 : 200} />
              </div>
            )}
            {activeTurn.error && (
              <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-sm text-danger">
                运行错误：{activeTurn.error}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );

  // 全屏模式：脱离 Modal，用全屏容器渲染
  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-canvas">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line-soft bg-surface px-4">
          <div className="text-sm font-semibold text-ink">工作流运行测试（全屏）</div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearAll} disabled={running || turns.length === 0}>
              <Icon name="trash" size={13} />
              清空
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFullscreen(false)} icon={<Icon name="minimize" size={14} />}>
              收起
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>
              关闭
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 p-4">
          <div className="mx-auto grid h-full max-w-6xl gap-4 lg:grid-cols-[1fr_340px]">{leftPanel}{rightPanel}</div>
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="运行测试"
      description="左侧对话触发工作流，右侧实时查看节点流转与输出"
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            关闭
          </Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {leftPanel}
        {rightPanel}
      </div>
    </Modal>
  );
}
