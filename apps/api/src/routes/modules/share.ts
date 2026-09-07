/**
 * 公开分享端点 —— /share/:token/...，供第三方网站/终端用户无需 Bearer 凭据访问。
 *
 * 鉴权：token 通过 path 定位 share_links，校验 active/未过期 → 解析出资源定位（agent/workflow）。
 * 资源归属：share token 即绑定单一资源，无需再校验 API Key 资源绑定（天然防越权）。
 * 会话归因：fromSource='share'（conversations 表预留）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { agentChatRequestSchema, agentChatResultSchema, workflowRunRequestSchema, workflowRunResultSchema } from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import { shareLinkStore } from '../../services/share-link-store.js';
import { createAgentRuntime } from '../../services/agent-runtime.js';
import { agentStore } from '../../services/agent-store.js';
import { workflowStore } from '../../services/workflow-store.js';
import { executeWorkflow } from '../../services/workflow-engine/index.js';
import { toAgentSseReadable } from './agents.js';
import { toWorkflowSseReadable } from './workflows.js';
import { AppError } from '../../lib/errors.js';
import type { AppEnv } from '../../types.js';

const tokenParam = (c: { req: { param(key: string): string } }): string =>
  parse(z.string().min(1), c.req.param('token'));

const runtime = createAgentRuntime();

/** 解析分享 token → 校验有效 → 返回资源定位 */
async function resolveShareToken(raw: string) {
  return shareLinkStore.resolveByRaw(raw);
}

export const shareRoutes = new Hono<AppEnv>()
  // ---------------- Agent 分享对话 ----------------
  // 一次性：POST /share/:token/chat
  .post('/:token/chat', async (c) => {
    const token = tokenParam(c);
    const share = await resolveShareToken(token);
    if (share.resourceType !== 'agent') {
      throw new AppError('分享链接非 Agent 资源', 'FORBIDDEN', 403);
    }
    const body = parse(agentChatRequestSchema, await c.req.json());
    const result = await runtime.chatOnce({
      agentId: share.resourceId,
      sessionId: body.sessionId,
      query: body.query,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
    });
    return c.json(ok(agentChatResultSchema.parse(result)));
  })
  // 流式：POST /share/:token/chat/stream
  .post('/:token/chat/stream', async (c) => {
    const token = tokenParam(c);
    const share = await resolveShareToken(token);
    if (share.resourceType !== 'agent') {
      throw new AppError('分享链接非 Agent 资源', 'FORBIDDEN', 403);
    }
    await agentStore.loadRuntime(share.resourceId);
    const body = parse(agentChatRequestSchema, await c.req.json());
    c.header('content-type', 'text/event-stream');
    c.header('cache-control', 'no-cache');
    c.header('connection', 'keep-alive');
    c.header('x-accel-buffering', 'no');
    return c.body(
      toAgentSseReadable({
        agentId: share.resourceId,
        sessionId: body.sessionId,
        query: body.query,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
      }),
      200,
    );
  })
  // ---------------- Workflow 分享运行 ----------------
  // 一次性：POST /share/:token/run
  .post('/:token/run', async (c) => {
    const token = tokenParam(c);
    const share = await resolveShareToken(token);
    if (share.resourceType !== 'workflow') {
      throw new AppError('分享链接非工作流资源', 'FORBIDDEN', 403);
    }
    const body = parse(workflowRunRequestSchema, await c.req.json());
    const result = await executeWorkflow(share.resourceId, body.inputs);
    return c.json(ok(workflowRunResultSchema.parse(result)));
  })
  // 流式：POST /share/:token/run/stream
  .post('/:token/run/stream', async (c) => {
    const token = tokenParam(c);
    const share = await resolveShareToken(token);
    if (share.resourceType !== 'workflow') {
      throw new AppError('分享链接非工作流资源', 'FORBIDDEN', 403);
    }
    await workflowStore.loadGraphForRun(share.resourceId);
    const body = parse(workflowRunRequestSchema, await c.req.json());
    c.header('content-type', 'text/event-stream');
    c.header('cache-control', 'no-cache');
    c.header('connection', 'keep-alive');
    c.header('x-accel-buffering', 'no');
    return c.body(toWorkflowSseReadable(share.resourceId, body.inputs), 200);
  });