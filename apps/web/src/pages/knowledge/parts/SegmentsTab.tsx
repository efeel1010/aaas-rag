import { useMemo, useState } from 'react';
import type { SegmentView } from '@pulse/contracts';
import { useDocuments } from '../../../hooks/useDocuments.js';
import { useDeleteSegment, useSegments, useUpdateSegment } from '../../../hooks/useSegments.js';
import { Button } from '../../../components/ui/Button.js';
import { Icon } from '../../../components/ui/Icon.js';
import { Badge } from '../../../components/ui/Badge.js';
import { EmptyState } from '../../../components/ui/EmptyState.js';
import { ConfirmDialog, Modal } from '../../../components/ui/Modal.js';
import { Pagination } from '../../../components/ui/Pagination.js';
import { Select, Textarea } from '../../../components/ui/Input.js';
import { useToast } from '../../../components/ui/Toast.js';
import { shortId } from '../../../lib/format.js';

export function SegmentsTab({ datasetId }: { datasetId: string }) {
  const [page, setPage] = useState(1);
  const [documentId, setDocumentId] = useState('');
  const [editing, setEditing] = useState<SegmentView | null>(null);
  const [editContent, setEditContent] = useState('');
  const [deleting, setDeleting] = useState<SegmentView | null>(null);
  const toast = useToast();

  const { data, isLoading } = useSegments(datasetId, { page, perPage: 10, documentId: documentId || undefined });
  const { data: documents } = useDocuments(datasetId, 1, 200);
  const updateMutation = useUpdateSegment(datasetId);
  const deleteMutation = useDeleteSegment(datasetId);

  const docNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of documents?.items ?? []) map.set(d.id, d.name);
    return map;
  }, [documents]);

  const openEdit = (seg: SegmentView) => {
    setEditing(seg);
    setEditContent(seg.content);
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editContent.trim()) {
      toast.error('切片内容不能为空');
      return;
    }
    try {
      await updateMutation.mutateAsync({ segmentId: editing.id, input: { content: editContent } });
      toast.success('切片已更新并重新向量化');
      setEditing(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success('切片已删除');
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Select
          className="w-72"
          value={documentId}
          onChange={(e) => {
            setDocumentId(e.target.value);
            setPage(1);
          }}
          options={[
            { value: '', label: '全部文档' },
            ...(documents?.items ?? []).map((d) => ({ value: d.id, label: d.name })),
          ]}
        />
        <span className="text-sm text-ink-3">
          共 {data?.total ?? 0} 个切片
        </span>
      </div>

      {isLoading && <div className="py-10 text-center text-ink-3">加载中…</div>}
      {!isLoading && (data?.items.length ?? 0) === 0 && (
        <EmptyState
          icon="layers"
          title="暂无切片"
          description="对文档触发「索引」后，切分产生的片段会显示在这里，可编辑或删除。"
        />
      )}

      <div className="space-y-3">
        {data?.items.map((seg) => (
          <div
            key={seg.id}
            className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-ink-3">
                <Badge tone="neutral">#{shortId(seg.id, 8)}</Badge>
                <span className="flex items-center gap-1">
                  <Icon name="file" size={12} />
                  {docNameMap.get(seg.documentId) ?? shortId(seg.documentId)}
                </span>
                <span>{seg.tokens} tokens</span>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="edit" size={13} />}
                  onClick={() => openEdit(seg)}
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  icon={<Icon name="trash" size={13} />}
                  onClick={() => setDeleting(seg)}
                />
              </div>
            </div>
            <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
              {seg.content}
            </p>
          </div>
        ))}
      </div>

      <Pagination page={page} perPage={10} total={data?.total ?? 0} onChange={setPage} />

      {/* 编辑 Modal */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="编辑切片"
        description="修改文本后会自动重新向量化，确保向量与内容一致"
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={saveEdit} loading={updateMutation.isPending}>
              保存并向量化
            </Button>
          </>
        }
      >
        <Textarea
          rows={10}
          className="font-mono text-[13px]"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
        />
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="删除切片"
        message="删除后该切片将不再参与检索，确定删除吗？"
        danger
        loading={deleteMutation.isPending}
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
