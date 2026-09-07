import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CreateDatasetInput, SplitterType } from '@pulse/contracts';
import { useCreateDataset, useDataset, useUpdateDataset } from '../../hooks/useDatasets.js';
import { useModels } from '../../hooks/useModels.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { Button } from '../../components/ui/Button.js';
import { Field, Input, Select, Textarea } from '../../components/ui/Input.js';
import { Switch } from '../../components/ui/Switch.js';
import { Card } from '../../components/ui/Table.js';
import { useToast } from '../../components/ui/Toast.js';
import { FullPageLoader } from '../../components/ui/Spinner.js';
import { Icon } from '../../components/ui/Icon.js';

const SPLITTER_OPTIONS: Array<{ value: SplitterType; label: string; hint: string }> = [
  { value: 'delimiter', label: '分隔符切分（delimiter）', hint: '按空行/段落分隔符切分，忠实原文结构' },
  { value: 'recursive', label: '递归字符切分（recursive）', hint: '按多级分隔符递归切分至 chunkSize，通用性最佳' },
  { value: 'sliding', label: '滑动窗口切分（sliding）', hint: '固定窗口 + 重叠滑窗，保留上下文连续性' },
];

const COLOR_PRESETS = ['#7c5cff', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#a78bfa', '#fb923c'];

export function DatasetFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { data: dataset, isLoading: dsLoading } = useDataset(id);
  const { data: models } = useModels();
  const createMutation = useCreateDataset();
  const updateMutation = useUpdateDataset(id ?? '');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [embeddingModelId, setEmbeddingModelId] = useState('');
  const [splitter, setSplitter] = useState<SplitterType>('recursive');
  const [chunkSize, setChunkSize] = useState('800');
  const [chunkOverlap, setChunkOverlap] = useState('100');
  const [status, setStatus] = useState(true);
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('#7c5cff');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (dataset) {
      setName(dataset.name);
      setDescription(dataset.description ?? '');
      setEmbeddingModelId(dataset.embeddingModelId ?? '');
      setSplitter(dataset.splitter);
      setChunkSize(String(dataset.chunkSize));
      setChunkOverlap(String(dataset.chunkOverlap));
      setStatus(dataset.status === 'active');
      setIcon(dataset.icon ?? '');
      setColor(dataset.color ?? '#7c5cff');
    }
  }, [dataset]);

  const embeddingModels = (models ?? []).filter((m) => m.modelType === 'embedding');

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = '请输入知识库名称';
    const cs = Number(chunkSize);
    const co = Number(chunkOverlap);
    if (!Number.isInteger(cs) || cs < 64 || cs > 8192) errs.chunkSize = 'chunkSize 须为 64–8192 的整数';
    if (!Number.isInteger(co) || co < 0 || co > 4096) errs.chunkOverlap = 'chunkOverlap 须为 0–4096 的整数';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const input: CreateDatasetInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      splitter,
      chunkSize: cs,
      chunkOverlap: co,
      status: status ? 'active' : 'disabled',
      icon: icon.trim() || undefined,
      color,
      embeddingModelId: embeddingModelId || undefined,
    };

    try {
      if (isEdit) {
        const updated = await updateMutation.mutateAsync(input);
        toast.success('知识库已更新');
        navigate(`/datasets/${updated.id}`);
      } else {
        const created = await createMutation.mutateAsync(input);
        toast.success('知识库已创建');
        navigate(`/datasets/${created.id}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  if (isEdit && dsLoading) return <FullPageLoader />;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={isEdit ? '编辑知识库' : '新建知识库'}
        description="配置切分策略与 Embedding 模型，后续上传的文档将按此策略切分并向量化"
        backTo="/datasets"
      />

      <div className="space-y-5">
        <Card>
          <h3 className="mb-4 text-sm font-semibold text-ink">基本信息</h3>
          <div className="space-y-4">
            <Field label="名称" required error={errors.name}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：产品知识库"
              />
            </Field>
            <Field label="描述" hint="一句话描述该知识库的用途">
              <Textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="选填"
              />
            </Field>
            <Field
              label="Embedding 模型"
              hint={
                embeddingModels.length === 0
                  ? '当前没有可用的 embedding 模型 —— 在「模型配置」页注册；mock 模式下可先留空直接索引'
                  : '文档向量化使用的模型（须为 embedding 类型且启用）'
              }
            >
              <Select
                value={embeddingModelId}
                onChange={(e) => setEmbeddingModelId(e.target.value)}
                options={[
                  { value: '', label: '（未绑定 —— mock 模式可自动向量化）' },
                  ...embeddingModels.map((m) => ({
                    value: m.id,
                    label: `${m.name}（${m.providerId.slice(0, 8)}…）`,
                  })),
                ]}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="图标字符" hint="单字符，展示在卡片上">
                <Input
                  maxLength={2}
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="选填，默认取首字"
                />
              </Field>
              <Field label="主题色">
                <div className="flex h-9 items-center gap-2">
                  {COLOR_PRESETS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={`h-6 w-6 rounded-full border-2 transition-transform ${
                        color === c ? 'scale-110 border-ink' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: c }}
                      aria-label={`颜色 ${c}`}
                    />
                  ))}
                </div>
              </Field>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-line-soft bg-surface-2 px-4 py-3">
              <div>
                <div className="text-sm text-ink">启用知识库</div>
                <div className="text-xs text-ink-3">停用后不可被检索/Agent 使用</div>
              </div>
              <Switch checked={status} onChange={setStatus} label="启用状态" />
            </div>
          </div>
        </Card>

        <Card>
          <h3 className="mb-1 text-sm font-semibold text-ink">切分策略</h3>
          <p className="mb-4 text-xs text-ink-3">决定文档如何被切分为可检索的切片（chunk）</p>
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {SPLITTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSplitter(opt.value)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    splitter === opt.value
                      ? 'border-primary bg-primary-soft'
                      : 'border-line bg-surface-2 hover:border-line-strong'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-ink">
                    {splitter === opt.value && <Icon name="check" size={14} className="text-primary-strong" />}
                    {opt.label.split('（')[0]}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-ink-3">{opt.hint}</div>
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="chunkSize" required hint="单切片目标字符数（64–8192）" error={errors.chunkSize}>
                <Input
                  type="number"
                  value={chunkSize}
                  onChange={(e) => setChunkSize(e.target.value)}
                />
              </Field>
              <Field label="chunkOverlap" required hint="相邻切片重叠字符数（0–4096）" error={errors.chunkOverlap}>
                <Input
                  type="number"
                  value={chunkOverlap}
                  onChange={(e) => setChunkOverlap(e.target.value)}
                />
              </Field>
            </div>
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            取消
          </Button>
          <Button onClick={submit} loading={createMutation.isPending || updateMutation.isPending}>
            {isEdit ? '保存修改' : '创建知识库'}
          </Button>
        </div>
      </div>
    </div>
  );
}
