/**
 * 节点 / 连线属性面板 —— 根据类型渲染对应配置表单。
 * 节点 data 约定：{ config, label }；边 data 约定：{ condition? }。
 */
import type { Node, Edge } from '@xyflow/react';
import type { WorkflowConditionOperator } from '@pulse/contracts';
import {
  NODE_TYPE_META,
  edgeConditionLabel,
  type WorkflowEdgeData,
  type WorkflowNodeData,
} from '../../../lib/workflow.js';
import { Field, Input, Select, Textarea } from '../../../components/ui/Input.js';
import { Switch } from '../../../components/ui/Switch.js';
import { Button } from '../../../components/ui/Button.js';
import { Icon } from '../../../components/ui/Icon.js';

const VALUE_TYPES = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'object', label: 'object' },
  { value: 'array', label: 'array' },
  { value: 'any', label: 'any' },
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }));

export const CONDITION_OPERATORS: Array<{ value: WorkflowConditionOperator; label: string }> = [
  { value: 'eq', label: '等于 (eq)' },
  { value: 'ne', label: '不等于 (ne)' },
  { value: 'gt', label: '大于 (gt)' },
  { value: 'gte', label: '大于等于 (gte)' },
  { value: 'lt', label: '小于 (lt)' },
  { value: 'lte', label: '小于等于 (lte)' },
  { value: 'contains', label: '包含 (contains)' },
  { value: 'starts_with', label: '以…开头' },
  { value: 'ends_with', label: '以…结尾' },
  { value: 'is_empty', label: '为空' },
  { value: 'is_not_empty', label: '不为空' },
  { value: 'in', label: '在列表中 (in)' },
  { value: 'not_in', label: '不在列表中' },
  { value: 'regex', label: '正则匹配' },
  { value: 'truthy', label: '为真 (truthy)' },
  { value: 'falsy', label: '为假 (falsy)' },
];

type Patch = (patch: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// 节点配置
// ---------------------------------------------------------------------------

function StartConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  const inputs = (config.inputs as Array<Record<string, unknown>>) ?? [];
  const patchInput = (i: number, p: Record<string, unknown>) =>
    patch({ inputs: inputs.map((f, idx) => (idx === i ? { ...f, ...p } : f)) });
  return (
    <div className="space-y-3">
      <Field label="输入字段" hint="声明运行入参，注入变量空间供下游节点引用（如 {{query}}）">
        <div className="space-y-2">
          {inputs.map((f, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-line-soft bg-surface-2 p-2.5">
              <div className="flex items-center gap-1.5">
                <Input
                  className="flex-1"
                  placeholder="变量名，如 query"
                  value={String(f.name ?? '')}
                  onChange={(e) => patchInput(i, { name: e.target.value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="x" size={13} />}
                  onClick={() => patch({ inputs: inputs.filter((_, idx) => idx !== i) })}
                  aria-label="删除字段"
                />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <Input
                  placeholder="展示标签"
                  value={String(f.label ?? '')}
                  onChange={(e) => patchInput(i, { label: e.target.value })}
                />
                <Select
                  value={String(f.type ?? 'string')}
                  onChange={(e) => patchInput(i, { type: e.target.value })}
                  options={VALUE_TYPES}
                />
              </div>
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-ink-3">必填</span>
                <Switch checked={f.required !== false} onChange={(v) => patchInput(i, { required: v })} label="必填" />
              </div>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="plus" size={13} />}
            onClick={() => patch({ inputs: [...inputs, { name: '', type: 'string', required: true }] })}
          >
            添加输入字段
          </Button>
        </div>
      </Field>
    </div>
  );
}

function LlmConfig({
  config,
  patch,
  llmModels,
}: {
  config: Record<string, unknown>;
  patch: Patch;
  llmModels: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="space-y-3">
      <Field label="模型" hint="llm 类型且启用">
        <Select
          value={String(config.modelId ?? '')}
          onChange={(e) => patch({ modelId: e.target.value })}
          options={[{ value: '', label: '（请选择模型）' }, ...llmModels]}
        />
      </Field>
      <Field label="System 提示词">
        <Textarea
          rows={3}
          value={String(config.system ?? '')}
          onChange={(e) => patch({ system: e.target.value })}
          placeholder="可选，支持 {{var}} 变量"
        />
      </Field>
      <Field label="Prompt（用户消息）">
        <Textarea
          rows={4}
          value={String(config.prompt ?? '')}
          onChange={(e) => patch({ prompt: e.target.value })}
          placeholder="支持 {{var}} / {{a.b}} / {{list[0]}}"
        />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="温度">
          <Input
            type="number"
            step={0.1}
            min={0}
            max={2}
            value={String(config.temperature ?? 0.7)}
            onChange={(e) => patch({ temperature: Number(e.target.value) })}
          />
        </Field>
        <Field label="MaxTokens">
          <Input
            type="number"
            min={1}
            value={String(config.maxTokens ?? 1024)}
            onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
          />
        </Field>
        <Field label="输出变量">
          <Input
            value={String(config.output ?? 'answer')}
            onChange={(e) => patch({ output: e.target.value })}
            placeholder="answer"
          />
        </Field>
      </div>
      <Field label="执行引擎">
        <Select
          value={String(config.engine ?? 'gateway')}
          onChange={(e) => patch({ engine: e.target.value })}
          options={[
            { value: 'gateway', label: 'gateway（项目模型网关，支持 mock）' },
            { value: 'langchain', label: 'langchain（真实调用，需 openai 系 Provider）' },
          ]}
        />
      </Field>
    </div>
  );
}

function KnowledgeConfig({
  config,
  patch,
  datasets,
  rerankModels,
}: {
  config: Record<string, unknown>;
  patch: Patch;
  datasets: Array<{ value: string; label: string }>;
  rerankModels: Array<{ value: string; label: string }>;
}) {
  const ids = (config.datasetIds as string[]) ?? [];
  const toggle = (id: string) =>
    patch({ datasetIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });
  return (
    <div className="space-y-3">
      <Field label="检索知识库" hint="固定知识库白名单（多选）">
        {datasets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-ink-3">
            暂无可用知识库
          </p>
        ) : (
          <div className="space-y-1.5">
            {datasets.map((d) => (
              <label
                key={d.value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-line-soft bg-surface-2 px-3 py-2 text-sm text-ink-2"
              >
                <input
                  type="checkbox"
                  checked={ids.includes(d.value)}
                  onChange={() => toggle(d.value)}
                  className="accent-[var(--color-primary)]"
                />
                <span className="truncate">{d.label}</span>
              </label>
            ))}
          </div>
        )}
      </Field>
      <Field label="检索 Query（变量模板）">
        <Input
          value={String(config.query ?? '')}
          onChange={(e) => patch({ query: e.target.value })}
          placeholder="如 {{query}}"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="TopK">
          <Input
            type="number"
            min={1}
            max={100}
            value={String(config.topK ?? 6)}
            onChange={(e) => patch({ topK: Number(e.target.value) })}
          />
        </Field>
        <Field label="输出变量">
          <Input
            value={String(config.output ?? 'retrieval')}
            onChange={(e) => patch({ output: e.target.value })}
            placeholder="retrieval"
          />
        </Field>
      </div>
      <Field label="Rerank 模型" hint="RRF 候选先经该模型重排再取 TopK；留空不重排">
        <Select
          value={String(config.rerankModelId ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            if (v) patch({ rerankModelId: v });
            else patch({ rerankModelId: undefined });
          }}
          options={[{ value: '', label: '（不启用 Rerank）' }, ...rerankModels]}
        />
      </Field>
      <Field label="上下文变量（可选）" hint="把检索结果渲染为文本，供 llm prompt 直接引用">
        <Input
          value={String(config.contextOutput ?? '')}
          onChange={(e) => patch({ contextOutput: e.target.value })}
          placeholder="如 context"
        />
      </Field>
    </div>
  );
}

function IntentConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  return (
    <div className="space-y-3">
      <Field label="待分类变量" hint="缺省 query">
        <Input
          value={String(config.queryVariable ?? 'query')}
          onChange={(e) => patch({ queryVariable: e.target.value })}
        />
      </Field>
      <Field label="输出变量">
        <Input
          value={String(config.output ?? 'intent')}
          onChange={(e) => patch({ output: e.target.value })}
        />
      </Field>
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-3">
        分支在<b className="text-ink-2">出边上</b>配置：选中连线后在右侧填写「分支名 + 示例问法」，缺省整段为兜底分支。
      </p>
    </div>
  );
}

function ConditionConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  return (
    <div className="space-y-3">
      <Field label="命中分支输出变量（可选）">
        <Input
          value={String(config.output ?? '')}
          onChange={(e) => patch({ output: e.target.value })}
          placeholder="如 condition_result"
        />
      </Field>
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-3">
        分支条件在<b className="text-ink-2">出边上</b>配置：选中连线后在右侧设置「变量 + 操作符 + 值」，缺省整段为 else 分支。
      </p>
    </div>
  );
}

function CodeConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  return (
    <div className="space-y-3">
      <Field label="代码" hint="签名 (ctx) => Partial<variables>，ctx = { variables, inputs }">
        <Textarea
          rows={8}
          className="font-mono text-xs"
          value={String(config.code ?? '')}
          onChange={(e) => patch({ code: e.target.value })}
        />
      </Field>
      <Field label="超时（ms）">
        <Input
          type="number"
          min={10}
          max={10000}
          value={String(config.timeoutMs ?? 3000)}
          onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
        />
      </Field>
    </div>
  );
}

function HttpConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[110px_1fr] gap-2">
        <Field label="方法">
          <Select
            value={String(config.method ?? 'GET')}
            onChange={(e) => patch({ method: e.target.value })}
            options={HTTP_METHODS}
          />
        </Field>
        <Field label="URL（变量模板）">
          <Input
            value={String(config.url ?? '')}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="https://…"
          />
        </Field>
      </div>
      <Field label="请求头（JSON）">
        <Textarea
          rows={3}
          className="font-mono text-xs"
          value={JSON.stringify(config.headers ?? {}, null, 2)}
          onChange={(e) => {
            try {
              patch({ headers: JSON.parse(e.target.value) });
            } catch {
              // 非合法 JSON 时忽略
            }
          }}
        />
      </Field>
      <Field label="请求体（变量模板）">
        <Textarea
          rows={3}
          value={String(config.body ?? '')}
          onChange={(e) => patch({ body: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="超时（ms）">
          <Input
            type="number"
            min={100}
            max={60000}
            value={String(config.timeoutMs ?? 10000)}
            onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
          />
        </Field>
        <Field label="输出变量">
          <Input
            value={String(config.output ?? 'http')}
            onChange={(e) => patch({ output: e.target.value })}
            placeholder="http"
          />
        </Field>
      </div>
    </div>
  );
}

function TemplateConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  return (
    <div className="space-y-3">
      <Field label="模板" hint="渲染 {{var}} 输出文本">
        <Textarea
          rows={5}
          value={String(config.template ?? '')}
          onChange={(e) => patch({ template: e.target.value })}
          placeholder="你好，{{query}}"
        />
      </Field>
      <Field label="输出变量">
        <Input
          value={String(config.output ?? 'text')}
          onChange={(e) => patch({ output: e.target.value })}
          placeholder="text"
        />
      </Field>
    </div>
  );
}

function IterationConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  return (
    <div className="space-y-3">
      <Field label="数组变量" required hint="待遍历的变量路径，如 keywords / items / hits">
        <Input
          value={String(config.arrayVariable ?? '')}
          onChange={(e) => patch({ arrayVariable: e.target.value })}
          placeholder="keywords"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="当前项变量" hint="模板内以 {{item}} 引用">
          <Input
            value={String(config.itemVariable ?? 'item')}
            onChange={(e) => patch({ itemVariable: e.target.value })}
            placeholder="item"
          />
        </Field>
        <Field label="输出变量" hint="聚合结果数组">
          <Input
            value={String(config.output ?? 'results')}
            onChange={(e) => patch({ output: e.target.value })}
            placeholder="results"
          />
        </Field>
      </div>
      <Field
        label="每项模板"
        required
        hint="对每个元素渲染，支持 {{item}} / {{item.field}} / {{index}}"
      >
        <Textarea
          rows={4}
          value={String(config.bodyTemplate ?? '')}
          onChange={(e) => patch({ bodyTemplate: e.target.value })}
          placeholder="[{{index}}] {{item}}"
        />
      </Field>
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-3">
        {'迭代示例：对论文列表逐项提取标题 → 模板「{{item.title}} ({{item.year}})」。'}
      </p>
    </div>
  );
}

function EndConfig({ config, patch }: { config: Record<string, unknown>; patch: Patch }) {
  const outputs = (config.outputs as Array<Record<string, unknown>>) ?? [];
  const patchOutput = (i: number, p: Record<string, unknown>) =>
    patch({ outputs: outputs.map((f, idx) => (idx === i ? { ...f, ...p } : f)) });
  return (
    <div className="space-y-3">
      <Field label="输出字段" hint="把变量 from 映射为对外输出名 name；缺省输出全部变量">
        <div className="space-y-2">
          {outputs.map((f, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-line-soft bg-surface-2 p-2.5">
              <div className="flex items-center gap-1.5">
                <Input
                  className="flex-1"
                  placeholder="输出名，如 answer"
                  value={String(f.name ?? '')}
                  onChange={(e) => patchOutput(i, { name: e.target.value })}
                />
                <Input
                  className="flex-1"
                  placeholder="来源变量，如 llm_output"
                  value={String(f.from ?? '')}
                  onChange={(e) => patchOutput(i, { from: e.target.value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="x" size={13} />}
                  onClick={() => patch({ outputs: outputs.filter((_, idx) => idx !== i) })}
                  aria-label="删除输出字段"
                />
              </div>
              <Select
                value={String(f.type ?? 'any')}
                onChange={(e) => patchOutput(i, { type: e.target.value })}
                options={VALUE_TYPES}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="plus" size={13} />}
            onClick={() => patch({ outputs: [...outputs, { name: '', from: '', type: 'any' }] })}
          >
            添加输出字段
          </Button>
        </div>
      </Field>
    </div>
  );
}

function ConfigByType({
  type,
  config,
  patch,
  llmModels,
  datasets,
  rerankModels,
}: {
  type: string;
  config: Record<string, unknown>;
  patch: Patch;
  llmModels: Array<{ value: string; label: string }>;
  datasets: Array<{ value: string; label: string }>;
  rerankModels: Array<{ value: string; label: string }>;
}) {
  switch (type) {
    case 'start':
      return <StartConfig config={config} patch={patch} />;
    case 'llm':
      return <LlmConfig config={config} patch={patch} llmModels={llmModels} />;
    case 'knowledge_retrieval':
      return <KnowledgeConfig config={config} patch={patch} datasets={datasets} rerankModels={rerankModels} />;
    case 'intent':
      return <IntentConfig config={config} patch={patch} />;
    case 'condition':
      return <ConditionConfig config={config} patch={patch} />;
    case 'iteration':
      return <IterationConfig config={config} patch={patch} />;
    case 'code':
      return <CodeConfig config={config} patch={patch} />;
    case 'http_request':
      return <HttpConfig config={config} patch={patch} />;
    case 'template':
      return <TemplateConfig config={config} patch={patch} />;
    case 'end':
      return <EndConfig config={config} patch={patch} />;
    default:
      return <p className="text-xs text-ink-3">未知节点类型：{type}</p>;
  }
}

// ---------------------------------------------------------------------------
// 节点 / 边面板
// ---------------------------------------------------------------------------

export function NodePropertyPanel({
  node,
  onChange,
  onDelete,
  llmModels,
  datasets,
  rerankModels,
}: {
  node: Node<WorkflowNodeData>;
  onChange: (id: string, patch: { label?: string; config?: Record<string, unknown> }) => void;
  onDelete: (id: string) => void;
  llmModels: Array<{ value: string; label: string }>;
  datasets: Array<{ value: string; label: string }>;
  rerankModels: Array<{ value: string; label: string }>;
}) {
  const data = node.data;
  const meta = NODE_TYPE_META[node.type as keyof typeof NODE_TYPE_META];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-line-soft pb-3">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${meta?.color ?? '#7c5cff'}22`, color: meta?.color ?? '#7c5cff' }}
        >
          <Icon name={meta?.icon ?? 'box'} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{meta?.label ?? node.type}</div>
          <div className="truncate font-mono text-[11px] text-ink-3">{node.id}</div>
        </div>
        <Button
          size="sm"
          variant="danger-ghost"
          icon={<Icon name="trash" size={13} />}
          onClick={() => onDelete(node.id)}
        >
          删除
        </Button>
      </div>

      <Field label="节点名称">
        <Input value={data.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </Field>

      <ConfigByType
        type={node.type ?? ''}
        config={data.config}
        patch={(p) => onChange(node.id, { config: { ...data.config, ...p } })}
        llmModels={llmModels}
        datasets={datasets}
        rerankModels={rerankModels}
      />
    </div>
  );
}

export function EdgePropertyPanel({
  edge,
  sourceType,
  onChange,
  onDelete,
}: {
  edge: Edge<WorkflowEdgeData>;
  sourceType: string;
  onChange: (id: string, condition: Record<string, unknown> | undefined) => void;
  onDelete: (id: string) => void;
}) {
  const condition = edge.data?.condition;
  const label = edgeConditionLabel(condition);
  const isIntent = sourceType === 'intent';
  const isCondition = sourceType === 'condition';
  const isEditable = isIntent || isCondition;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-line-soft pb-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">连线属性</div>
          <div className="truncate font-mono text-[11px] text-ink-3">{edge.id}</div>
        </div>
        <Button
          size="sm"
          variant="danger-ghost"
          icon={<Icon name="trash" size={13} />}
          onClick={() => onDelete(edge.id)}
        >
          删除
        </Button>
      </div>

      {!isEditable && (
        <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-ink-3">
          该连线源节点为普通节点，引擎按顺序执行，无需配置条件。
        </p>
      )}

      {isIntent && (
        <div className="space-y-3">
          <Field label="分支名" hint="意图命中该分支后沿此边流转">
            <Input
              value={condition?.branch ?? ''}
              onChange={(e) => onChange(edge.id, { ...condition, branch: e.target.value })}
              placeholder="如 产品咨询"
            />
          </Field>
          <Field label="示例问法（逗号分隔）" hint="用于意图分类训练/匹配">
            <Textarea
              rows={3}
              value={(condition?.examples ?? []).join('\n')}
              onChange={(e) =>
                onChange(edge.id, {
                  ...condition,
                  examples: e.target.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder={'你们卖什么？\n报价多少？'}
            />
          </Field>
          <p className="text-xs text-ink-3">清空分支名后，该边作为兜底分支。</p>
        </div>
      )}

      {isCondition && (
        <div className="space-y-3">
          <Field label="变量">
            <Input
              value={condition?.variable ?? ''}
              onChange={(e) => onChange(edge.id, { ...condition, variable: e.target.value })}
              placeholder="如 intent"
            />
          </Field>
          <Field label="操作符">
            <Select
              value={condition?.operator ?? 'eq'}
              onChange={(e) => onChange(edge.id, { ...condition, operator: e.target.value })}
              options={CONDITION_OPERATORS}
            />
          </Field>
          {condition?.operator !== 'is_empty' &&
            condition?.operator !== 'is_not_empty' &&
            condition?.operator !== 'truthy' &&
            condition?.operator !== 'falsy' && (
              <Field label="值" hint="字符串/数字/布尔/JSON">
                <Input
                  value={condition?.value === undefined ? '' : String(condition.value)}
                  onChange={(e) => {
                    const raw = e.target.value;
                    let v: unknown = raw;
                    if (raw === 'true') v = true;
                    else if (raw === 'false') v = false;
                    else if (raw !== '' && !Number.isNaN(Number(raw))) v = Number(raw);
                    onChange(edge.id, { ...condition, value: v });
                  }}
                  placeholder="比较值"
                />
              </Field>
            )}
          <p className="text-xs text-ink-3">
            当前条件：<b className="text-ink-2">{label || '（空 = 兜底/else 分支）'}</b>
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onChange(edge.id, undefined)}
            icon={<Icon name="x" size={13} />}
          >
            清除条件
          </Button>
        </div>
      )}
    </div>
  );
}
