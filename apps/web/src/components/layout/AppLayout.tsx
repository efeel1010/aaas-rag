import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../../lib/format.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { useHealth } from '../../hooks/useHealth.js';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/datasets', label: '知识库', icon: 'database' },
  { to: '/agents', label: 'Agent', icon: 'bot' },
  { to: '/workflows', label: '工作流', icon: 'workflow' },
  { to: '/providers', label: '模型配置', icon: 'settings' },
];

function Sidebar() {
  const { data: health } = useHealth();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line-soft bg-surface">
      <div className="flex h-14 items-center gap-2.5 border-b border-line-soft px-5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white">
          <Icon name="zap" size={16} />
        </div>
        <div>
          <div className="font-display text-[15px] font-semibold leading-none text-ink">Pulse</div>
          <div className="text-[11px] leading-tight text-ink-3">RAG 管理面板 · M6</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-4">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-primary-soft font-medium text-primary-strong'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )
            }
          >
            <Icon name={item.icon} size={16} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-line-soft px-5 py-3.5">
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              health?.status === 'up' ? 'bg-success' : 'bg-ink-3',
            )}
          />
          <span>{health?.status === 'up' ? '后端在线' : '后端离线'}</span>
          {health && <span className="ml-auto font-mono">v{health.version}</span>}
        </div>
      </div>
    </aside>
  );
}

export function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line-soft bg-surface px-6">
          <div className="text-sm text-ink-3">可视化编排控制台</div>
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <span className="rounded-full bg-surface-2 px-2.5 py-1 font-mono">MOCK_MODELS</span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col px-6 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
