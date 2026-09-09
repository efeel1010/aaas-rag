import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AgentView, RetrievalHitView } from '@pulse/contracts';
import { useAgent, useDeleteAgent } from '../../hooks/useAgents.js';
import { agentChatStream } from '../../api/agents.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { Button } from '../../components/ui/Button.js';
import { Badge, statusTone } from '../../components/ui/Badge.js';
import { Icon } from '../../components/ui/Icon.js';
import { Card } from '../../components/ui/Table.js';
import { Tabs } from '../../components/ui/Tabs.js';
import { ConfirmDialog } from '../../components/ui/Modal.js';
import { ApiAccessModal } from '../../components/ui/ApiAccessModal.js';
import { ApiCallLogs } from '../../components/ui/ApiCallLogs.js';
import { ConversationLog } from '../../components/ui/ConversationLog.js';
import { FullPageLoader, Spinner } from '../../components/ui/Spinner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { useToast } from '../../components/ui/Toast.js';
import { Textarea, Input, Field } from '../../components/ui/Input.js';
import { cn } from '../../lib/format.js';

const STRATEGY_LABEL: Record<string, string> = {
  retrieval: '检索生成',
  direct: '直答话术',
  workflow: '触发工作流',
  fallback: '兜底',
};

const STRATEGY_TONE: Record<string, 'info' | 'warning' | 'primary' | 'neutral'> = {
  retrieval: 'info',
  direct: 'warning',
  workflow: 'primary',
  fallback: 'neutral',
};

interface ChatMeta {
  intentName: string | null;
  retrievedDatasets: string[];
  toolCalls: { name: string; status: string }[];
  citations: RetrievalHitView[];
  usage?: { inputTokens: number; outputTokens: number; model?: string };
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  meta?: ChatMeta;
  error?: string;
  streaming?: boolean;
}

/** 对话生成参数（输入框以字符串承载，空值表示不传、走模型默认） */
interface ChatParams {
  temperature: string;
  maxTokens: string;
  topK: string;
}

/**
 * 系统推荐的默认生成参数 —— 严格按照知识库契约取值：
 *  - temperature：0~2 可选，默认不指定（由模型 provider 决定）；
 *  - maxTokens：正整数可选，默认不指定（由模型 provider 决定）；
 *  - topK：检索召回数 1~20，默认 6。
 */
const DEFAULT_CHAT_PARAMS: ChatParams = {
  temperature: '',
  maxTokens: '',
  topK: '6',
};

let msgSeq = 0;
const nextMsgId = () => ++msgSeq;

export function AgentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [apiOpen, setApiOpen] = useState(false);

  const { data: agent, isLoading, isError } = useAgent(id);

  // ---- 对话测试状态 ----
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatParams, setChatParams] = useState<ChatParams>(DEFAULT_CHAT_PARAMS);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);

  const deleteMutation = useDeleteAgent();

  if (isLoading) return <FullPageLoader />;
  if (isError || !agent) {
    return (
      <EmptyState
        icon="alert"
        title="Agent 不存在或加载失败"
        description="可能已被删除，或后端不可用。"
        action={
          <Link to="/agents">
            <Button variant="secondary">返回 Agent 列表</Button>
          </Link>
        }
      />
    );
  }

  const doDelete = async () => {
    try {
      await deleteMutation.mutateAsync(agent.id);
      toast.success('Agent 已删除');
      navigate('/agents');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
      setConfirmDelete(false);
    }
  };

  const send = async () => {
    const query = input.trim();
    if (!query || sending) return;
    if (agent.status !== 'active') {
      toast.error('Agent 已停用，无法进行对话测试');
      return;
    }

    // 参数校验：严格按照契约范围，非法时拦截并提示
    const temperature = chatParams.temperature.trim();
    const maxTokens = chatParams.maxTokens.trim();
    const topK = chatParams.topK.trim();
    const temperatureNum = temperature === '' ? undefined : Number(temperature);
    const maxTokensNum = maxTokens === '' ? undefined : Number(maxTokens);
    const topKNum = topK === '' ? undefined : Number(topK);
    if (temperature !== '' && (Number.isNaN(temperatureNum) || (temperatureNum as number) < 0 || (temperatureNum as number) > 2)) {
      toast.error('temperature 须在 0~2 之间');
      return;
    }
    if (maxTokens !== '' && (!Number.isInteger(maxTokensNum) || (maxTokensNum as number) <= 0)) {
      toast.error('maxTokens 须为正整数');
      return;
    }
    if (topK !== '' && (Number.isNaN(topKNum) || !Number.isInteger(topKNum) || (topKNum as number) < 1 || (topKNum as number) > 20)) {
      toast.error('topK 须为 1~20 的整数');
      return;
    }

    const userMsg: ChatMessage = { id: nextMsgId(), role: 'user', content: query };
    const assistantMsg: ChatMessage = { id: nextMsgId(), role: 'assistant', content: '', streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setSending(true);

    try {
      const events = agentChatStream(agent.id, {
        query,
        sessionId: sessionIdRef.current,
        stream: true,
        // 空值不传，由后端走模型默认（topK 后端默认 6）
        temperature: temperatureNum,
        maxTokens: maxTokensNum,
        topK: topKNum,
      });
      const meta: ChatMeta = { intentName: null, retrievedDatasets: [], toolCalls: [], citations: [] };
      for await (const evt of events) {
        if (evt.event === 'meta') {
          const d = evt.data;
          meta.intentName = (d.intent as { name?: string | null } | null)?.name ?? null;
          meta.retrievedDatasets = Array.isArray(d.retrievedDatasets)
            ? (d.retrievedDatasets as string[])
            : [];
          meta.citations = Array.isArray(d.citations) ? (d.citations as RetrievalHitView[]) : [];
          sessionIdRef.current = (d.sessionId as string) ?? sessionIdRef.current;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, meta: { ...meta } } : m)),
          );
        } else if (evt.event === 'citations') {
          const d = evt.data;
          meta.citations = Array.isArray(d.citations) ? (d.citations as RetrievalHitView[]) : [];
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, meta: { ...meta } } : m)),
          );
        } else if (evt.event === 'tool_call') {
          const d = evt.data;
          meta.toolCalls.push({
            name: (d.name as string) ?? 'unknown',
            status: (d.status as string) ?? 'unknown',
          });
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, meta: { ...meta } } : m)),
          );
        } else if (evt.event === 'delta') {
          const content = (evt.data.content as string) ?? '';
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + content } : m)),
          );
        } else if (evt.event === 'usage') {
          const u = evt.data;
          meta.usage = {
            inputTokens: (u.inputTokens as number) ?? 0,
            outputTokens: (u.outputTokens as number) ?? 0,
            model: (u.model as string) ?? undefined,
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, meta: { ...meta } } : m)),
          );
        } else if (evt.event === 'error') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, streaming: false, error: (evt.data.message as string) ?? '对话失败' }
                : m,
            ),
          );
        } else if (evt.event === 'done') {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
          );
        }
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, streaming: false, error: e instanceof Error ? e.message : '对话失败' }
            : m,
        ),
      );
    } finally {
      setSending(false);
      requestAnimationFrame(() => {
        chatBoxRef.current?.scrollTo({ top: chatBoxRef.current.scrollHeight });
      });
    }
  };

  const stopStream = () => {
    abortRef.current?.abort();
    setSending(false);
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  };

  const clearChat = () => {
    sessionIdRef.current = undefined;
    setMessages([]);
  };

  return (
    <div>
      <PageHeader
        title={agent.name}
        description={agent.description ?? '暂无描述'}
        backTo="/agents"
        backLabel="Agent"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Icon name="link" size={15} />}
              onClick={() => setApiOpen(true)}
            >
              调用 API
            </Button>
            <Button
              variant="secondary"
              icon={<Icon name="edit" size={15} />}
              onClick={() => navigate(`/agents/${agent.id}/edit`)}
            >
              编辑
            </Button>
            <Button
              variant="danger-ghost"
              icon={<Icon name="trash" size={15} />}
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </Button>
          </>
        }
      />

      {/* 概览卡片 */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <MetaCard label="对话模型" value={agent.modelName ?? '未绑定'} />
        <MetaCard label="类型" value={agent.type} />
        <MetaCard label="知识库绑定" value={`${agent.datasets.length} 个`} />
        <MetaCard label="意图配置" value={`${agent.intents.length} 个`} />
        <MetaCard label="工具" value={agent.tools.length > 0 ? agent.tools.join(', ') : '未启用'} />
        <MetaCard
          label="状态"
          value={agent.status === 'active' ? '已启用' : '已停用'}
          trailing={
            <Badge tone={statusTone(agent.status)} dot>
              {agent.status}
            </Badge>
          }
        />
      </div>

      <Tabs
        items={[
          { key: 'overview', label: '概览', icon: <Icon name="layers" size={14} /> },
          { key: 'chat', label: '对话测试', icon: <Icon name="message" size={14} /> },
          { key: 'history', label: '历史会话', icon: <Icon name="clock" size={14} /> },
          { key: 'logs', label: '调用日志', icon: <Icon name="terminal" size={14} /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'overview' && <OverviewTab agent={agent} />}
      {tab === 'chat' && (
        <ChatTab
          agent={agent}
          messages={messages}
          input={input}
          setInput={setInput}
          sending={sending}
          onSend={send}
          onStop={stopStream}
          onClear={clearChat}
          chatBoxRef={chatBoxRef}
          chatParams={chatParams}
          setChatParams={setChatParams}
        />
      )}
      {tab === 'history' && <ConversationLog agentId={agent.id} />}
      {tab === 'logs' && <ApiCallLogs resourceType="agent" resourceId={agent.id} />}

      <ApiAccessModal
        open={apiOpen}
        onClose={() => setApiOpen(false)}
        resourceType="agent"
        resourceId={agent.id}
        resourceName={agent.name}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除 Agent"
        message={
          <>
            删除 Agent <b className="text-ink">{agent.name}</b> 将同时清理知识库绑定与意图关联，不可恢复。
          </>
        }
        danger
        loading={deleteMutation.isPending}
        onConfirm={doDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function MetaCard({ label, value, trailing }: { label: string; value: string; trailing?: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-3">{label}</span>
        {trailing}
      </div>
      <div className="mt-1.5 truncate text-sm font-medium text-ink" title={value}>
        {value}
      </div>
    </Card>
  );
}

function OverviewTab({ agent }: { agent: AgentView }) {
  return (
    <div className="space-y-5">
      {/* 系统提示词 */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">系统提示词</h3>
        {agent.systemPrompt ? (
          <pre className="whitespace-pre-wrap rounded-lg bg-surface-2 p-4 text-[13px] leading-relaxed text-ink-2">
            {agent.systemPrompt}
          </pre>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
            未配置系统提示词
          </p>
        )}
      </Card>

      {/* 知识库绑定 */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">知识库绑定（权重）</h3>
        {agent.datasets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
            未绑定知识库 —— Agent 无法进行知识检索
          </p>
        ) : (
          <div className="space-y-2">
            {agent.datasets.map((d) => (
              <div
                key={d.datasetId}
                className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-4 py-2.5"
              >
                <span className="flex items-center gap-2 text-sm text-ink">
                  <Icon name="database" size={14} className="text-primary" />
                  {d.datasetName ?? d.datasetId}
                </span>
                <Badge tone="primary">权重 {d.weight}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Rerank 重排 */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">Rerank 重排</h3>
        {agent.rerankModelId ? (
          <div className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm text-ink">
              <Icon name="sparkles" size={14} className="text-primary" />
              {agent.rerankModelName ?? agent.rerankModelId}
            </span>
            <Badge tone="primary">已启用</Badge>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
            未绑定 Rerank 模型 —— Agent 检索不进行重排
          </p>
        )}
      </Card>

      {/* 工具配置（ReAct 工具循环） */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">工具配置</h3>
        {agent.tools.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
            未启用工具 —— 使用固定检索 + LLM 直线编排
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agent.tools.map((t) => (
              <Badge key={t} tone="primary">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      {/* 意图列表 */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">意图配置</h3>
        {agent.intents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
            未配置意图 —— 所有问题将走默认检索流程
          </p>
        ) : (
          <div className="space-y-3">
            {agent.intents.map((it) => (
              <div key={it.agentIntentId} className="rounded-lg border border-line-soft p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{it.name}</span>
                  <Badge tone={STRATEGY_TONE[it.strategy] ?? 'neutral'}>
                    {STRATEGY_LABEL[it.strategy] ?? it.strategy}
                  </Badge>
                  {it.workflowId && (
                    <Badge tone="primary">关联工作流</Badge>
                  )}
                  {it.datasetId && (
                    <Badge tone="info">限定知识库</Badge>
                  )}
                  {it.priority > 0 && <Badge tone="neutral">优先级 {it.priority}</Badge>}
                </div>
                {it.examples.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {it.examples.map((ex, i) => (
                      <span key={i} className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">
                        {ex}
                      </span>
                    ))}
                  </div>
                )}
                {it.responseTemplate && (
                  <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
                    话术：{it.responseTemplate}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function CitationList({ messageId, citations }: { messageId: number; citations: RetrievalHitView[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div className="mt-2 border-t border-line-soft pt-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
        <Icon name="file" size={12} />
        引用来源（{citations.length}）
      </div>
      <div className="space-y-1.5">
        {citations.map((c, i) => {
          const key = `${messageId}:${c.chunkId}`;
          const open = expanded[key] ?? false;
          const docName =
            typeof c.metadata?.documentName === 'string' ? c.metadata.documentName : '未知文档';
          const docIndex = typeof c.metadata?.index === 'number' ? ` #${c.metadata.index}` : '';
          return (
            <div
              key={key}
              className={cn(
                'rounded-md border bg-surface px-2 py-1.5 transition-colors',
                open ? 'border-primary/40' : 'border-line hover:border-primary/40',
              )}
            >
              <button
                type="button"
                onClick={() => setExpanded((p) => ({ ...p, [key]: !open }))}
                className="flex w-full items-center gap-1.5 text-[11px] text-ink-3"
              >
                <Badge tone="primary" className="shrink-0">引用 {i + 1}</Badge>
                <span className="truncate text-ink-2">{docName}{docIndex}</span>
                <span className="ml-auto shrink-0 font-mono">score {c.score.toFixed(3)}</span>
                <Icon
                  name="chevron-down"
                  size={12}
                  className={cn('shrink-0 transition-transform', open && 'rotate-180')}
                />
              </button>
              <p
                className={cn(
                  'mt-1 break-all text-[12px] leading-relaxed text-ink-2',
                  !open && 'line-clamp-2',
                )}
              >
                {c.content}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChatTab({
  agent,
  messages,
  input,
  setInput,
  sending,
  onSend,
  onStop,
  onClear,
  chatBoxRef,
  chatParams,
  setChatParams,
}: {
  agent: AgentView;
  messages: ChatMessage[];
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  onSend: () => void;
  onStop: () => void;
  onClear: () => void;
  chatBoxRef: React.RefObject<HTMLDivElement | null>;
  chatParams: ChatParams;
  setChatParams: (v: ChatParams) => void;
}) {
  const toast = useToast();
  const updateParam = (key: keyof ChatParams, value: string) =>
    setChatParams({ ...chatParams, [key]: value });

  const resetParams = () => {
    setChatParams(DEFAULT_CHAT_PARAMS);
    toast.success('已恢复系统推荐的默认参数');
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      {/* 聊天区 */}
      <Card padded={false} className="flex h-[62vh] min-h-[420px] flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
          <span className="text-xs text-ink-3">SSE 流式对话</span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={onClear} icon={<Icon name="refresh" size={13} />}>
              清空会话
            </Button>
          </div>
        </div>

        <div ref={chatBoxRef} className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
                <Icon name="bot" size={22} />
              </span>
              <p className="text-sm font-medium text-ink-2">开始对话测试</p>
              <p className="max-w-xs text-xs text-ink-3">
                输入问题后，将经意图路由 → 知识检索 → 模型编排，SSE 流式返回回答。
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'rounded-br-sm bg-primary text-white'
                    : 'rounded-bl-sm border border-line bg-surface-2 text-ink-2',
                )}
              >
                {m.meta && m.meta.intentName && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone="warning">意图：{m.meta.intentName}</Badge>
                    {m.meta.retrievedDatasets.length > 0 && (
                      <Badge tone="info">检索 {m.meta.retrievedDatasets.length} 个库</Badge>
                    )}
                  </div>
                )}
                {m.meta && m.meta.toolCalls.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    {m.meta.toolCalls.map((tc, i) => (
                      <Badge key={i} tone={tc.status === 'success' ? 'primary' : 'danger'}>
                        工具：{tc.name}（{tc.status}）
                      </Badge>
                    ))}
                  </div>
                )}
                {m.content ? (
                  <p className="whitespace-pre-wrap">{m.content}</p>
                ) : m.streaming ? (
                  <span className="flex items-center gap-1.5 text-ink-3">
                    <Spinner size={13} />
                    思考中…
                  </span>
                ) : null}
                {m.streaming && m.content && (
                  <span className="mt-1 inline-block h-3 w-1 animate-pulse rounded bg-primary align-middle" />
                )}
                {m.error && <p className="mt-1 text-xs text-danger">错误：{m.error}</p>}
                {!m.streaming && m.meta && m.meta.citations.length > 0 && (
                  <CitationList messageId={m.id} citations={m.meta.citations} />
                )}
                {m.meta?.usage && !m.streaming && (
                  <p className="mt-1 text-[11px] text-ink-3">
                    {m.meta.usage.model ? `${m.meta.usage.model} · ` : ''}输入 {m.meta.usage.inputTokens} tok /
                    输出 {m.meta.usage.outputTokens} tok
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-line-soft p-3">
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (sending) onStop();
                  else onSend();
                }
              }}
              placeholder={`向「${agent.name}」提问…（Enter 发送，Shift+Enter 换行）`}
              className="resize-none"
            />
            {sending ? (
              <Button onClick={onStop} variant="danger" icon={<Icon name="stop" size={15} />}>
                停止
              </Button>
            ) : (
              <Button onClick={onSend} icon={<Icon name="send" size={15} />}>
                发送
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] text-ink-3">
            需先绑定 <b className="text-ink-2">llm 对话模型</b>与<b className="text-ink-2">知识库</b>；mock 模式下即可完成全链路。
          </p>
        </div>
      </Card>

      {/* 生成参数面板 */}
      <Card padded={false} className="h-fit text-[13px]">
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
          <span className="text-xs font-semibold text-ink-3">生成参数</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetParams}
            icon={<Icon name="refresh" size={13} />}
            className="text-primary hover:text-primary-strong"
          >
            重置默认
          </Button>
        </div>
        <div className="space-y-3.5 px-4 py-3.5">
          <Field label="temperature" hint="采样温度，0~2；留空使用模型默认">
            <Input
              type="number"
              min={0}
              max={2}
              step={0.1}
              placeholder="默认（模型决定）"
              value={chatParams.temperature}
              onChange={(e) => updateParam('temperature', e.target.value)}
            />
          </Field>
          <Field label="maxTokens" hint="最大生成长度（正整数）；留空使用模型默认">
            <Input
              type="number"
              min={1}
              step={1}
              placeholder="默认（模型决定）"
              value={chatParams.maxTokens}
              onChange={(e) => updateParam('maxTokens', e.target.value)}
            />
          </Field>
          <Field label="topK" hint="检索召回数，1~20；默认 6">
            <Input
              type="number"
              min={1}
              max={20}
              step={1}
              placeholder="默认 6"
              value={chatParams.topK}
              onChange={(e) => updateParam('topK', e.target.value)}
            />
          </Field>
          <p className="rounded-lg bg-surface-2 p-2.5 text-[11px] leading-relaxed text-ink-3">
            修改后即时生效，发送消息时自动携带；点击「重置默认」恢复系统推荐值（temperature / maxTokens 不指定、topK=6）。
          </p>
        </div>
      </Card>

      {/* 说明面板 */}
      <Card padded={false} className="h-fit text-[13px]">
        <div className="border-b border-line-soft px-4 py-2.5 text-xs font-semibold text-ink-3">
          链路说明
        </div>
        <div className="space-y-3 px-4 py-3 leading-relaxed text-ink-3">
          <p>
            1. <b className="text-ink-2">意图路由</b>：用户问题先匹配意图（示例问法/LLM 分类），命中后按策略处理。
          </p>
          <p>
            2. <b className="text-ink-2">工具循环（启用工具时）</b>：由 LLM 自主决定是否调用工具（本地检索 / 第三方接口），多轮收敛后生成。
          </p>
          <p>
            3. <b className="text-ink-2">知识检索（未启用工具时）</b>：在绑定知识库（按权重加权）内做混合检索，召回 TopK 切片。
          </p>
          <p>
            4. <b className="text-ink-2">模型编排</b>：把系统提示词 + 检索/工具上下文 + 用户问题交给对话模型生成。
          </p>
          <p className="rounded-lg bg-surface-2 p-3 font-mono text-[12px] text-ink-2">
            SSE: meta → tool_call* → delta* → usage → done
          </p>
        </div>
      </Card>
    </div>
  );
}
