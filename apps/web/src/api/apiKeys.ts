import type {
  ApiCallLogList,
  ApiKeyResourceType,
  CreateShareLinkInput,
  ResourceApiAccess,
  ShareLinkView,
} from '@pulse/contracts';
import { del, get, post } from '../lib/api.js';

/** 资源级 API 访问路径前缀（agent / workflow） */
const RESOURCE_PATH: Record<ApiKeyResourceType, string> = {
  agent: 'agents',
  workflow: 'workflows',
};

/** 查询资源是否已生成独立 token（不返回明文） */
export function getResourceApiAccess(
  resourceType: ApiKeyResourceType,
  resourceId: string,
): Promise<ResourceApiAccess> {
  return get(`/${RESOURCE_PATH[resourceType]}/${resourceId}/api-access`);
}

/** 生成（幂等）：首次返回明文 token，已存在则仅返回前缀 */
export function createResourceApiAccess(
  resourceType: ApiKeyResourceType,
  resourceId: string,
): Promise<ResourceApiAccess> {
  return post(`/${RESOURCE_PATH[resourceType]}/${resourceId}/api-access`);
}

/** 轮换 token：重新生成并返回新明文（旧 token 立即失效） */
export function rotateResourceApiAccess(
  resourceType: ApiKeyResourceType,
  resourceId: string,
): Promise<ResourceApiAccess> {
  return post(`/${RESOURCE_PATH[resourceType]}/${resourceId}/api-access/rotate`);
}

/** 查询资源级 API 调用日志（分页） */
export function getResourceApiLogs(
  resourceType: ApiKeyResourceType,
  resourceId: string,
  opts: { page?: number; perPage?: number } = {},
): Promise<ApiCallLogList> {
  const params = new URLSearchParams();
  if (opts.page != null) params.set('page', String(opts.page));
  if (opts.perPage != null) params.set('perPage', String(opts.perPage));
  const qs = params.toString();
  return get(`/${RESOURCE_PATH[resourceType]}/${resourceId}/api-logs${qs ? `?${qs}` : ''}`);
}

// ---- 分享链接（多渠道发布） ----

/** 列分享链接 */
export function listShareLinks(
  resourceType: ApiKeyResourceType,
  resourceId: string,
): Promise<ShareLinkView[]> {
  return get(`/${RESOURCE_PATH[resourceType]}/${resourceId}/share-links`);
}

/** 创建分享链接（明文 token 仅本次返回） */
export function createShareLink(
  resourceType: ApiKeyResourceType,
  resourceId: string,
  input: CreateShareLinkInput = {},
): Promise<ShareLinkView> {
  return post(`/${RESOURCE_PATH[resourceType]}/${resourceId}/share-links`, input);
}

/** 撤销分享链接 */
export function revokeShareLink(
  resourceType: ApiKeyResourceType,
  resourceId: string,
  shareId: string,
): Promise<ShareLinkView> {
  return post(`/${RESOURCE_PATH[resourceType]}/${resourceId}/share-links/${shareId}/revoke`);
}

/** 删除分享链接 */
export function deleteShareLink(
  resourceType: ApiKeyResourceType,
  resourceId: string,
  shareId: string,
): Promise<{ id: string }> {
  return del(`/${RESOURCE_PATH[resourceType]}/${resourceId}/share-links/${shareId}`);
}