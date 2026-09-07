import { useRef, useState } from 'react';
import type { DocumentView } from '@pulse/contracts';
import {
  useDeleteDocument,
  useDocuments,
  useIndexDocument,
  useUploadDocument,
} from '../../../hooks/useDocuments.js';
import { Button } from '../../../components/ui/Button.js';
import { Badge, statusTone } from '../../../components/ui/Badge.js';
import { Icon } from '../../../components/ui/Icon.js';
import { EmptyState } from '../../../components/ui/EmptyState.js';
import { ConfirmDialog } from '../../../components/ui/Modal.js';
import { TableShell, THead, Th, TBody, Tr, Td } from '../../../components/ui/Table.js';
import { Pagination } from '../../../components/ui/Pagination.js';
import { useToast } from '../../../components/ui/Toast.js';
import { formatBytes, timeAgo } from '../../../lib/format.js';

const STATUS_TEXT: Record<string, string> = {
  pending: '待索引',
  parsing: '解析中',
  splitting: '切分中',
  indexing: '向量化中',
  success: '已索引',
  failed: '失败',
};

export function DocumentsTab({ datasetId }: { datasetId: string }) {
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<DocumentView | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const { data, isLoading } = useDocuments(datasetId, page, 20);
  const uploadMutation = useUploadDocument(datasetId);
  const indexMutation = useIndexDocument(datasetId);
  const deleteMutation = useDeleteDocument(datasetId);

  const pickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPendingFiles(Array.from(files));
    setUploadOpen(true);
  };

  const doUpload = async () => {
    try {
      for (const f of pendingFiles) {
        await uploadMutation.mutateAsync(f);
      }
      toast.success(`已上传 ${pendingFiles.length} 个文档`);
      setUploadOpen(false);
      setPendingFiles([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '上传失败');
    }
  };

  const doIndex = async (doc: DocumentView) => {
    try {
      await indexMutation.mutateAsync(doc.id);
      toast.success(`「${doc.name}」索引完成`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '索引失败');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success('文档已删除');
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const busy = uploadMutation.isPending || indexMutation.isPending || deleteMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-3">
          支持 txt / md / pdf / docx / html / xlsx / xls，上传后先解析再触发索引
        </p>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".txt,.md,.pdf,.docx,.html,.htm,.xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => pickFiles(e.target.files)}
        />
        <Button icon={<Icon name="upload" size={15} />} onClick={() => fileRef.current?.click()}>
          上传文档
        </Button>
      </div>

      <TableShell>
        <THead>
          <Tr>
            <Th>文档</Th>
            <Th>状态</Th>
            <Th>大小</Th>
            <Th>Tokens</Th>
            <Th>上传时间</Th>
            <Th className="text-right">操作</Th>
          </Tr>
        </THead>
        <TBody>
          {isLoading && (
            <Tr>
              <Td colSpan={6} className="py-8 text-center text-ink-3">
                加载中…
              </Td>
            </Tr>
          )}
          {!isLoading && (data?.items.length ?? 0) === 0 && (
            <Tr>
              <Td colSpan={6} className="py-10">
                <EmptyState
                  icon="upload"
                  title="还没有文档"
                  description="上传文档后点击「索引」即可切分并向量化，供检索测试使用。"
                />
              </Td>
            </Tr>
          )}
          {data?.items.map((doc) => {
            const processing = ['parsing', 'splitting', 'indexing'].includes(doc.status);
            const indexed = doc.status === 'success';
            const failed = doc.status === 'failed';
            return (
              <Tr key={doc.id}>
                <Td className="font-medium text-ink">
                  <div className="flex items-center gap-2">
                    <Icon name="file" size={15} className="text-ink-3" />
                    <span className="max-w-[260px] truncate">{doc.name}</span>
                  </div>
                  {doc.error && <div className="mt-1 text-xs text-danger">{doc.error}</div>}
                </Td>
                <Td>
                  <Badge tone={statusTone(doc.status)} dot>
                    {STATUS_TEXT[doc.status] ?? doc.status}
                  </Badge>
                </Td>
                <Td className="text-ink-2">{formatBytes(doc.size)}</Td>
                <Td className="text-ink-2">{doc.tokens.toLocaleString()}</Td>
                <Td className="text-ink-3">{timeAgo(doc.createdAt)}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1.5">
                    {!processing && (
                      <Button
                        size="sm"
                        variant={failed ? 'primary' : 'secondary'}
                        icon={indexed ? <Icon name="refresh" size={13} /> : <Icon name="play" size={13} />}
                        loading={indexMutation.isPending && indexMutation.variables === doc.id}
                        onClick={() => doIndex(doc)}
                      >
                        {indexed ? '重新索引' : failed ? '重试索引' : '索引'}
                      </Button>
                    )}
                    {processing && (
                      <Button size="sm" variant="secondary" loading disabled>
                        索引中
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      icon={<Icon name="trash" size={13} />}
                      onClick={() => setDeleting(doc)}
                    >
                      删除
                    </Button>
                  </div>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </TableShell>

      <Pagination page={page} perPage={20} total={data?.total ?? 0} onChange={setPage} />

      {/* 上传确认 Modal */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/60" onClick={() => !busy && setUploadOpen(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-ink">确认上传</h3>
            <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-sm text-ink-2">
              {pendingFiles.map((f) => (
                <li key={f.name} className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-1.5">
                  <span className="truncate">{f.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-ink-3">{formatBytes(f.size)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setUploadOpen(false)} disabled={busy}>
                取消
              </Button>
              <Button onClick={doUpload} loading={busy} icon={<Icon name="upload" size={14} />}>
                上传 {pendingFiles.length} 个文件
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="删除文档"
        message={
          <>
            删除文档 <b className="text-ink">{deleting?.name}</b> 会同时删除其全部切片。
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
