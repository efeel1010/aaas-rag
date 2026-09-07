/**
 * 资源级「调用 API / 分享链接」弹窗（智能体 / 工作流）。
 *  - Token Tab：生成 / 重置独立 token；明文仅在生成/重置后显示一次；
 *  - 分享链接 Tab：创建可公开分享的链接（无需 Bearer 凭据），供第三方网站/终端用户调用；
 *  - 文档区：请求方法、鉴权、请求体 / 响应体 / curl 示例，便于第三方接入。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ApiKeyResourceType, ResourceApiAccess, ShareLinkView } from '@pulse/contracts';
import {
  createResourceApiAccess,
  createShareLink,
  deleteShareLink,
  getResourceApiAccess,
  listShareLinks,
  revokeShareLink,
  rotateResourceApiAccess,
} from '../../api/apiKeys.js';
import { Modal } from './Modal.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Badge } from './Badge.js';
import { Spinner } from './Spinner.js';
import { useToast } from './Toast.js';
import { ApiDocModal } from './ApiDocModal.js';
import { buildApiDocMarkdown } from '../../lib/apiDoc.js';
import { cn, timeAgo } from '../../lib/format.js';

interface ApiAccessModalProps {
  open: boolean;
  onClose: () => void;
  resourceType: ApiKeyResourceType;
  resourceId: string;
  resourceName: string;
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(`${label} 已复制`);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line-soft">
      <div className="flex items-center justify-between bg-surface-2 px-3 py-1.5">
        <span className="text-xs font-medium text-ink-3">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          <Icon name="copy" size={12} />
          复制
        </button>
      </div>
      <pre className="overflow-x-auto bg-surface px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink-2">
        {code}
      </pre>
    </div>
  );
}

export function ApiAccessModal({
  open,
  onClose,
  resourceType,
  resourceId,
  resourceName,
}: ApiAccessModalProps) {
  const toast = useToast();
  const [access, setAccess] = useState<ResourceApiAccess | null>(null);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'api' | 'share'>('api');
  const [shareLinks, setShareLinks] = useState<ShareLinkView[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [docOpen, setDocOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAccess(null);
    setPlaintext(null);
    setLoading(true);
    setTab('api');
    getResourceApiAccess(resourceType, resourceId)
      .then(setAccess)
      .catch(() => setAccess(null))
      .finally(() => setLoading(false));
    listShareLinks(resourceType, resourceId)
      .then(setShareLinks)
      .catch(() => setShareLinks([]));
  }, [open, resourceType, resourceId]);

  const base = `${window.location.origin}/api/v1`;

  const { endpoint, streamEndpoint, body, response, curl } = useMemo(() => {
    if (resourceType === 'agent') {
      return {
        endpoint: `POST ${base}/agents/${resourceId}/chat`,
        streamEndpoint: `POST ${base}/agents/${resourceId}/chat/stream`,
        body: JSON.stringify({ query: '介绍一下你自己' }, null, 2),
        response: JSON.stringify(
          { success: true, data: { content: 'Agent 的回答…', usage: { inputTokens: 12, outputTokens: 30 } } },
          null,
          2,
        ),
        curl: `curl -X POST '${base}/agents/${resourceId}/chat' \\\n  -H 'Authorization: Bearer <你的 Token>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{ "query": "介绍一下你自己" }'`,
      };
    }
    return {
      endpoint: `POST ${base}/workflows/run`,
      streamEndpoint: `POST ${base}/workflows/run/stream`,
      body: JSON.stringify({ workflowId: resourceId, inputs: { query: '分析某个研究课题' } }, null, 2),
      response: JSON.stringify(
        { success: true, data: { runId: 'uuid', status: 'success', outputs: { result: '工作流输出…' } } },
        null,
        2,
      ),
      curl: `curl -X POST '${base}/workflows/run' \\\n  -H 'Authorization: Bearer <你的 Token>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{ "workflowId": "${resourceId}", "inputs": { "query": "分析某个研究课题" } }'`,
    };
  }, [base, resourceType, resourceId]);

  /** 完整 Markdown 调用文档（含生效中的分享链接） */
  const docMarkdown = useMemo(
    () =>
      buildApiDocMarkdown({
        resourceType,
        resourceName,
        resourceId,
        base,
        endpoint,
        streamEndpoint,
        requestBody: body,
        responseBody: response,
        curl,
        shareLinks,
      }),
    [resourceType, resourceName, resourceId, base, endpoint, streamEndpoint, body, response, curl, shareLinks],
  );

  const generate = async () => {
    setBusy(true);
    try {
      const r = await createResourceApiAccess(resourceType, resourceId);
      setAccess(r);
      setPlaintext(r.key);
      if (r.key) toast.success('Token 已生成，请立即复制保存（仅显示一次）');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      const r = await rotateResourceApiAccess(resourceType, resourceId);
      setAccess(r);
      setPlaintext(r.key);
      toast.success('Token 已重置，请立即复制保存（仅显示一次）');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重置失败');
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Token 已复制');
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  const shareUrl = (token: string) => `${base}/share/${token}/${resourceType === 'agent' ? 'chat' : 'run'}`;

  const createShare = async () => {
    setShareBusy(true);
    try {
      const link = await createShareLink(resourceType, resourceId);
      setShareLinks((prev) => [link, ...prev]);
      if (link.token) toast.success('分享链接已创建，明文仅本次展示，请立即复制保存');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShare = async (id: string) => {
    try {
      await revokeShareLink(resourceType, resourceId, id);
      setShareLinks((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'revoked' as const } : s)));
      toast.success('分享链接已停用');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '停用失败');
    }
  };

  const removeShare = async (id: string) => {
    try {
      await deleteShareLink(resourceType, resourceId, id);
      setShareLinks((prev) => prev.filter((s) => s.id !== id));
      toast.success('分享链接已删除');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="xl"
      title="API 访问"
      description={`${resourceType === 'agent' ? '智能体' : '工作流'}「${resourceName}」的对外调用 Token 与分享接入`}
    >
      {/* 渠道 Tab */}
      <div className="mb-5 flex gap-1 rounded-lg border border-line-soft bg-surface-2 p-1">
        {(['api', 'share'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              tab === t ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {t === 'api' ? '调用 API（Token）' : '分享链接（公开）'}
          </button>
        ))}
      </div>

      {tab === 'api' ? (
      <div className="space-y-6">
        {/* Token */}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Icon name="key" size={14} />
            访问 Token
          </h3>
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-ink-3">
              <Spinner size={14} /> 加载中…
            </div>
          ) : plaintext ? (
            <div>
              <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary-soft p-3">
                <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">{plaintext}</code>
                <Button size="sm" variant="secondary" icon={<Icon name="copy" size={13} />} onClick={() => copyToken(plaintext)}>
                  复制
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-danger">Token 仅此一次展示，请立即保存；关闭后将无法再次查看明文。</p>
            </div>
          ) : access?.enabled ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-surface-2 p-3">
              <div className="min-w-0">
                <div className="font-mono text-[13px] text-ink-2">{access.prefix}</div>
                <div className="mt-0.5 text-xs text-ink-3">已生成 · 明文仅在生成/重置时可见</div>
              </div>
              <Button size="sm" variant="secondary" loading={busy} icon={<Icon name="refresh" size={13} />} onClick={rotate}>
                重置 Token
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-line p-3">
              <div className="text-sm text-ink-3">尚未生成 Token，生成后即可供第三方服务调用。</div>
              <Button size="sm" loading={busy} icon={<Icon name="key" size={13} />} onClick={generate}>
                生成 Token
              </Button>
            </div>
          )}
        </section>

        {/* 接口信息 */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Icon name="terminal" size={14} />
              接口信息
            </h3>
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name="file" size={13} />}
              onClick={() => setDocOpen(true)}
            >
              查看文档
            </Button>
          </div>
          <div className="space-y-2 text-[13px] text-ink-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="primary">POST</Badge>
              <code className="break-all font-mono text-[12px]">{endpoint}</code>
            </div>
            <div className="rounded-lg bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-ink-2">
              {`Authorization: Bearer <你的 Token>\nContent-Type: application/json`}
            </div>
            <p className="text-xs text-ink-3">
              流式（SSE）端点：<code className="font-mono">{streamEndpoint}</code>
            </p>
            <p className="text-xs text-ink-3">
              注：示例以当前站点为基准地址；生产环境请替换为你的 API 域名。
            </p>
          </div>
        </section>

        {/* 请求 / 响应 / curl 示例 */}
        <section className="space-y-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Icon name="code" size={14} />
            调用示例
          </h3>
          <CodeBlock label="请求体" code={body} />
          <CodeBlock label="响应体" code={response} />
          <CodeBlock label="curl" code={curl} />
        </section>
      </div>
      ) : (
        /* 分享链接 Tab */
        <div className="space-y-4">
          <div className="rounded-lg border border-line-soft bg-surface-2 px-4 py-3 text-[13px] text-ink-3">
            分享链接是<b className="text-ink-2">公开可访问</b>的调用地址（无需 Bearer Token），
            适合嵌入第三方网站 / 分享给终端用户；token 明文仅创建时展示一次。
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">分享链接（{shareLinks.length}）</h3>
            <Button size="sm" loading={shareBusy} icon={<Icon name="plus" size={13} />} onClick={createShare}>
              新建分享链接
            </Button>
          </div>

          {shareLinks.length === 0 && (
            <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
              暂无分享链接，点击上方按钮创建。
            </div>
          )}

          <div className="space-y-2">
            {shareLinks.map((link) => (
              <div
                key={link.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2.5',
                  link.status === 'active' ? 'border-line' : 'border-line-soft opacity-60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-[12px] text-ink-2">{link.prefix}</code>
                    <Badge tone={link.status === 'active' ? 'success' : 'neutral'} dot>
                      {link.status === 'active' ? '生效中' : '已停用'}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-3">
                    创建于 {timeAgo(link.createdAt)}
                    {link.expiresAt ? ` · ${timeAgo(link.expiresAt)} 过期` : ''}
                    {link.lastUsedAt ? ` · ${timeAgo(link.lastUsedAt)} 最近使用` : ''}
                  </div>
                </div>
                {link.status === 'active' && (
                  <Button size="sm" variant="ghost" onClick={() => void revokeShare(link.id)}>
                    停用
                  </Button>
                )}
                <Button size="sm" variant="danger-ghost" onClick={() => void removeShare(link.id)}>
                  删除
                </Button>
              </div>
            ))}
          </div>

          {/* 最新创建的明文 token（仅本次展示） */}
          {shareLinks.length > 0 && shareLinks[0]?.token && (
            <div className="rounded-lg border border-primary/30 bg-primary-soft p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-3">新分享链接（明文仅本次展示，请立即复制）</span>
                <Button size="sm" variant="secondary" icon={<Icon name="copy" size={12} />} onClick={() => copyToken(shareUrl(shareLinks[0]!.token!))}>
                  复制链接
                </Button>
              </div>
              <code className="block break-all font-mono text-[12px] text-ink">
                {shareUrl(shareLinks[0]!.token)}
              </code>
            </div>
          )}
        </div>
      )}

      {/* 完整 Markdown 调用文档（可整体复制 / 下载 .md） */}
      <ApiDocModal
        open={docOpen}
        onClose={() => setDocOpen(false)}
        title={`「${resourceName}」API 调用文档`}
        markdown={docMarkdown}
        fileName={`${resourceName}-api-doc`}
      />
    </Modal>
  );
}