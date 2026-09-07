/**
 * 工作流自定义节点 —— 所有节点类型共用同一渲染组件（icon + 颜色 + label + 端口）。
 * data 约定见 lib/workflow.ts：{ config, label }。
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NODE_TYPE_META, type WorkflowNodeData, type WorkflowNodeType } from '../../lib/workflow.js';
import { Icon } from '../../components/ui/Icon.js';
import { cn } from '../../lib/format.js';

export function WorkflowNode({ data, selected, type }: NodeProps) {
  const nodeType = type as WorkflowNodeType;
  const meta = NODE_TYPE_META[nodeType];
  const nodeData = data as WorkflowNodeData;
  const label = nodeData?.label || meta?.label || nodeType;

  return (
    <div
      className={cn(
        'min-w-[150px] rounded-xl border bg-surface px-3 py-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.18)] transition-all',
        selected ? 'border-primary ring-2 ring-primary-soft' : 'border-line',
      )}
      style={{ borderTopColor: meta?.color ?? undefined, borderTopWidth: 3 }}
    >
      {/* 入端口 */}
      {meta?.hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !bg-canvas"
          style={{ borderColor: meta.color }}
        />
      )}
      {/* 出端口 */}
      {meta?.hasSource && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-2.5 !w-2.5 !border-2 !bg-canvas"
          style={{ borderColor: meta.color }}
        />
      )}

      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${meta?.color ?? '#7c5cff'}22`, color: meta?.color ?? '#7c5cff' }}
        >
          <Icon name={meta?.icon ?? 'box'} size={14} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium leading-tight text-ink">{label}</div>
          <div className="text-[11px] leading-tight text-ink-3">{meta?.label ?? nodeType}</div>
        </div>
      </div>
    </div>
  );
}
