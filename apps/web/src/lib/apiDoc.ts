/**
 * 资源（智能体 / 工作流）API 调用文档生成。
 * 输出完整 Markdown 文本：资源信息 / 鉴权 / 接口地址 / 请求响应体 / curl 示例 / 错误码 / 分享链接。
 */
import type { ApiKeyResourceType, ShareLinkView } from '@pulse/contracts';

export interface ApiDocBuildInput {
  resourceType: ApiKeyResourceType;
  resourceName: string;
  resourceId: string;
  /** API 基础地址（含 /api/v1） */
  base: string;
  /** 一次性调用端点（含方法前缀，如 POST http://…/agents/:id/chat） */
  endpoint: string;
  /** 流式调用端点（含方法前缀） */
  streamEndpoint: string;
  /** 请求体示例（格式化 JSON 文本） */
  requestBody: string;
  /** 响应体示例（格式化 JSON 文本） */
  responseBody: string;
  /** curl 示例文本 */
  curl: string;
  /** 生效中的分享链接（可公开访问，无需 Token） */
  shareLinks?: Array<Pick<ShareLinkView, 'token' | 'prefix' | 'status' | 'expiresAt' | 'createdAt'>>;
}

/** HTTP → 失败信封（{ success, code, message }）错误码对照表 */
const ERROR_CODE_ROWS = [
  ['400', 'BAD_REQUEST', '请求格式错误'],
  ['401', 'UNAUTHORIZED', '未认证 / Token 缺失或无效'],
  ['403', 'FORBIDDEN', 'Token 无权访问该资源'],
  ['404', 'NOT_FOUND', '资源不存在'],
  ['409', 'CONFLICT', '资源冲突'],
  ['422', 'VALIDATION_ERROR', '请求参数校验失败'],
  ['429', 'RATE_LIMITED', '请求过于频繁（触发限流）'],
  ['429', 'QUOTA_EXCEEDED', 'API 配额已用完'],
  ['500', 'INTERNAL_ERROR', '服务内部错误'],
] as const;

const resourceTypeLabel: Record<ApiKeyResourceType, string> = {
  agent: '智能体',
  workflow: '工作流',
};

/** 智能体请求参数表（与 @pulse/contracts agentChatRequestSchema 对齐） */
const AGENT_PARAM_ROWS = [
  ['query', 'string', '是', '用户提问（1-4096 字符）'],
  ['sessionId', 'string', '否', '客户端会话标识；缺省时服务端生成并随结果返回'],
  ['temperature', 'number', '否', '采样温度（0-2）'],
  ['maxTokens', 'number', '否', '最大输出 token 数'],
  ['topK', 'number', '否', '检索召回 topK（1-20，默认 6）'],
  ['stream', 'boolean', '否', 'true 走 SSE 流式；false 返回一次性 JSON（默认 false）'],
] as const;

/** 智能体响应字段表（与 agentChatResultSchema 对齐） */
const AGENT_RESPONSE_ROWS = [
  ['conversationId', 'uuid', '会话 ID'],
  ['sessionId', 'string', '会话标识'],
  ['agentId', 'uuid', '智能体 ID'],
  ['intent', 'object|null', '命中的意图信息（未命中/无意图时为 null）'],
  ['retrievedDatasets', 'uuid[]', '实际参与检索的知识库 id（未检索为空数组）'],
  ['citations', 'array', '回答引用的知识库命中切片（引用溯源）'],
  ['content', 'string', '回答内容'],
  ['model', 'string', '实际使用的模型'],
  ['toolCalls', 'array', 'ReAct 工具循环中的工具调用记录'],
  ['usage', 'object', 'token 用量（inputTokens / outputTokens）'],
  ['createdAt', 'string', '创建时间（ISO8601）'],
] as const;

/** 工作流请求参数表（与 workflowRunRequestSchema 对齐） */
const WORKFLOW_PARAM_ROWS = [
  ['workflowId', 'uuid', '是', '工作流 ID'],
  ['inputs', 'object', '否', '工作流输入变量（默认 {}）'],
  ['stream', 'boolean', '否', 'true 走 SSE 流式；false 返回一次性 JSON（默认 false）'],
] as const;

/** 工作流响应字段表（与 workflowRunResultSchema 对齐） */
const WORKFLOW_RESPONSE_ROWS = [
  ['runId', 'uuid', '运行 ID'],
  ['workflowId', 'uuid', '工作流 ID'],
  ['status', 'enum', 'success / failed'],
  ['inputs', 'object', '运行输入变量'],
  ['outputs', 'object', '运行输出变量'],
  ['nodeResults', 'array', '各节点执行结果（Trace 明细）'],
] as const;

const mdTable = (header: readonly string[], rows: ReadonlyArray<readonly string[]>): string => {
  const head = `| ${header.join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
};

const code = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\``;

export function buildApiDocMarkdown(input: ApiDocBuildInput): string {
  const {
    resourceType,
    resourceName,
    resourceId,
    base,
    endpoint,
    streamEndpoint,
    requestBody,
    responseBody,
    curl,
    shareLinks = [],
  } = input;
  const typeLabel = resourceTypeLabel[resourceType];
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const isAgent = resourceType === 'agent';
  const activeShare = shareLinks.filter((s) => s.status === 'active');

  const shareSection = activeShare.length
    ? activeShare
        .map((s) => {
          const path = isAgent ? `share/${s.token}/chat` : `share/${s.token}/run`;
          const full = `${base}/${path}`;
          return [
            `- 链接：\`${full}\``,
            `- 说明：公开可访问，**无需 Token**；${s.expiresAt ? `过期时间：${s.expiresAt}；` : ''}创建于 ${s.createdAt}`,
          ].join('\n');
        })
        .join('\n\n')
    : '当前没有生效中的分享链接，可在「API 访问 → 分享链接」中创建。';

  return `# 「${resourceName}」API 调用文档

> 由 PulseRAG 平台自动生成 · ${generatedAt}

## 一、资源信息

${mdTable(['项', '值'], [
  ['资源类型', typeLabel],
  ['资源名称', resourceName],
  ['资源 ID', `\`${resourceId}\``],
  ['API 基础地址', `\`${base}\``],
  ['鉴权方式', 'Authorization: Bearer <API Token>'],
])}

## 二、鉴权方式

所有对外调用需携带请求头：

${code('http', 'Authorization: Bearer <你的 API Token>\nContent-Type: application/json')}

> Token 在「API 访问」弹窗中生成；仅在生成/重置时展示一次明文，请妥善保管。

## 三、接口地址

### 3.1 一次性调用（JSON）

\`${endpoint}\`

### 3.2 流式调用（SSE）

\`${streamEndpoint}\`

> 流式响应按 SSE 事件推送：\`event: delta / done / error\`，适合打字机效果输出。

## 四、请求参数

${isAgent ? mdTable(['参数', '类型', '必填', '说明'], AGENT_PARAM_ROWS) : mdTable(['参数', '类型', '必填', '说明'], WORKFLOW_PARAM_ROWS)}

### 请求体示例

${code('json', requestBody)}

## 五、响应体

${isAgent ? mdTable(['字段', '类型', '说明'], AGENT_RESPONSE_ROWS) : mdTable(['字段', '类型', '说明'], WORKFLOW_RESPONSE_ROWS)}

### 响应体示例

${code('json', responseBody)}

## 六、curl 示例

${code('bash', curl)}

## 七、错误码

失败时返回统一信封：\`{ "success": false, "code": "…", "message": "…" }\`

${mdTable(['HTTP', 'code', '说明'], ERROR_CODE_ROWS)}

## 八、分享链接（公开调用，无需 Token）

${shareSection}
`;
}
