import type {
  CreateProviderInput,
  ProviderPingResult,
  ProviderView,
  UpdateProviderInput,
} from '@pulse/contracts';
import { del, get, patch, post } from '../lib/api.js';

/** GET /providers —— 列表（含 modelCount 附加字段） */
export function listProviders(): Promise<Array<ProviderView & { modelCount: number }>> {
  return get('/providers');
}

/** GET /providers/:id —— 详情（含 modelCount） */
export function getProvider(id: string): Promise<ProviderView & { modelCount: number }> {
  return get(`/providers/${id}`);
}

export function createProvider(input: CreateProviderInput): Promise<ProviderView> {
  return post('/providers', input);
}

export function updateProvider(id: string, input: UpdateProviderInput): Promise<ProviderView> {
  return patch(`/providers/${id}`, input);
}

export function deleteProvider(id: string): Promise<{ id: string }> {
  return del(`/providers/${id}`);
}

/** POST /providers/:id/ping —— 连通性测试（可选指定模型） */
export function pingProvider(id: string, modelId?: string): Promise<ProviderPingResult> {
  return post(`/providers/${id}/ping`, modelId ? { modelId } : {});
}
