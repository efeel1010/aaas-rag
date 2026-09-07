/**
 * API 调用文档查看弹窗。
 * 展示资源（智能体/工作流）的 Markdown 格式调用文档：
 *  - 全文查看（等宽字体，保留 md 结构）；
 *  - 一键整体复制全文（解决分块 CodeBlock 无法整体复制的问题）；
 *  - 下载 .md 文件，便于归档 / 分享给第三方。
 */
import { useMemo } from 'react';
import { Modal } from './Modal.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { useToast } from './Toast.js';

interface ApiDocModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Markdown 文档原文 */
  markdown: string;
  /** 下载文件名（不含扩展名） */
  fileName?: string;
  /** 加载中（文档异步生成时传入） */
  loading?: boolean;
}

export function ApiDocModal({
  open,
  onClose,
  title,
  markdown,
  fileName = 'api-doc',
  loading = false,
}: ApiDocModalProps) {
  const toast = useToast();

  const safeName = useMemo(() => {
    const n = fileName.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return n || 'api-doc';
  }, [fileName]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success('文档已整体复制');
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  const download = () => {
    try {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('文档已开始下载');
    } catch {
      toast.error('下载失败，请稍后重试');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="xl"
      title={title}
      description="Markdown 格式 API 调用文档，可整体复制或下载"
      footer={
        <>
          <Button variant="ghost" icon={<Icon name="copy" size={14} />} onClick={copyAll} disabled={loading}>
            复制全文
          </Button>
          <Button variant="secondary" icon={<Icon name="download" size={14} />} onClick={download} disabled={loading}>
            下载 .md
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-3">
          <Spinner size={16} /> 文档生成中…
        </div>
      ) : (
        <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line-soft bg-surface-2 p-4 font-mono text-[12px] leading-relaxed text-ink-2">
          {markdown}
        </pre>
      )}
    </Modal>
  );
}
