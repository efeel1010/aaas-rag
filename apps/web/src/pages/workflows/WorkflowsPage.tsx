import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WorkflowView } from '@pulse/contracts';
import { useWorkflows, useDeleteWorkflow } from '../../hooks/useWorkflows.js';
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

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

function WorkflowCard({ wf, onDelete }: { wf: WorkflowView; onDelete: (id: string) => void }) {
  const navigate = useNavigate();
  const [apiOpen, setApiOpen] = useState(false);
  const nodeCount = wf.nodes.length;
  const edgeCount = wf.edges.length;
  return (
    <div className="group rounded-xl border border-line bg-surface p-5 transition-all hover:border-primary/40 hover:shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary-strong">
            <Icon name="workflow" size={18} />
          </span>
          <div>
            <Link
              to={`/workflows/${wf.id}`}
              className="text-sm font-semibold text-ink hover:text-primary-strong"
            >
              {wf.name}
            </Link>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
              <span>v{wf.version}</span>
              <Badge tone={statusTone(wf.status)} dot>
                {STATUS_LABEL[wf.status] ?? wf.status}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => navigate(`/workflows/${wf.id}`)}
            className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
            aria-label="打开画布"
          >
            <Icon name="edit" size={15} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(wf.id)}
            className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger"
            aria-label="删除"
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2rem] text-[13px] text-ink-3">
        {wf.description || '暂无描述'}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge tone="neutral">{nodeCount} 个节点</Badge>
        <Badge tone="info">{edgeCount} 条连线</Badge>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-ink-3">
        <span className="flex items-center gap-1">
          <Icon name="clock" size={12} />
          {timeAgo(wf.updatedAt)} 更新
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setApiOpen(true)}
            className="flex items-center gap-1 text-primary-strong hover:underline"
          >
            <Icon name="link" size={12} />
            调用 API
          </button>
          <Link to={`/workflows/${wf.id}`} className="text-primary-strong hover:underline">
            打开画布
          </Link>
        </div>
      </div>

      <ApiAccessModal
        open={apiOpen}
        onClose={() => setApiOpen(false)}
        resourceType="workflow"
        resourceId={wf.id}
        resourceName={wf.name}
      />
    </div>
  );
}

export function WorkflowsPage() {
  const { data, isLoading, isError } = useWorkflows();
  const deleteMutation = useDeleteWorkflow();
  const toast = useToast();
  const [deleting, setDeleting] = useState<WorkflowView | null>(null);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success(`工作流「${deleting.name}」已删除`);
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div>
      <PageHeader
        title="工作流"
        description="可视化编排 DAG：LLM / 知识检索 / 意图判断 / 条件分支 / 代码 / HTTP / 模板"
        actions={
          <Link to="/workflows/new">
            <Button icon={<Icon name="plus" size={15} />}>新建工作流</Button>
          </Link>
        }
      />

      {isLoading && <FullPageLoader />}
      {isError && (
        <EmptyState icon="alert" title="加载失败" description="请确认后端已启动后刷新重试。" />
      )}
      {!isLoading && !isError && (data?.length ?? 0) === 0 && (
        <EmptyState
          icon="workflow"
          title="还没有工作流"
          description="创建第一个工作流，进入可视化画布编排节点与连线。"
          action={
            <Link to="/workflows/new">
              <Button icon={<Icon name="plus" size={15} />}>新建工作流</Button>
            </Link>
          }
        />
      )}
      {!isLoading && !isError && (data?.length ?? 0) > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data?.map((wf) => (
            <WorkflowCard key={wf.id} wf={wf} onDelete={() => setDeleting(wf)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="删除工作流"
        message={
          <>
            确定删除工作流 <b className="text-ink">{deleting?.name}</b> 吗？运行记录将一并清理。
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
