import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDataset, useDeleteDataset } from '../../hooks/useDatasets.js';
import { useDocuments } from '../../hooks/useDocuments.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { Button } from '../../components/ui/Button.js';
import { Badge, statusTone } from '../../components/ui/Badge.js';
import { Icon } from '../../components/ui/Icon.js';
import { Card } from '../../components/ui/Table.js';
import { Tabs } from '../../components/ui/Tabs.js';
import { ConfirmDialog } from '../../components/ui/Modal.js';
import { FullPageLoader } from '../../components/ui/Spinner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { useToast } from '../../components/ui/Toast.js';
import { DocumentsTab } from './parts/DocumentsTab.js';
import { SegmentsTab } from './parts/SegmentsTab.js';
import { RetrievalTab } from './parts/RetrievalTab.js';
export function DatasetDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState('documents');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: dataset, isLoading, isError } = useDataset(id);
  const { data: docs } = useDocuments(id ?? '', 1, 1);
  const deleteMutation = useDeleteDataset();

  if (isLoading) return <FullPageLoader />;
  if (isError || !dataset) {
    return (
      <EmptyState
        icon="alert"
        title="知识库不存在或加载失败"
        description="可能已被删除，或后端不可用。"
        action={
          <Link to="/datasets">
            <Button variant="secondary">返回知识库列表</Button>
          </Link>
        }
      />
    );
  }

  const doDelete = async () => {
    try {
      await deleteMutation.mutateAsync(dataset.id);
      toast.success('知识库已删除');
      navigate('/datasets');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
      setConfirmDelete(false);
    }
  };

  const indexedCount = docs?.items.filter((d) => d.status === 'success').length ?? 0;

  return (
    <div>
      <PageHeader
        title={dataset.name}
        description={dataset.description ?? '暂无描述'}
        backTo="/datasets"
        backLabel="知识库"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Icon name="edit" size={15} />}
              onClick={() => navigate(`/datasets/${dataset.id}/edit`)}
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
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetaCard label="Embedding 模型" value={dataset.embeddingModelName ?? '未绑定（mock 可索引）'} />
        <MetaCard label="切分策略" value={dataset.splitter} />
        <MetaCard label="chunkSize / Overlap" value={`${dataset.chunkSize} / ${dataset.chunkOverlap}`} />
        <MetaCard
          label="文档 / 已索引"
          value={`${dataset.docCount} / ${indexedCount}`}
          trailing={
            <Badge tone={statusTone(dataset.status)} dot>
              {dataset.status === 'active' ? '启用' : '停用'}
            </Badge>
          }
        />
      </div>

      <Tabs
        items={[
          { key: 'documents', label: '文档', count: dataset.docCount },
          { key: 'segments', label: '切片', count: docs?.items.length ? undefined : undefined },
          { key: 'retrieval', label: '检索测试', icon: <Icon name="search" size={14} /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'documents' && <DocumentsTab datasetId={dataset.id} />}
      {tab === 'segments' && <SegmentsTab datasetId={dataset.id} />}
      {tab === 'retrieval' && <RetrievalTab datasetId={dataset.id} />}

      <ConfirmDialog
        open={confirmDelete}
        title="删除知识库"
        message={
          <>
            删除知识库 <b className="text-ink">{dataset.name}</b> 将同时删除全部文档与切片，不可恢复。
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
