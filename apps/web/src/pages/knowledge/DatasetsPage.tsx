import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DatasetView } from '@pulse/contracts';
import { useDatasets, useDeleteDataset } from '../../hooks/useDatasets.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { Button } from '../../components/ui/Button.js';
import { Icon } from '../../components/ui/Icon.js';
import { Badge, statusTone } from '../../components/ui/Badge.js';
import { ConfirmDialog } from '../../components/ui/Modal.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { FullPageLoader } from '../../components/ui/Spinner.js';
import { useToast } from '../../components/ui/Toast.js';
import { timeAgo } from '../../lib/format.js';

const SPLITTER_LABEL: Record<string, string> = {
  delimiter: '分隔符切分',
  recursive: '递归字符切分',
  sliding: '滑动窗口切分',
};

function DatasetCard({ dataset, onDelete }: { dataset: DatasetView; onDelete: (id: string) => void }) {
  return (
    <div className="group rounded-xl border border-line bg-surface p-5 transition-all hover:border-primary/40 hover:shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-semibold"
            style={{ backgroundColor: 'var(--color-primary-soft)', color: 'var(--color-primary-strong)' }}
          >
            {dataset.icon || dataset.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <div className="flex items-center gap-2">
              <Link
                to={`/datasets/${dataset.id}`}
                className="text-sm font-semibold text-ink hover:text-primary-strong"
              >
                {dataset.name}
              </Link>
              <Badge tone={statusTone(dataset.status)} dot>
                {dataset.status === 'active' ? '启用' : '停用'}
              </Badge>
            </div>
            <div className="mt-0.5 text-xs text-ink-3">
              {dataset.embeddingModelName ?? '未绑定 Embedding 模型'}
            </div>
          </div>
        </div>
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Link
            to={`/datasets/${dataset.id}/edit`}
            className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
            aria-label="编辑"
          >
            <Icon name="edit" size={15} />
          </Link>
          <button
            type="button"
            onClick={() => onDelete(dataset.id)}
            className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger"
            aria-label="删除"
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2rem] text-[13px] text-ink-3">
        {dataset.description || '暂无描述'}
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line-soft pt-3 text-center">
        <div>
          <div className="text-sm font-semibold text-ink">{dataset.docCount}</div>
          <div className="text-[11px] text-ink-3">文档</div>
        </div>
        <div>
          <div className="text-sm font-semibold text-ink">{dataset.chunkSize}</div>
          <div className="text-[11px] text-ink-3">chunkSize</div>
        </div>
        <div>
          <div className="text-sm font-semibold text-ink">{dataset.chunkOverlap}</div>
          <div className="text-[11px] text-ink-3">重叠</div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-ink-3">
        <span>{SPLITTER_LABEL[dataset.splitter] ?? dataset.splitter}</span>
        <span>{timeAgo(dataset.updatedAt)} 更新</span>
      </div>
    </div>
  );
}

export function DatasetsPage() {
  const { data, isLoading, isError } = useDatasets();
  const deleteMutation = useDeleteDataset();
  const navigate = useNavigate();
  const toast = useToast();
  const [deleting, setDeleting] = useState<DatasetView | null>(null);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success(`知识库「${deleting.name}」已删除`);
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div>
      <PageHeader
        title="知识库"
        description="管理文档数据集：切分策略、Embedding 绑定、文档索引与检索测试"
        actions={
          <Link to="/datasets/new">
            <Button icon={<Icon name="plus" size={15} />}>新建知识库</Button>
          </Link>
        }
      />

      {isLoading && <FullPageLoader />}
      {isError && (
        <EmptyState
          icon="alert"
          title="加载失败"
          description="请确认后端 API 已启动（mock 模式），再刷新重试。"
          action={
            <Button variant="secondary" onClick={() => navigate(0)}>
              刷新
            </Button>
          }
        />
      )}
      {!isLoading && !isError && (data?.length ?? 0) === 0 && (
        <EmptyState
          icon="database"
          title="还没有知识库"
          description="创建第一个知识库，上传文档后即可进行切分、索引与检索测试。"
          action={
            <Link to="/datasets/new">
              <Button icon={<Icon name="plus" size={15} />}>新建知识库</Button>
            </Link>
          }
        />
      )}
      {!isLoading && !isError && (data?.length ?? 0) > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data?.map((ds) => (
            <DatasetCard key={ds.id} dataset={ds} onDelete={() => setDeleting(ds)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="删除知识库"
        message={
          <>
            确定删除知识库 <b className="text-ink">{deleting?.name}</b> 吗？其下全部文档与切片将一并删除，此操作不可恢复。
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
