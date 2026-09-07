import type { CreateModelInput, ModelView, UpdateModelInput } from '@pulse/contracts';
import { del, get, patch, post } from '../lib/api.js';

/** GET /models?providerId= —— 模型列表（可按 provider 过滤） */
export function listModels(providerId?: string): Promise<ModelView[]> {
  return get(providerId ? `/models?providerId=${providerId}` : '/models');
}

export function getModel(id: string): Promise<ModelView> {
  return get(`/models/${id}`);
}

export function createModel(input: CreateModelInput): Promise<ModelView> {
  return post('/models', input);
}

export function updateModel(id: string, input: UpdateModelInput): Promise<ModelView> {
  return patch(`/models/${id}`, input);
}

export function deleteModel(id: string): Promise<{ id: string }> {
  return del(`/models/${id}`);
}
