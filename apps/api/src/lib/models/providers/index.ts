/**
 * Provider 工厂 —— 按 provider.type 分发实现。
 * 当 MOCK_MODELS=true 时统一返回 MockProvider（不发起真实请求，便于无外网验证）。
 */
import type { ProviderTypeValue } from '@pulse/contracts';
import type { ModelProvider } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import { OpenAICompatibleProvider } from './openai.js';

export const isMockMode = (): boolean => process.env.MOCK_MODELS === 'true';

export function createProvider(type: ProviderTypeValue): ModelProvider {
  if (isMockMode()) return new MockProvider();
  switch (type) {
    case 'openai':
    case 'openai_compatible':
      return new OpenAICompatibleProvider(type);
    case 'anthropic':
      return new AnthropicProvider();
    default:
      // TS 已穷举，仅为兜底
      throw new Error(`未支持的 Provider 类型: ${String(type)}`);
  }
}