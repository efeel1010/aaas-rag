/**
 * API Key 明文工具 —— 生成 / 哈希 / 校验 / 范围校验。
 * 安全约定：明文密钥只在创建时返回一次，落库仅存 SHA-256 哈希与混淆 prefix。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from '@pulse/contracts';
import { env } from '../config/env.js';
import { ForbiddenError } from './errors.js';

const SECRET_BYTES = 24;

/** 计算密钥 SHA-256 十六进制哈希 */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 常量时间比较（长度不同直接不等，绝不泄露长度信息） */
export function verifyApiKey(raw: string, storedHash: string): boolean {
  const a = Buffer.from(hashApiKey(raw), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface GeneratedKey {
  /** 明文密钥（仅创建时返回一次） */
  raw: string;
  /** 落库哈希 */
  hashed: string;
  /** 混淆展示位（前缀 + 明文前段 + 哈希尾段） */
  prefix: string;
}

/** 生成带前缀密钥：rk_<24 随机字节 base64url> */
export function generateApiKey(): GeneratedKey {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const raw = `${env.API_KEY_PREFIX}_${secret}`;
  const hashed = hashApiKey(raw);
  const prefix = `${raw.slice(0, 6)}…${hashed.slice(-4)}`;
  return { raw, hashed, prefix };
}

/** 鉴权时需校验的目标资源 */
export interface ScopeTarget {
  agentId?: string | null;
  datasetIds?: string[];
}

/**
 * 范围（scope）校验：白名单为空 / '*' 视为不限制；命中非白名单目标返回 Forbidden。
 * 仅在有目标资源可判定时才校验（如 URL / body 携带了 agentId / datasetId）。
 */
export function checkScope(scope: ApiKeyScope | null | undefined, target: ScopeTarget): void {
  if (!scope) return;
  if (Array.isArray(scope.agents) && scope.agents.length > 0 && target.agentId) {
    if (target.agentId !== '*' && !scope.agents.includes(target.agentId)) {
      throw new ForbiddenError('API Key 无权访问该 Agent');
    }
  }
  if (Array.isArray(scope.datasets) && scope.datasets.length > 0 && target.datasetIds?.length) {
    for (const d of target.datasetIds) {
      if (d !== '*' && !scope.datasets.includes(d)) {
        throw new ForbiddenError('API Key 无权访问该知识库');
      }
    }
  }
}