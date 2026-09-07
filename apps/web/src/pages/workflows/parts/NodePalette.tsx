/** 左侧节点面板 —— 展示全部节点类型，支持拖拽到画布 */
import { NODE_TYPE_META, NODE_TYPES } from '../../../lib/workflow.js';
import { Icon } from '../../../components/ui/Icon.js';

export function NodePalette() {
  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-line-soft bg-surface">
      <div className="border-b border-line-soft px-4 py-2.5 text-xs font-semibold text-ink-3">
        节点（拖拽到画布）
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2.5">
        {NODE_TYPES.map((type) => {
          // NODE_TYPES 即 NODE_TYPE_META 的全部键，此处可安全非空断言
          const meta = NODE_TYPE_META[type]!;
          return (
            <div
              key={type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/reactflow', type);
                e.dataTransfer.effectAllowed = 'move';
              }}
              className="group flex cursor-grab items-center gap-2.5 rounded-lg border border-line-soft bg-surface-2 px-3 py-2 transition-all hover:border-primary/50 hover:bg-surface-3 active:cursor-grabbing"
              title={meta.description}
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
              >
                <Icon name={meta.icon} size={14} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink">{meta.label}</div>
                <div className="truncate text-[10px] text-ink-3">{meta.description}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line-soft px-4 py-2.5 text-[11px] leading-relaxed text-ink-3">
        提示：选中节点后在右侧面板编辑配置；条件/意图分支在<b className="text-ink-2">连线上</b>配置。
      </div>
    </div>
  );
}
