import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentToolName, AgentType, CreateAgentInput, IntentStrategy } from '@pulse/contracts';
import { useAgent, useCreateAgent, useUpdateAgent } from '../../hooks/useAgents.js';
import { useDatasets } from '../../hooks/useDatasets.js';
import { useModels } from '../../hooks/useModels.js';
import { useWorkflows } from '../../hooks/useWorkflows.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { Button } from '../../components/ui/Button.js';
import { Field, Input, Select, Textarea } from '../../components/ui/Input.js';
import { Switch } from '../../components/ui/Switch.js';
import { Card } from '../../components/ui/Table.js';
import { Icon } from '../../components/ui/Icon.js';
import { useToast } from '../../components/ui/Toast.js';
import { FullPageLoader } from '../../components/ui/Spinner.js';
import type { AgentDatasetBinding, AgentView } from '@pulse/contracts';

interface IntentFormState {
  /** 编辑时保留，避免重复创建通用意图 */
  intentId?: string;
  key: string;
  name: string;
  examples: string[];
  strategy: IntentStrategy;
  responseTemplate: string;
  workflowId: string;
  datasetId: string;
}

interface BindingState {
  datasetId: string;
  weight: string;
}

let intentSeq = 0;
const newIntentKey = () => `intent_${Date.now().toString(36)}_${++intentSeq}`;

function emptyIntent(): IntentFormState {
  return {
    key: newIntentKey(),
    name: '',
    examples: [''],
    strategy: 'retrieval',
    responseTemplate: '',
    workflowId: '',
    datasetId: '',
  };
}

function intentFromView(it: AgentView['intents'][number]): IntentFormState {
  return {
    intentId: it.intentId,
    key: newIntentKey(),
    name: it.name,
    examples: it.examples.length > 0 ? it.examples : [''],
    strategy: it.strategy,
    responseTemplate: it.responseTemplate ?? '',
    workflowId: it.workflowId ?? '',
    datasetId: it.datasetId ?? '',
  };
}

const STRATEGY_OPTIONS: Array<{ value: IntentStrategy; label: string }> = [
  { value: 'retrieval', label: '检索生成（检索后交 LLM 回答）' },
  { value: 'direct', label: '直答话术（直接返回模板，不调用 LLM）' },
  { value: 'workflow', label: '触发工作流（运行关联工作流作为回复）' },
  { value: 'fallback', label: '兜底意图（未命中其他意图时命中）' },
];

/** 可用工具（与后端 ToolRegistry 注册名一致） */
const TOOL_OPTIONS: Array<{ value: AgentToolName; label: string; description: string }> = [
  {
    value: 'local_retrieval',
    label: '本地知识库检索',
    description: '按需检索 Agent 绑定的知识库；启用后由 LLM 自主决定是否检索（替代固定检索分支）',
  },
  {
    value: 'http_request',
    label: '第三方 HTTP GET',
    description: '调用外部 http/https 接口获取实时数据（受协议白名单与超时约束）',
  },
  {
    value: 'openalex_search',
    label: 'OpenAlex 学术检索',
    description:
      '实时检索 OpenAlex 学术文献库（标题/摘要/作者/DOI/来源期刊/被引次数），结果带来源与获取时间',
  },
];

function IntentEditor({
  intent,
  onChange,
  onRemove,
  datasets,
  workflows,
}: {
  intent: IntentFormState;
  onChange: (next: IntentFormState) => void;
  onRemove: () => void;
  datasets: { value: string; label: string }[];
  workflows: { value: string; label: string }[];
}) {
  const patch = (p: Partial<IntentFormState>) => onChange({ ...intent, ...p });
  const patchExample = (i: number, v: string) =>
    patch({ examples: intent.examples.map((e, idx) => (idx === i ? v : e)) });
  const removeExample = (i: number) => patch({ examples: intent.examples.filter((_, idx) => idx !== i) });
  const addExample = () => patch({ examples: [...intent.examples, ''] });

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <Icon name="sparkles" size={14} className="text-warning" />
          意图 · {intent.name || '未命名'}
          {intent.intentId && <span className="text-[11px] font-normal text-ink-3">（复用已有意图）</span>}
        </div>
        <Button size="sm" variant="danger-ghost" icon={<Icon name="trash" size={13} />} onClick={onRemove}>
          移除
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="意图名称" required>
          <Input
            value={intent.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="例如：产品咨询"
          />
        </Field>
        <Field label="路由策略">
          <Select
            value={intent.strategy}
            onChange={(e) => patch({ strategy: e.target.value as IntentStrategy })}
            options={STRATEGY_OPTIONS}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="示例问法" hint="用于意图识别，输入若干条典型提问，可留空">
          <div className="space-y-1.5">
            {intent.examples.map((ex, i) => (
              <div key={i} className="flex gap-1.5">
                <Input
                  value={ex}
                  onChange={(e) => patchExample(i, e.target.value)}
                  placeholder={`示例 ${i + 1}：例如「你们的售后政策是什么？」`}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="x" size={14} />}
                  onClick={() => removeExample(i)}
                  aria-label="删除示例"
                />
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={addExample} icon={<Icon name="plus" size={13} />}>
              添加示例
            </Button>
          </div>
        </Field>
      </div>

      {(intent.strategy === 'direct' || intent.strategy === 'fallback') && (
        <Field label="回复话术" className="mt-3" hint="命中该意图时直接返回这段话术">
          <Textarea
            rows={3}
            value={intent.responseTemplate}
            onChange={(e) => patch({ responseTemplate: e.target.value })}
            placeholder="例如：您好，关于售后问题请参考官网说明。"
          />
        </Field>
      )}

      {intent.strategy === 'workflow' && (
        <Field label="关联工作流" className="mt-3" hint="运行该工作流，输出作为本轮回复">
          <Select
            value={intent.workflowId}
            onChange={(e) => patch({ workflowId: e.target.value })}
            options={[{ value: '', label: '（请选择工作流）' }, ...workflows]}
          />
        </Field>
      )}

      {intent.strategy === 'retrieval' && (
        <Field label="限定知识库子集" className="mt-3" hint="命中该意图时优先检索此库；留空则检索 Agent 全部知识库">
          <Select
            value={intent.datasetId}
            onChange={(e) => patch({ datasetId: e.target.value })}
            options={[{ value: '', label: '（不限，使用 Agent 全量知识库）' }, ...datasets]}
          />
        </Field>
      )}
    </div>
  );
}

export function AgentFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();

  const { data: agent, isLoading: agentLoading } = useAgent(id);
  const { data: datasets } = useDatasets();
  const { data: models } = useModels();
  const { data: workflows } = useWorkflows();
  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent(id ?? '');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [rerankModelId, setRerankModelId] = useState('');
  const [type, setType] = useState<AgentType>('chat');
  const [status, setStatus] = useState(true);
  const [tools, setTools] = useState<AgentToolName[]>([]);
  const [bindings, setBindings] = useState<BindingState[]>([]);
  const [intents, setIntents] = useState<IntentFormState[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setDescription(agent.description ?? '');
      setSystemPrompt(agent.systemPrompt ?? '');
      setModelId(agent.modelId ?? '');
      setRerankModelId(agent.rerankModelId ?? '');
      setType(agent.type);
      setStatus(agent.status === 'active');
      setTools(agent.tools ?? []);
      setBindings(
        agent.datasets.map((d) => ({ datasetId: d.datasetId, weight: String(d.weight) })),
      );
      setIntents(agent.intents.map(intentFromView));
    }
  }, [agent]);

  const datasetOptions = (datasets ?? [])
    .filter((d) => d.status === 'active')
    .map((d) => ({ value: d.id, label: d.name }));
  const llmModels = (models ?? [])
    .filter((m) => m.modelType === 'llm' && m.status === 'active')
    .map((m) => ({ value: m.id, label: m.name }));
  const rerankModels = (models ?? [])
    .filter((m) => m.modelType === 'rerank' && m.status === 'active')
    .map((m) => ({ value: m.id, label: m.name }));
  const workflowOptions = (workflows ?? []).map((w) => ({
    value: w.id,
    label: `${w.name}（${w.status}）`,
  }));

  const addBinding = () =>
    setBindings((prev) => [...prev, { datasetId: datasetOptions[0]?.value ?? '', weight: '100' }]);
  const patchBinding = (i: number, p: Partial<BindingState>) =>
    setBindings((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...p } : b)));
  const removeBinding = (i: number) => setBindings((prev) => prev.filter((_, idx) => idx !== i));

  const addIntent = () => setIntents((prev) => [...prev, emptyIntent()]);
  const patchIntent = (i: number, next: IntentFormState) =>
    setIntents((prev) => prev.map((it, idx) => (idx === i ? next : it)));
  const removeIntent = (i: number) => setIntents((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = '请输入 Agent 名称';
    if (!modelId) errs.modelId = '请选择对话模型';
    const validBindings = bindings.filter((b) => b.datasetId);
    const validIntents = intents.filter((it) => it.name.trim());
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const datasetsPayload: AgentDatasetBinding[] = validBindings.map((b) => ({
      datasetId: b.datasetId,
      weight: Math.max(1, Math.min(1000, Number(b.weight) || 100)),
    }));

    const input: CreateAgentInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      modelId,
      rerankModelId: rerankModelId || null,
      type,
      status: status ? 'active' : 'disabled',
      datasets: datasetsPayload,
      intents: validIntents.map((it) => ({
        intentId: it.intentId,
        name: it.name.trim(),
        examples: it.examples.map((e) => e.trim()).filter(Boolean),
        strategy: it.strategy,
        responseTemplate:
          (it.strategy === 'direct' || it.strategy === 'fallback') && it.responseTemplate.trim()
            ? it.responseTemplate.trim()
            : undefined,
        workflowId: it.strategy === 'workflow' ? it.workflowId || undefined : undefined,
        datasetId: it.datasetId || null,
        priority: 0,
      })),
      // 启用的工具（勾选即切换 ReAct 工具循环编排；未勾选维持原直线编排）
      tools: tools.length > 0 ? tools : undefined,
    };

    try {
      if (isEdit) {
        const updated = await updateMutation.mutateAsync(input);
        toast.success('Agent 已更新');
        navigate(`/agents/${updated.id}`);
      } else {
        const created = await createMutation.mutateAsync(input);
        toast.success('Agent 已创建');
        navigate(`/agents/${created.id}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  if (isEdit && agentLoading) return <FullPageLoader />;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={isEdit ? '编辑 Agent' : '新建 Agent'}
        description="绑定对话模型与知识库，配置意图路由；保存后可在详情页进行对话测试"
        backTo="/agents"
      />

      <div className="space-y-5">
        {/* 基本信息 */}
        <Card>
          <h3 className="mb-4 text-sm font-semibold text-ink">基本信息</h3>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="名称" required error={errors.name}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：客服助手" />
              </Field>
              <Field label="类型">
                <Select
                  value={type}
                  onChange={(e) => setType(e.target.value as AgentType)}
                  options={[
                    { value: 'chat', label: 'chat（对话型）' },
                    { value: 'workflow', label: 'workflow（工作流型）' },
                    { value: 'advanced', label: 'advanced（高级）' },
                  ]}
                />
              </Field>
            </div>
            <Field label="描述">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="选填，一句话说明 Agent 用途"
              />
            </Field>
            <Field
              label="对话模型"
              required
              error={errors.modelId}
              hint={
                llmModels.length === 0
                  ? '暂无可用 llm 模型 —— 请先在「模型配置」页注册（mock 模式可任意命名）'
                  : 'Agent 编排使用的对话模型（须为 llm 类型且启用）'
              }
            >
              <Select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                options={[{ value: '', label: '（请选择对话模型）' }, ...llmModels]}
              />
            </Field>
            <Field
              label="Rerank 重排模型"
              hint={
                rerankModels.length === 0
                  ? '暂无可用 rerank 模型 —— 请先在「模型配置」页注册（可留空不启用重排）'
                  : '可选；绑定后 Agent 检索的 RRF 候选会先经该模型重排，留空表示不启用重排'
              }
            >
              <Select
                value={rerankModelId}
                onChange={(e) => setRerankModelId(e.target.value)}
                options={[{ value: '', label: '（不启用 Rerank 重排）' }, ...rerankModels]}
              />
            </Field>
            <Field label="系统提示词" hint="编排时作为首条 system 消息，可引用知识检索上下文">
              <Textarea
                rows={4}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="例如：你是智能客服助手，请基于检索到的资料回答用户问题。"
              />
            </Field>
            <div className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-4 py-3">
              <div>
                <div className="text-sm text-ink">启用 Agent</div>
                <div className="text-xs text-ink-3">停用后不可被对话测试调用</div>
              </div>
              <Switch checked={status} onChange={setStatus} label="启用状态" />
            </div>
          </div>
        </Card>

        {/* 知识库绑定 */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink">知识库绑定</h3>
              <p className="mt-0.5 text-xs text-ink-3">
                Agent 可检索的知识库白名单（全量替换）。权重越高检索时相对越重要。
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={addBinding} icon={<Icon name="plus" size={13} />}>
              添加绑定
            </Button>
          </div>
          {bindings.length === 0 && (
            <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
              尚未绑定知识库 —— Agent 将无法进行知识检索
            </p>
          )}
          <div className="space-y-2">
            {bindings.map((b, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface-2 p-2.5">
                <Select
                  className="flex-1"
                  value={b.datasetId}
                  onChange={(e) => patchBinding(i, { datasetId: e.target.value })}
                  options={[{ value: '', label: '（选择知识库）' }, ...datasetOptions]}
                />
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    className="w-24"
                    value={b.weight}
                    min={1}
                    max={1000}
                    onChange={(e) => patchBinding(i, { weight: e.target.value })}
                    placeholder="权重"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon name="x" size={14} />}
                    onClick={() => removeBinding(i)}
                    aria-label="移除绑定"
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* 工具配置（ReAct 工具循环） */}
        <Card>
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-ink">工具配置</h3>
            <p className="mt-0.5 text-xs text-ink-3">
              启用工具后，Agent 从「固定检索 + LLM」切换为「ReAct 工具循环」：由 LLM 自主决定是否调用工具；
              启用 local_retrieval 时由 LLM 决定何时检索本地知识库。不启用则维持原直线编排。
            </p>
          </div>
          <div className="space-y-2">
            {TOOL_OPTIONS.map((tool) => {
              const checked = tools.includes(tool.value);
              return (
                <div
                  key={tool.value}
                  className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-4 py-3"
                >
                  <div>
                    <div className="text-sm font-medium text-ink">{tool.label}</div>
                    <div className="text-xs text-ink-3">{tool.description}</div>
                  </div>
                  <Switch
                    checked={checked}
                    onChange={(v) =>
                      setTools((prev) =>
                        v ? [...prev, tool.value] : prev.filter((t) => t !== tool.value),
                      )
                    }
                    label={tool.label}
                  />
                </div>
              );
            })}
          </div>
        </Card>

        {/* 意图配置 */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink">意图配置</h3>
              <p className="mt-0.5 text-xs text-ink-3">
                用户问题先经意图识别路由到不同策略；未命中任何意图时走兜底。
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={addIntent} icon={<Icon name="plus" size={13} />}>
              添加意图
            </Button>
          </div>
          {intents.length === 0 && (
            <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
              暂无意图 —— 可添加意图配置路由策略
            </p>
          )}
          <div className="space-y-3">
            {intents.map((it, i) => (
              <IntentEditor
                key={it.key}
                intent={it}
                onChange={(next) => patchIntent(i, next)}
                onRemove={() => removeIntent(i)}
                datasets={datasetOptions}
                workflows={workflowOptions}
              />
            ))}
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            取消
          </Button>
          <Button onClick={submit} loading={createMutation.isPending || updateMutation.isPending}>
            {isEdit ? '保存修改' : '创建 Agent'}
          </Button>
        </div>
      </div>
    </div>
  );
}
