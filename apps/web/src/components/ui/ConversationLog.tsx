/**
 * Agent「历史会话 + 标注反馈」组件 —— 会话列表 + 消息回读 + 赞/踩标注。
 *
 * 数据链路：GET /agents/:id/conversations → GET .../conversations/:id/messages
 *           → POST .../messages/:messageId/feedback（like/dislike/null）
 */
import { useCallback, useEffect, useState } from 'react';
import type { ConversationListItem, ConversationMessage } from '@pulse/contracts';
import { feedbackMessage, getConversationMessages, listAgentConversations } from '../../api/agents.js';
import { Card } from './Table.js';
import { Badge } from './Badge.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { EmptyState } from './EmptyState.js';
import { useToast } from './Toast.js';
import { cn, formatTime } from '../../lib/format.js';

type Feedback = 'like' | 'dislike' | null;

function FeedbackRow({
  messageId,
  feedback,
  agentId,
  onChange,
}: {
  messageId: string;
  feedback: Feedback;
  agentId: string;
  onChange: (id: string, fb: Feedback) => void;
}) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (fb: 'like' | 'dislike') => {
    const next: Feedback = feedback === fb ? null : fb; // 再次点击取消
    setSubmitting(true);
    try {
      await feedbackMessage(agentId, messageId, { feedback: next });
      onChange(messageId, next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '标注失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <button
        type="button"
        disabled={submitting}
        onClick={() => void submit('like')}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50',
          feedback === 'like'
            ? 'border-success/50 bg-success-soft text-success'
            : 'border-line text-ink-3 hover:border-success/40 hover:text-success',
        )}
      >
        <Icon name="check" size={11} />
        有帮助
      </button>
      <button
        type="button"
        disabled={submitting}
        onClick={() => void submit('dislike')}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50',
          feedback === 'dislike'
            ? 'border-danger/50 bg-danger-soft text-danger'
            : 'border-line text-ink-3 hover:border-danger/40 hover:text-danger',
        )}
      >
        <Icon name="x" size={11} />
        需改进
      </button>
    </div>
  );
}

export function ConversationLog({ agentId }: { agentId: string }) {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState(false);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const list = await listAgentConversations(agentId);
      setConversations(list);
      // 首次加载自动选中第一个会话（用函数式更新避免依赖 activeId）
      setActiveId((prev) => prev ?? list[0]?.id ?? null);
    } catch {
      setConversations([]);
    } finally {
      setLoadingList(false);
    }
  }, [agentId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!activeId) return;
    setLoadingMsg(true);
    getConversationMessages(agentId, activeId)
      .then(setMessages)
      .catch(() => setMessages([]))
      .finally(() => setLoadingMsg(false));
  }, [agentId, activeId]);

  const onFeedback = (messageId: string, fb: Feedback) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: fb } : m)));
  };

  if (loadingList) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-3">
        <Spinner size={16} /> 加载会话…
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <EmptyState
        icon="message"
        title="暂无历史会话"
        description="在「对话测试」中发起对话后，会话将自动保存于此；可回读并对回答进行赞/踩标注。"
      />
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      {/* 会话列表 */}
      <Card padded={false} className="h-fit">
        <div className="border-b border-line-soft px-4 py-2.5 text-xs font-semibold text-ink-3">
          会话（{conversations.length}）
        </div>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto p-2">
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveId(c.id)}
              className={cn(
                'block w-full rounded-lg border px-3 py-2 text-left transition-colors',
                activeId === c.id
                  ? 'border-primary/50 bg-primary-soft'
                  : 'border-transparent hover:bg-surface-2',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-[13px] font-medium text-ink">
                  {c.name ?? `会话 ${c.id.slice(0, 8)}`}
                </span>
                <span className="shrink-0 text-[11px] text-ink-3">{c.messageCount} 条</span>
              </div>
              <div className="mt-0.5 text-[11px] text-ink-3">{formatTime(c.updatedAt)}</div>
            </button>
          ))}
        </div>
      </Card>

      {/* 消息流 */}
      <Card padded={false} className="flex max-h-[60vh] flex-col overflow-hidden">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {loadingMsg && (
            <div className="flex items-center justify-center gap-2 py-10 text-ink-3">
              <Spinner size={15} /> 加载消息…
            </div>
          )}
          {!loadingMsg && messages.length === 0 && (
            <p className="py-10 text-center text-sm text-ink-3">该会话暂无消息</p>
          )}
          {!loadingMsg &&
            messages.map((m) => {
              const isUser = m.role === 'user';
              return (
                <div key={m.id} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed',
                      isUser
                        ? 'rounded-br-sm bg-primary text-white'
                        : 'rounded-bl-sm border border-line bg-surface-2 text-ink-2',
                    )}
                  >
                    <p className="whitespace-pre-wrap">{m.content}</p>
                    {!isUser && (
                      <>
                        <FeedbackRow
                          messageId={m.id}
                          feedback={m.feedback ?? null}
                          agentId={agentId}
                          onChange={onFeedback}
                        />
                        {m.feedback && (
                          <Badge tone={m.feedback === 'like' ? 'success' : 'danger'} className="mt-1.5">
                            {m.feedback === 'like' ? '已标注：有帮助' : '已标注：需改进'}
                          </Badge>
                        )}
                      </>
                    )}
                    <div className="mt-1 text-right text-[10px] text-ink-3">{formatTime(m.createdAt)}</div>
                  </div>
                </div>
              );
            })}
        </div>
      </Card>
    </div>
  );
}