import { useState } from 'react';
import type {
  CreateModelInput,
  CreateProviderInput,
  ModelTypeValue,
  ProviderPingResult,
  ProviderTypeValue,
  ProviderView,
} from '@pulse/contracts';
import { useProviders, useCreateProvider, useUpdateProvider, useDeleteProvider, usePingProvider } from '../../hooks/useProviders.js';
import { useModels, useCreateModel, useDeleteModel, useUpdateModel } from '../../hooks/useModels.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { Button } from '../../components/ui/Button.js';
import { Badge, statusTone } from '../../components/ui/Badge.js';
import { Icon } from '../../components/ui/Icon.js';
import { Card } from '../../components/ui/Table.js';
import { Field, Input, Select } from '../../components/ui/Input.js';
import { Switch } from '../../components/ui/Switch.js';
import { Modal, ConfirmDialog } from '../../components/ui/Modal.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { FullPageLoader, Spinner } from '../../components/ui/Spinner.js';
import { useToast } from '../../components/ui/Toast.js';
import { timeAgo } from '../../lib/format.js';
import { cn } from '../../lib/format.js';

const TYPE_LABEL: Record<ProviderTypeValue, string> = {
  openai: 'OpenAI',
  openai_compatible: 'OpenAI 兼容',
  anthropic: 'Anthropic',
};

const MODEL_TYPE_LABEL: Record<ModelTypeValue, string> = {
  llm: 'LLM',
  embedding: 'Embedding',
  rerank: 'Rerank',
};

const PROVIDER_TYPE_OPTIONS: Array<{ value: ProviderTypeValue; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai_compatible', label: 'OpenAI 兼容（如 DeepSeek / Moonshot）' },
  { value: 'anthropic', label: 'Anthropic' },
];

interface ProviderFormState {
  id?: string;
  type: ProviderTypeValue;
  name: string;
  description: string;
  baseUrl: string;
  apiKey: string;
  status: boolean;
}

interface ModelFormState {
  id?: string;
  providerId: string;
  name: string;
  modelType: ModelTypeValue;
  /** 备用模型 id（主模型瞬时失败时自动降级切换），存 model.config.fallbackModelId */
  fallbackModelId: string;
  status: boolean;
}

function emptyProviderForm(): ProviderFormState {
  return { type: 'openai_compatible', name: '', description: '', baseUrl: '', apiKey: '', status: true };
}

function emptyModelForm(providerId: string): ModelFormState {
  return { providerId, name: '', modelType: 'llm', fallbackModelId: '', status: true };
}

function ProviderFormModal({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: ProviderFormState;
  onClose: () => void;
}) {
  const toast = useToast();
  const createMutation = useCreateProvider();
  const updateMutation = useUpdateProvider(initial.id ?? '');
  const [form, setForm] = useState<ProviderFormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // open 变化时重置表单
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setForm(initial);
      setErrors({});
    }
  }

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = '请输入 Provider 名称';
    if (!form.apiKey.trim()) errs.apiKey = '请输入 API Key（mock 模式可填任意值）';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const input: CreateProviderInput = {
      type: form.type,
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      config: form.baseUrl.trim() ? { baseURL: form.baseUrl.trim() } : undefined,
      credentials: { apiKey: form.apiKey.trim() },
      status: form.status ? 'active' : 'disabled',
    };
    try {
      if (form.id) {
        await updateMutation.mutateAsync(input);
        toast.success('Provider 已更新');
      } else {
        await createMutation.mutateAsync(input);
        toast.success('Provider 已创建');
      }
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={form.id ? '编辑 Provider' : '新建 Provider'}
      description="配置模型提供方与凭据；MOCK_MODELS=true 时 API Key 可填任意值"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            onClick={submit}
            loading={createMutation.isPending || updateMutation.isPending}
          >
            {form.id ? '保存修改' : '创建 Provider'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="类型" required>
            <Select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as ProviderTypeValue }))}
              options={PROVIDER_TYPE_OPTIONS}
            />
          </Field>
          <Field label="名称" required error={errors.name}>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="例如：DeepSeek"
            />
          </Field>
        </div>
        <Field label="描述">
          <Input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="选填"
          />
        </Field>
        <Field label="Base URL" hint="可选，openai_compatible 通常需要，如 https://api.deepseek.com/v1">
          <Input
            value={form.baseUrl}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            placeholder="https://…"
          />
        </Field>
        <Field label="API Key" required error={errors.apiKey} hint="mock 模式下可填任意值（用于连通性测试）">
          <Input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            placeholder="sk-…"
          />
        </Field>
        <div className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-4 py-3">
          <div>
            <div className="text-sm text-ink">启用 Provider</div>
            <div className="text-xs text-ink-3">停用后其下模型不可被调用</div>
          </div>
          <Switch checked={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} label="启用状态" />
        </div>
      </div>
    </Modal>
  );
}

function PingResultView({ result }: { result: ProviderPingResult }) {
  return (
    <div
      className={cn(
        'mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
        result.ok ? 'border-success/40 bg-success-soft text-success' : 'border-danger/40 bg-danger-soft text-danger',
      )}
    >
      <Icon name={result.ok ? 'check' : 'alert'} size={14} className="mt-px shrink-0" />
      <div className="min-w-0">
        <div className="font-medium">
          {result.ok ? `连通正常 · ${result.latencyMs}ms` : '连通失败'}
          {result.model ? ` · ${result.model}` : ''}
        </div>
        {result.message && <div className="mt-0.5 break-words opacity-90">{result.message}</div>}
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ProviderView & { modelCount: number };
  onEdit: (p: typeof provider) => void;
  onDelete: (p: typeof provider) => void;
}) {
  const { data: models, isLoading } = useModels(provider.id);
  const { data: allModels } = useModels();
  const deleteModel = useDeleteModel(provider.id);
  const pingMutation = usePingProvider(provider.id);
  const toast = useToast();
  const [modelOpen, setModelOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelFormState | null>(null);
  const [deletingModel, setDeletingModel] = useState<{ id: string; name: string } | null>(null);
  const [pingResult, setPingResult] = useState<ProviderPingResult | null>(null);
  const [expanded, setExpanded] = useState(true);
  const modelNameOf = (id: string) => allModels?.find((m) => m.id === id)?.name ?? id;

  const runPing = async () => {
    setPingResult(null);
    try {
      const res = await pingMutation.mutateAsync();
      setPingResult(res);
    } catch (e) {
      setPingResult({
        providerId: provider.id,
        type: provider.type,
        ok: false,
        latencyMs: 0,
        message: e instanceof Error ? e.message : '连通性测试失败',
      });
    }
  };

  const confirmDeleteModel = async () => {
    if (!deletingModel) return;
    try {
      await deleteModel.mutateAsync(deletingModel.id);
      toast.success('模型已删除');
      setDeletingModel(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <Card padded={false} className="overflow-hidden">
      {/* Provider 头部 */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary-strong">
              <Icon name="cpu" size={18} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-ink">{provider.name}</span>
                <Badge tone="primary">{TYPE_LABEL[provider.type] ?? provider.type}</Badge>
                <Badge tone={statusTone(provider.status)} dot>
                  {provider.status === 'active' ? '启用' : '停用'}
                </Badge>
              </div>
              <div className="mt-0.5 text-xs text-ink-3">
                {provider.description || '暂无描述'}
              </div>
            </div>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onEdit(provider)}
              className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
              aria-label="编辑"
            >
              <Icon name="edit" size={15} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(provider)}
              className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger"
              aria-label="删除"
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone={provider.hasCredentials ? 'success' : 'warning'} dot>
            {provider.hasCredentials ? '凭据已配置' : '未配置凭据'}
          </Badge>
          <Badge tone="neutral">{provider.modelCount} 个模型</Badge>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"
          >
            {expanded ? '收起' : '展开'}模型
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="plus" size={13} />}
            onClick={() => {
              setEditingModel(null);
              setModelOpen(true);
            }}
          >
            注册模型
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="zap" size={13} />}
            onClick={runPing}
            loading={pingMutation.isPending}
          >
            Ping 连通测试
          </Button>
        </div>

        {pingResult && <PingResultView result={pingResult} />}
      </div>

      {/* 模型列表 */}
      {expanded && (
        <div className="border-t border-line-soft">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-6 text-ink-3">
              <Spinner size={16} />
              <span className="text-sm">加载模型…</span>
            </div>
          )}
          {!isLoading && models?.length === 0 && (
            <p className="px-5 py-6 text-center text-sm text-ink-3">
              暂无模型 —— 点击「注册模型」添加（mock 模式可任意命名）
            </p>
          )}
          {!isLoading && (models?.length ?? 0) > 0 && (
            <div className="divide-y divide-line-soft">
              {models?.map((m) => (
                <div key={m.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      m.modelType === 'llm' ? 'bg-primary-soft text-primary-strong' : 'bg-info-soft text-info',
                    )}
                  >
                    <Icon name={m.modelType === 'llm' ? 'cpu' : 'database'} size={12} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-ink">{m.name}</span>
                    <span className="ml-2 text-xs text-ink-3">{MODEL_TYPE_LABEL[m.modelType] ?? m.modelType}</span>
                    {m.modelType === 'llm' && typeof m.config?.fallbackModelId === 'string' && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs text-primary-strong">
                        <Icon name="arrow-right" size={11} />
                        降级 → {modelNameOf(m.config.fallbackModelId)}
                      </span>
                    )}
                  </div>
                  <Badge tone={statusTone(m.status)} dot>
                    {m.status === 'active' ? '启用' : '停用'}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingModel({
                        id: m.id,
                        providerId: provider.id,
                        name: m.name,
                        modelType: m.modelType,
                        fallbackModelId: (m.config?.fallbackModelId as string) ?? '',
                        status: m.status === 'active',
                      });
                      setModelOpen(true);
                    }}
                    className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
                    aria-label="编辑模型"
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeletingModel({ id: m.id, name: m.name })}
                    className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger"
                    aria-label="删除模型"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-line-soft bg-surface-2/50 px-5 py-2 text-[11px] text-ink-3">
        <span>创建于 {timeAgo(provider.createdAt)}</span>
        <span>{timeAgo(provider.updatedAt)} 更新</span>
      </div>

      <Modal
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        width="sm"
      >
        <ModelFormInner
          key={modelOpen ? (editingModel?.id ?? 'new') : 'closed'}
          initial={editingModel ?? emptyModelForm(provider.id)}
          onDone={() => setModelOpen(false)}
        />
      </Modal>

      <ConfirmDialog
        open={deletingModel !== null}
        title="删除模型"
        message={
          <>
            确定删除模型 <b className="text-ink">{deletingModel?.name}</b> 吗？
          </>
        }
        danger
        loading={deleteModel.isPending}
        onConfirm={confirmDeleteModel}
        onClose={() => setDeletingModel(null)}
      />
    </Card>
  );
}

/** 模型表单独立组件（配合 Modal 使用，复用 ModelFormModal 逻辑） */
function ModelFormInner({ initial, onDone }: { initial: ModelFormState; onDone: () => void }) {
  const toast = useToast();
  const createMutation = useCreateModel(initial.providerId);
  const updateMutation = useUpdateModel(initial.providerId);
  const { data: allModels } = useModels();
  const [form, setForm] = useState<ModelFormState>(initial);
  const [error, setError] = useState('');

  // 全局 llm 模型（可作备用模型）：排除自身；跨 Provider 也可（降级即切换另一 provider）
  const llmCandidates =
    (allModels ?? []).filter((m) => m.modelType === 'llm' && m.status === 'active' && m.id !== form.id) ?? [];

  const submit = async () => {
    if (!form.name.trim()) {
      setError('请输入模型名称');
      return;
    }
    const input: CreateModelInput = {
      providerId: form.providerId,
      name: form.name.trim(),
      modelType: form.modelType,
      config: form.fallbackModelId.trim() ? { fallbackModelId: form.fallbackModelId.trim() } : undefined,
      status: form.status ? 'active' : 'disabled',
    };
    try {
      if (form.id) {
        await updateMutation.mutateAsync({ id: form.id, input });
        toast.success('模型已更新');
      } else {
        await createMutation.mutateAsync(input);
        toast.success('模型已注册');
      }
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  return (
    <div className="space-y-4">
      <Field label="模型名称" required error={error} hint="例如 gpt-4o-mini / deepseek-chat / text-embedding-3-small">
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="模型名称（后端模型名）"
        />
      </Field>
      <Field label="模型类型" required>
        <Select
          value={form.modelType}
          onChange={(e) => setForm((f) => ({ ...f, modelType: e.target.value as ModelTypeValue }))}
          options={[
            { value: 'llm', label: 'llm（对话生成）' },
            { value: 'embedding', label: 'embedding（向量化）' },
            { value: 'rerank', label: 'rerank（重排）' },
          ]}
        />
      </Field>
      {form.modelType === 'llm' && (
        <Field
          label="备用模型"
          hint="主模型瞬时失败（上游不可用/5xx/网络错误）时自动降级切换；留空不降级"
        >
          <Select
            value={form.fallbackModelId}
            onChange={(e) => setForm((f) => ({ ...f, fallbackModelId: e.target.value }))}
            options={[
              { value: '', label: '（不启用降级）' },
              ...llmCandidates.map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </Field>
      )}
      <div className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-4 py-3">
        <div>
          <div className="text-sm text-ink">启用模型</div>
          <div className="text-xs text-ink-3">停用后不可被调用</div>
        </div>
        <Switch checked={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} label="启用状态" />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onDone}>取消</Button>
        <Button onClick={submit} loading={createMutation.isPending || updateMutation.isPending}>
          {form.id ? '保存修改' : '注册模型'}
        </Button>
      </div>
    </div>
  );
}

export function ModelsPage() {
  const { data: providers, isLoading, isError } = useProviders();
  const deleteMutation = useDeleteProvider();
  const toast = useToast();
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderFormState | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success('Provider 已删除');
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div>
      <PageHeader
        title="模型配置"
        description="管理模型提供方（Provider）与模型注册；配置 API Key 后可做连通性测试"
        actions={
          <Button
            icon={<Icon name="plus" size={15} />}
            onClick={() => {
              setEditingProvider(null);
              setProviderFormOpen(true);
            }}
          >
            新建 Provider
          </Button>
        }
      />

      {isLoading && <FullPageLoader />}
      {isError && (
        <EmptyState icon="alert" title="加载失败" description="请确认后端已启动后刷新重试。" />
      )}
      {!isLoading && !isError && (providers?.length ?? 0) === 0 && (
        <EmptyState
          icon="settings"
          title="还没有 Provider"
          description="新建一个模型提供方并配置 API Key，即可注册模型进行对话与向量化。"
          action={
            <Button
              icon={<Icon name="plus" size={15} />}
              onClick={() => {
                setEditingProvider(null);
                setProviderFormOpen(true);
              }}
            >
              新建 Provider
            </Button>
          }
        />
      )}
      {!isLoading && !isError && (providers?.length ?? 0) > 0 && (
        <div className="space-y-4">
          {providers?.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              onEdit={(prov) => {
                setEditingProvider({
                  id: prov.id,
                  type: prov.type,
                  name: prov.name,
                  description: prov.description ?? '',
                  baseUrl: (prov.config?.baseURL as string) ?? '',
                  apiKey: '',
                  status: prov.status === 'active',
                });
                setProviderFormOpen(true);
              }}
              onDelete={(prov) => setDeleting({ id: prov.id, name: prov.name })}
            />
          ))}
        </div>
      )}

      <ProviderFormModal
        key={providerFormOpen ? (editingProvider?.id ?? 'new') : 'closed'}
        open={providerFormOpen}
        initial={editingProvider ?? emptyProviderForm()}
        onClose={() => setProviderFormOpen(false)}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除 Provider"
        message={
          <>
            删除 Provider <b className="text-ink">{deleting?.name}</b> 将同时删除其下全部模型，不可恢复。
          </>
        }
        danger
        loading={deleteMutation.isPending}
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
