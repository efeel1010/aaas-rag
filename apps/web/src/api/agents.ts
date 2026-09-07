import type {
  AgentChatRequest,
  AgentChatResult,
  AgentStreamEvent,
  AgentView,
  ConversationListItem,
  ConversationMessage,
  CreateAgentInput,
  MessageFeedbackInput,
  UpdateAgentInput,
} from '@pulse/contracts';
import { del, get, patch, post, sseStream } from '../lib/api.js';
import type { SseEvent } from '../lib/api.js';

export function listAgents(): Promise<AgentView[]> {
  return get('/agents');
}

export function getAgent(id: string): Promise<AgentView> {
  return get(`/agents/${id}`);
}

export function createAgent(input: CreateAgentInput): Promise<AgentView> {
  return post('/agents', input);
}

export function updateAgent(id: string, input: UpdateAgentInput): Promise<AgentView> {
  return patch(`/agents/${id}`, input);
}

export function deleteAgent(id: string): Promise<{ id: string }> {
  return del(`/agents/${id}`);
}

/** Agent 一次性对话（非流式） */
export function agentChatOnce(agentId: string, input: AgentChatRequest): Promise<AgentChatResult> {
  return post(`/agents/${agentId}/chat`, input);
}

/** Agent 流式对话 —— SSE 事件迭代器 */
export function agentChatStream(
  agentId: string,
  input: AgentChatRequest,
): AsyncGenerator<SseEvent> {
  return sseStream(`/agents/${agentId}/chat/stream`, input);
}

/** 将 SSE 事件归一化为 Agent 流事件（供页面消费） */
export function isAgentStreamEvent(data: Record<string, unknown>): data is AgentStreamEvent {
  return (
    typeof data.type === 'string' &&
    ['meta', 'citations', 'delta', 'tool_call', 'usage', 'done', 'error'].includes(data.type)
  );
}

// ---- 会话回读与标注 ----

/** Agent 历史会话列表 */
export function listAgentConversations(agentId: string): Promise<ConversationListItem[]> {
  return get(`/agents/${agentId}/conversations`);
}

/** 会话消息回读 */
export function getConversationMessages(
  agentId: string,
  conversationId: string,
): Promise<ConversationMessage[]> {
  return get(`/agents/${agentId}/conversations/${conversationId}/messages`);
}

/** 消息标注（赞/踩；feedback=null 清除标注） */
export function feedbackMessage(
  agentId: string,
  messageId: string,
  input: MessageFeedbackInput,
): Promise<ConversationMessage> {
  return post(`/agents/${agentId}/messages/${messageId}/feedback`, input);
}
