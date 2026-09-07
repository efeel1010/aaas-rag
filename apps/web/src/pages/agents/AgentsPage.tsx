import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentView } from '@pulse/contracts';
import { useAgents, useDeleteAgent } from '../../hooks/useAgents.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { Button } from '../../components/ui/Button.js';
import { Badge, statusTone } from '../../components/ui/Badge.js';
import { Icon } from '../../components/ui/Icon.js';
import { ConfirmDialog } from '../../components/ui/Modal.js';
import { ApiAccessModal } from '../../components/ui/ApiAccessModal.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { FullPageLoader } from '../../components/ui/Spinner.js';
import { useToast } from '../../components/ui/Toast.js';
import { timeAgo } from '../../lib/format.js';

const STRATEGY_LABEL: Record<string, string> = {
  retrieval: '检索生成',
  direct: '直答话术',
  workflow: '触发工作流',
  fallback: '兜底',
};

function AgentCard({ agent, onDelete }: { agent: AgentView; onDelete: (id: string) => void }) {
  const [apiOpen, setApiOpen] = useState(false);
  return (
    <div className="group rounded-xl border border-line bg-surface p-5 transition-all hover:border-primary/40 hover:shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-info-soft text-info">
            <Icon name="bot" size={18} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <Link
                to={`/agents/${agent.id}`}
                className="text-sm font-semibold text-ink hover:text-primary-strong"
              >
                {agent.name}
              </Link>
              <Badge tone={statusTone(agent.status)} dot>
                {agent.status === 'active' ? '启用' : '停用'}
              </Badge>
            </div>
            <div className="mt-0.5 text-xs text-ink-3">{agent.modelName ?? '未绑定模型'}</div>
          </div>
        </div>
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Link
            to={`/agents/${agent.id}/edit`}
            className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
            aria-label="编辑"
          >
            <Icon name="edit" size={15} />
          </Link>
          <button
            type="button"
            onClick={() => onDelete(agent.id)}
            className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger"
            aria-label="删除"
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2rem] text-[13px] text-ink-3">
        {agent.description || '暂无描述'}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge tone="primary">
          {agent.datasets.length} 个知识库
        </Badge>
        <Badge tone="info">{agent.intents.length} 个意图</Badge>
        <Badge tone="neutral">{agent.type}</Badge>
      </div>

      {agent.intents.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line-soft pt-3">
          {agent.intents.slice(0, 4).map((it) => (
            <span key={it.agentIntentId} className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">
              {it.name}
              <span className="ml-1 text-ink-3/70">{STRATEGY_LABEL[it.strategy] ?? it.strategy}</span>
            </span>
          ))}
          {agent.intents.length > 4 && (
            <span className="text-[11px] text-ink-3">+{agent.intents.length - 4}</span>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-[11px] text-ink-3">
        <span>意图路由已就绪</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setApiOpen(true)}
            className="flex items-center gap-1 text-primary-strong hover:underline"
          >
            <Icon name="link" size={12} />
            调用 API
          </button>
          <span>{timeAgo(agent.updatedAt)} 更新</span>
        </div>
      </div>

      <ApiAccessModal
        open={apiOpen}
        onClose={() => setApiOpen(false)}
        resourceType="agent"
        resourceId={agent.id}
        resourceName={agent.name}
      />
    </div>
  );
}

export function AgentsPage() {
  const { data, isLoading, isError } = useAgents();
  const deleteMutation = useDeleteAgent();
  const toast = useToast();
  const [deleting, setDeleting] = useState<AgentView | null>(null);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success(`Agent「${deleting.name}」已删除`);
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div>
      <PageHeader
        title="Agent"
        description="配置智能体：系统提示词、对话模型、知识库绑定（带权重）与意图路由策略"
        actions={
          <Link to="/agents/new">
            <Button icon={<Icon name="plus" size={15} />}>新建 Agent</Button>
          </Link>
        }
      />

      {isLoading && <FullPageLoader />}
      {isError && (
        <EmptyState icon="alert" title="加载失败" description="请确认后端已启动后刷新重试。" />
      )}
      {!isLoading && !isError && (data?.length ?? 0) === 0 && (
        <EmptyState
          icon="bot"
          title="还没有 Agent"
          description="创建 Agent，绑定对话模型与知识库，即可通过意图路由进行对话测试。"
          action={
            <Link to="/agents/new">
              <Button icon={<Icon name="plus" size={15} />}>新建 Agent</Button>
            </Link>
          }
        />
      )}
      {!isLoading && !isError && (data?.length ?? 0) > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data?.map((ag) => (
            <AgentCard key={ag.id} agent={ag} onDelete={() => setDeleting(ag)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="删除 Agent"
        message={
          <>
            确定删除 Agent <b className="text-ink">{deleting?.name}</b> 吗？相关绑定与意图关联将一并清理。
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
