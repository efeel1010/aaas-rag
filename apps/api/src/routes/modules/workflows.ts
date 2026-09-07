import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  apiCallLogListSchema,
  createShareLinkInputSchema,
  createWorkflowInputSchema,
  resourceApiAccessSchema,
  shareLinkViewSchema,
  updateWorkflowInputSchema,
  workflowRunRequestSchema,
  workflowRunResultSchema,
  workflowRunViewSchema,
  workflowStatusSchema,
  workflowViewSchema,
  type WorkflowStreamEvent,
} from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import { AppError, ValidationError } from '../../lib/errors.js';
import { workflowStore } from '../../services/workflow-store.js';
import { apiKeyStore } from '../../services/api-key-store.js';
import { shareLinkStore } from '../../services/share-link-store.js';
import { executeWorkflow, streamWorkflow } from '../../services/workflow-engine/index.js';
import { reportUsage, requireExternalApi } from '../../middleware/api-gateway.js';
import type { AppEnv } from '../../types.js';

const uuidSchema = z.string().uuid();

/** 分页查询参数解析（page / perPage） */
function pageOptions(c: { req: { query(key: string): string | undefined } }): {
  page: number;
  perPage: number;
} {
  const rawPage = c.req.query('page');
  const rawPerPage = c.req.query('perPage');
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const perPage = rawPerPage === undefined ? 20 : Number(rawPerPage);
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError([{ path: ['page'], message: 'page 须为正整数' }]);
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 200) {
    throw new ValidationError([{ path: ['perPage'], message: 'perPage 须为正整数且 ≤200' }]);
  }
  return { page, perPage };
}

/** 启停请求体：仅允许 draft / published / archived */
const setStatusBodySchema = z.object({ status: workflowStatusSchema }).strict();

const workflowIdParam = (c: { req: { param(key: string): string } }): string =>
  parse(uuidSchema, c.req.param('workflowId'));

const runIdParam = (c: { req: { param(key: string): string } }): string =>
  parse(uuidSchema, c.req.param('runId'));

/** 统一组装资源级 API 访问响应（resourceApiAccessSchema 形态） */
function toAccess(
  resourceId: string,
  r: { key?: string | null; prefix?: string | null; createdAt?: Date } | null,
) {
  return resourceApiAccessSchema.parse({
    resourceType: 'workflow',
    resourceId,
    enabled: r !== null,
    prefix: r?.prefix ?? null,
    key: r?.key ?? null,
    createdAt: r?.createdAt ? r.createdAt.toISOString() : null,
  });
}

/** 工作流流式事件 SSE 编码（node_end → done；运行中异常写 event: error） */
function encodeWorkflowSse(event: WorkflowStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 把工作流流式执行转换为 SSE ReadableStream。
 * 错误双通道：流前（工作流不存在/未发布）由路由先 loadGraphForRun 抛 HTTP 信封；
 * 流中（节点执行失败等）写 `event: error` 后关闭。
 */
export function toWorkflowSseReadable(workflowId: string, inputs: Record<string, unknown>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = streamWorkflow(workflowId, inputs)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encodeWorkflowSse(value)));
      } catch (err) {
        const code = 'WORKFLOW_EXECUTION_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(encodeWorkflowSse({ type: 'error', runId: randomUUID(), code, message })));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * /api/v1/workflows —— 工作流 CRUD + 启停 + 运行。
 *
 * 运行语义：
 *  - 一次性：POST /workflows/run（body { workflowId, inputs }）→ 完整 WorkflowRunResult；
 *  - 流式：  POST /workflows/run/stream（同 body）→ SSE（node_end → done）；
 *  - 仅 status=published 可运行（draft/archived 由 loadGraphForRun 拒绝）。
 */
export const workflowsRoutes = new Hono<AppEnv>()
  // ---------------- CRUD ----------------
  .get('/', async (c) => c.json(ok(await workflowStore.list())))
  .post('/', async (c) => {
    const input = parse(createWorkflowInputSchema, await c.req.json());
    const created = await workflowStore.create(input);
    return c.json(ok(workflowViewSchema.parse(created)));
  })
  .get('/:workflowId', async (c) => c.json(ok(await workflowStore.get(workflowIdParam(c)))))
  .patch('/:workflowId', async (c) => {
    const input = parse(updateWorkflowInputSchema, await c.req.json());
    const updated = await workflowStore.update(workflowIdParam(c), input);
    return c.json(ok(workflowViewSchema.parse(updated)));
  })
  .delete('/:workflowId', async (c) => c.json(ok(await workflowStore.remove(workflowIdParam(c)))))

  // ---------------- 资源级 API 访问（独立 token） ----------------
  // 查询：GET /workflows/:workflowId/api-access（仅前缀，无明文）
  .get('/:workflowId/api-access', async (c) => {
    const workflowId = workflowIdParam(c);
    const existing = await apiKeyStore.findByResource('workflow', workflowId);
    return c.json(ok(toAccess(workflowId, existing)));
  })
  // 新建（幂等）：POST /workflows/:workflowId/api-access（首次返回明文 key）
  .post('/:workflowId/api-access', async (c) => {
    const workflowId = workflowIdParam(c);
    const wf = await workflowStore.get(workflowId);
    const r = await apiKeyStore.ensureForResource('workflow', workflowId, `workflow:${wf.name}`);
    return c.json(ok(toAccess(workflowId, r)));
  })
  // 轮换：POST /workflows/:workflowId/api-access/rotate（返回新明文，旧 key 失效）
  .post('/:workflowId/api-access/rotate', async (c) => {
    const workflowId = workflowIdParam(c);
    const wf = await workflowStore.get(workflowId);
    const r = await apiKeyStore.rotateForResource('workflow', workflowId, `workflow:${wf.name}`);
    return c.json(ok(toAccess(workflowId, r)));
  })
  // 调用日志：GET /workflows/:workflowId/api-logs?page=&perPage=
  .get('/:workflowId/api-logs', async (c) => {
    const workflowId = workflowIdParam(c);
    await workflowStore.get(workflowId);
    const { page, perPage } = pageOptions(c);
    const result = await apiKeyStore.listResourceLogs('workflow', workflowId, { page, pageSize: perPage });
    return c.json(ok(apiCallLogListSchema.parse(result)));
  })

  // ---------------- 分享链接（多渠道发布） ----------------
  // 列表：GET /workflows/:workflowId/share-links
  .get('/:workflowId/share-links', async (c) => {
    const workflowId = workflowIdParam(c);
    await workflowStore.get(workflowId);
    const list = await shareLinkStore.listByResource('workflow', workflowId);
    return c.json(ok(z.array(shareLinkViewSchema).parse(list)));
  })
  // 创建：POST /workflows/:workflowId/share-links（明文 token 仅本次返回）
  .post('/:workflowId/share-links', async (c) => {
    const workflowId = workflowIdParam(c);
    await workflowStore.get(workflowId);
    const body = await c.req.json().catch(() => ({}));
    const input = parse(createShareLinkInputSchema, body);
    const created = await shareLinkStore.create('workflow', workflowId, {
      expiresAt: input.expiresAt ?? null,
      rpm: input.rpm ?? null,
    });
    return c.json(ok(shareLinkViewSchema.parse(created)));
  })
  // 撤销：POST /workflows/:workflowId/share-links/:shareId/revoke
  .post('/:workflowId/share-links/:shareId/revoke', async (c) => {
    const workflowId = workflowIdParam(c);
    const shareId = parse(uuidSchema, c.req.param('shareId'));
    const updated = await shareLinkStore.revoke(shareId);
    if (updated.resourceId !== workflowId) throw new AppError('分享链接不属于该工作流', 'FORBIDDEN', 403);
    return c.json(ok(shareLinkViewSchema.parse(updated)));
  })
  // 删除：DELETE /workflows/:workflowId/share-links/:shareId
  .delete('/:workflowId/share-links/:shareId', async (c) => {
    const shareId = parse(uuidSchema, c.req.param('shareId'));
    await shareLinkStore.remove(shareId);
    return c.json(ok({ id: shareId }));
  })

  // ---------------- 启停（draft / published / archived） ----------------
  .patch('/:workflowId/status', async (c) => {
    const workflowId = workflowIdParam(c);
    const { status } = parse(setStatusBodySchema, await c.req.json());
    const updated = await workflowStore.setStatus(workflowId, status);
    return c.json(ok(workflowViewSchema.parse(updated)));
  })

  // ---------------- 运行 ----------------
  // 一次性 JSON：POST /workflows/run（对外调用类，需 API Key）
  .post(
    '/run',
    requireExternalApi({
      route: '/workflows/run',
      workflowFrom: { type: 'body', field: 'workflowId' },
    }),
    async (c) => {
      const body = parse(workflowRunRequestSchema, await c.req.json());
      const result = await executeWorkflow(body.workflowId, body.inputs);
      const parsed = workflowRunResultSchema.parse(result);
      reportUsage(c, {
        requestContent: JSON.stringify(body.inputs),
        responseContent: JSON.stringify(parsed.outputs),
      });
      return c.json(ok(parsed));
    },
  )
  // 流式 SSE：POST /workflows/run/stream（对外调用类，需 API Key）
  .post(
    '/run/stream',
    requireExternalApi({
      route: '/workflows/run',
      workflowFrom: { type: 'body', field: 'workflowId' },
    }),
    async (c) => {
    const body = parse(workflowRunRequestSchema, await c.req.json());
    // 预检：工作流存在且 published——失败仍走 HTTP 失败信封（流头之前）
    await workflowStore.loadGraphForRun(body.workflowId);

    c.header('content-type', 'text/event-stream');
    c.header('cache-control', 'no-cache');
    c.header('connection', 'keep-alive');
    c.header('x-accel-buffering', 'no');
    return c.body(toWorkflowSseReadable(body.workflowId, body.inputs), 200);
  })

  // ---------------- 运行日志 ----------------
  .get('/:workflowId/runs', async (c) => c.json(ok(await workflowStore.listRuns(workflowIdParam(c)))))
  .get('/:workflowId/runs/:runId', async (c) => {
    // 同时校验 workflow 存在，避免跨工作流访问
    const workflowId = workflowIdParam(c);
    await workflowStore.get(workflowId);
    const run = await workflowStore.getRun(runIdParam(c));
    return c.json(ok(workflowRunViewSchema.parse(run)));
  });
