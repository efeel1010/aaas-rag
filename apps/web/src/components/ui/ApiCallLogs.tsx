/**
 * 资源级「API 调用日志」列表组件（智能体 / 工作流详情页共用）。
 * 展示：调用方、调用时间、问答内容（问/答）、成功失败、耗时/tokens，支持分页。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApiCallLog, ApiKeyResourceType } from '@pulse/contracts';
import { getResourceApiLogs } from '../../api/apiKeys.js';
import { TableShell, THead, Th, TBody, Tr, Td } from './Table.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { EmptyState } from './EmptyState.js';
import { formatTime } from '../../lib/format.js';

const PAGE_SIZE = 20;

function HttpStatusBadge({ status }: { status: number }) {
  const ok = status >= 200 && status < 300;
  return (
    <Badge tone={ok ? 'success' : 'danger'} dot>
      {ok ? '成功' : '失败'} · {status}
    </Badge>
  );
}

export function ApiCallLogs({
  resourceType,
  resourceId,
}: {
  resourceType: ApiKeyResourceType;
  resourceId: string;
}) {
  const [items, setItems] = useState<ApiCallLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await getResourceApiLogs(resourceType, resourceId, {
          page: p,
          perPage: PAGE_SIZE,
        });
        setItems(res.items);
        setTotal(res.total);
        setPage(res.page);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [resourceType, resourceId],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-14 text-sm text-ink-3">
        <Spinner size={16} /> 加载中…
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon="alert"
        title="加载失败"
        description={error}
        action={<Button variant="secondary" onClick={() => void load(page)}>重试</Button>}
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon="terminal"
        title="暂无 API 调用日志"
        description="第三方通过独立 Token 调用后，这里会记录每次调用方、时间、问答内容与成功失败状态。"
      />
    );
  }

  return (
    <div className="space-y-3">
      <TableShell>
        <THead>
          <Th>调用方</Th>
          <Th>调用时间</Th>
          <Th>问答内容</Th>
          <Th>状态</Th>
          <Th>耗时 / Tokens</Th>
        </THead>
        <TBody>
          {items.map((log) => (
            <Tr key={log.id}>
              <Td className="align-top">
                <div className="text-sm text-ink-2">{log.caller}</div>
                {log.callerPrefix && (
                  <div className="mt-0.5 font-mono text-[11px] text-ink-3">{log.callerPrefix}</div>
                )}
              </Td>
              <Td className="whitespace-nowrap align-top text-[12px] text-ink-3">
                {formatTime(log.createdAt)}
              </Td>
              <Td className="max-w-md align-top">
                <div className="space-y-1">
                  {log.requestContent != null && (
                    <p
                      className="break-all text-[12px] leading-relaxed text-ink-2 line-clamp-2"
                      title={log.requestContent}
                    >
                      <span className="text-ink-3">问：</span>
                      {log.requestContent}
                    </p>
                  )}
                  {log.responseContent != null && (
                    <p
                      className="break-all text-[12px] leading-relaxed text-ink-2 line-clamp-2"
                      title={log.responseContent}
                    >
                      <span className="text-ink-3">答：</span>
                      {log.responseContent}
                    </p>
                  )}
                  {log.requestContent == null && log.responseContent == null && (
                    <span className="text-ink-3">—</span>
                  )}
                </div>
              </Td>
              <Td className="whitespace-nowrap align-top">
                <HttpStatusBadge status={log.status} />
              </Td>
              <Td className="whitespace-nowrap align-top text-[12px] text-ink-3">
                {log.latencyMs != null ? `${log.latencyMs} ms` : '—'}
                <span className="mx-1 text-ink-3">·</span>
                {log.tokens != null ? `${log.tokens} tok` : '—'}
              </Td>
            </Tr>
          ))}
        </TBody>
      </TableShell>

      <div className="flex items-center justify-between text-[13px] text-ink-3">
        <span>
          共 {total} 条 · 第 {page} / {totalPages} 页
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={page <= 1}
            onClick={() => void load(page - 1)}
          >
            <Icon name="chevron-left" size={14} />
            上一页
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() => void load(page + 1)}
          >
            下一页
            <Icon name="chevron-right" size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}