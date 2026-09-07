import { Link } from 'react-router-dom';
import { useHealth } from '../../hooks/useHealth.js';
import { useDatasets } from '../../hooks/useDatasets.js';
import { useAgents } from '../../hooks/useAgents.js';
import { useWorkflows } from '../../hooks/useWorkflows.js';
import { useProviders } from '../../hooks/useProviders.js';
import { useModels } from '../../hooks/useModels.js';
import { Card } from '../../components/ui/Table.js';
import { Icon, type IconName } from '../../components/ui/Icon.js';
import { Button } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { Spinner } from '../../components/ui/Spinner.js';
import { timeAgo } from '../../lib/format.js';

function StatCard({
  icon,
  label,
  value,
  loading,
  to,
  accent,
}: {
  icon: IconName;
  label: string;
  value: number | string | undefined;
  loading: boolean;
  to: string;
  accent?: string;
}) {
  return (
    <Link
      to={to}
      className="group rounded-xl border border-line bg-surface p-5 transition-all hover:border-primary/50 hover:shadow-lg"
    >
      <div className="flex items-center justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-ink-3 group-hover:text-primary-strong">
          <Icon name={icon} size={18} />
        </div>
        <Icon name="chevron-right" size={14} className="text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="mt-4 text-2xl font-semibold text-ink">
        {loading ? <Spinner size={18} /> : (value ?? '-')}
      </div>
      <div className="mt-0.5 text-[13px]" style={{ color: accent ?? 'var(--color-ink-3)' }}>
        {label}
      </div>
    </Link>
  );
}

export function DashboardPage() {
  const health = useHealth();
  const datasets = useDatasets();
  const agents = useAgents();
  const workflows = useWorkflows();
  const providers = useProviders();
  const models = useModels();
  const firstDataset = datasets.data?.[0];

  return (
    <div className="space-y-6">
      {/* 顶部问候 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Dashboard</h1>
          <p className="mt-1 text-sm text-ink-3">
            Pulse-Rag 可视化编排控制台 —— 知识库 · Agent · 工作流 · 模型一站式管理
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/datasets/new">
            <Button icon={<Icon name="plus" size={15} />}>新建知识库</Button>
          </Link>
          <Link to="/agents/new">
            <Button variant="secondary" icon={<Icon name="plus" size={15} />}>
              新建 Agent
            </Button>
          </Link>
          <Link to="/workflows/new">
            <Button variant="secondary" icon={<Icon name="plus" size={15} />}>
              新建工作流
            </Button>
          </Link>
        </div>
      </div>

      {/* 系统状态 */}
      <Card className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-3">
          <span
            className={
              health.isLoading
                ? 'h-2.5 w-2.5 rounded-full bg-ink-3'
                : health.data?.status === 'up'
                  ? 'h-2.5 w-2.5 rounded-full bg-success animate-pulse'
                  : 'h-2.5 w-2.5 rounded-full bg-danger'
            }
          />
          <div>
            <div className="text-sm font-medium text-ink">
              {health.isLoading ? '检查后端连接…' : health.data ? '后端服务正常' : '后端连接失败'}
            </div>
            <div className="text-xs text-ink-3">
              {health.data
                ? `${health.data.service} · v${health.data.version} · 运行 ${health.data.uptimeSec}s`
                : '请确认 API 已启动且 vite 代理配置正确'}
            </div>
          </div>
        </div>
        <div className="hidden h-8 w-px bg-line-soft sm:block" />
        <div className="text-sm text-ink-3">
          <span className="text-ink-2">运行模式：</span>
          <Badge tone="primary">MOCK_MODELS=true（无外网可全链路）</Badge>
        </div>
      </Card>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          icon="database"
          label="知识库"
          value={datasets.data?.length}
          loading={datasets.isLoading}
          to="/datasets"
        />
        <StatCard
          icon="bot"
          label="Agent"
          value={agents.data?.length}
          loading={agents.isLoading}
          to="/agents"
        />
        <StatCard
          icon="workflow"
          label="工作流"
          value={workflows.data?.length}
          loading={workflows.isLoading}
          to="/workflows"
        />
        <StatCard
          icon="settings"
          label="Provider"
          value={providers.data?.length}
          loading={providers.isLoading}
          to="/providers"
        />
        <StatCard
          icon="cpu"
          label="模型"
          value={models.data?.length}
          loading={models.isLoading}
          to="/providers"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 最近知识库 */}
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
            <h2 className="text-sm font-semibold text-ink">最近知识库</h2>
            <Link to="/datasets" className="text-xs text-primary-strong hover:underline">
              查看全部
            </Link>
          </div>
          <div className="divide-y divide-line-soft">
            {datasets.isLoading && <div className="p-6"><Spinner size={16} /></div>}
            {!datasets.isLoading && datasets.data?.length === 0 && (
              <div className="p-6 text-sm text-ink-3">暂无知识库，去创建一个开始 RAG 之旅。</div>
            )}
            {datasets.data?.slice(0, 4).map((ds) => (
              <Link
                key={ds.id}
                to={`/datasets/${ds.id}`}
                className="flex items-center justify-between px-5 py-3 transition-colors hover:bg-surface-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold"
                    style={{ backgroundColor: 'var(--color-primary-soft)', color: 'var(--color-primary-strong)' }}
                  >
                    {ds.icon || ds.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">{ds.name}</div>
                    <div className="text-xs text-ink-3">{ds.docCount} 文档 · {ds.splitter} 切分</div>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-ink-3">{timeAgo(ds.createdAt)}</span>
              </Link>
            ))}
          </div>
        </Card>

        {/* 最近 Agent */}
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
            <h2 className="text-sm font-semibold text-ink">最近 Agent</h2>
            <Link to="/agents" className="text-xs text-primary-strong hover:underline">
              查看全部
            </Link>
          </div>
          <div className="divide-y divide-line-soft">
            {agents.isLoading && <div className="p-6"><Spinner size={16} /></div>}
            {!agents.isLoading && agents.data?.length === 0 && (
              <div className="p-6 text-sm text-ink-3">暂无 Agent。</div>
            )}
            {agents.data?.slice(0, 4).map((ag) => (
              <Link
                key={ag.id}
                to={`/agents/${ag.id}`}
                className="flex items-center justify-between px-5 py-3 transition-colors hover:bg-surface-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info">
                    <Icon name="bot" size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">{ag.name}</div>
                    <div className="text-xs text-ink-3">
                      {ag.modelName ?? '未绑定模型'} · {ag.datasets.length} 知识库
                    </div>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-ink-3">{timeAgo(ag.createdAt)}</span>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      {/* 使用向导 */}
      <Card>
        <h2 className="text-sm font-semibold text-ink">推荐路径</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-line-soft bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-ink">
              <Icon name="database" size={15} className="text-primary-strong" />
              知识库 RAG 链路
            </div>
            <ol className="mt-3 list-inside list-decimal space-y-1.5 text-[13px] text-ink-3">
              <li>创建知识库并选择切分策略</li>
              <li>上传文档并触发索引</li>
              <li>在检索测试面板验证召回质量</li>
              <li>创建 Agent 绑定知识库与意图</li>
              <li>在 Agent 详情页「对话测试」走通问答</li>
            </ol>
            <Link to={firstDataset ? `/datasets/${firstDataset.id}` : '/datasets/new'}>
              <Button size="sm" variant="secondary" className="mt-4">
                {firstDataset ? '进入第一个知识库' : '创建第一个知识库'}
              </Button>
            </Link>
          </div>
          <div className="rounded-lg border border-line-soft bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-ink">
              <Icon name="workflow" size={15} className="text-primary-strong" />
              工作流编排链路
            </div>
            <ol className="mt-3 list-inside list-decimal space-y-1.5 text-[13px] text-ink-3">
              <li>新建工作流进入可视化画布</li>
              <li>从节点面板拖入 LLM / 知识检索等节点</li>
              <li>连线并配置节点与边条件</li>
              <li>保存并发布为 published</li>
              <li>在运行测试面板填 inputs 查看节点链路</li>
            </ol>
            <Link to="/workflows/new">
              <Button size="sm" variant="secondary" className="mt-4">
                创建第一个工作流
              </Button>
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
