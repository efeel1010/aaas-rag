/**
 * providers.credentials 的字段级加密/解密 —— AES-256-GCM。
 *
 * 设计：
 *  - 密钥来自 env `MODEL_CREDENTIALS_ENCRYPTION_KEY`（64 位 hex = 32 字节），
 *    缺省即抛错，绝不使用内置默认密钥（fail-fast，防密钥硬编码泄露）。
 *  - 逐字段加密：value 先 JSON 序列化，再 AES-256-GCM 加密。
 *  - 密文格式 `v1.<iv>b64.<tag>b64.<data>b64`，其中附带随机 12 字节 IV，
 *    每次加密 IV 唯一（GCM 默认随机 nonce，重放 IV 才需递增计数）。
 *  - 该模块不 import env，密钥以参数显式注入，便于单元测试与依赖隔离。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

/** AES-256-GCM 参数 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'v1';

/** 读取并校验密钥，供运行时（非测试）从 env 加载 */
export function getRuntimeEncryptionKey(): Buffer {
  const hex = process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      '缺少 MODEL_CREDENTIALS_ENCRYPTION_KEY（64 位 hex）。生成：openssl rand -hex 32',
    );
  }
  return keyFromHex(hex);
}

/** 从 hex 解码密钥 */
export function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `MODEL_CREDENTIALS_ENCRYPTION_KEY 必须是 ${KEY_LENGTH * 2} 位 hex（当前 ${hex.length} 位）`,
    );
  }
  return key;
}

/** 加密单个字段（可为 string / number / boolean）为密文字符串 */
export function encryptField(value: unknown, key: Buffer): string {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

/** 解密单个字段；非法或格式不符时抛出异常（调用方不应泄露密文细节） */
export function decryptField(cipherText: string, key: Buffer): unknown {
  const parts = cipherText.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('凭据密文格式非法');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64!, 'base64');
  const tag = Buffer.from(tagB64!, 'base64');
  const data = Buffer.from(dataB64!, 'base64');
  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
    throw new Error('凭据密文参数非法');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as unknown;
}

/** 整份凭据加密：逐字段加密，返回同构的密文 record */
export function encryptCredentials(
  credentials: Record<string, string | number | boolean>,
  key: Buffer,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    out[k] = encryptField(v, key);
  }
  return out;
}

/** 整份凭据解密：逐字段解密，返回明文 record */
export function decryptCredentials(
  encrypted: Record<string, unknown>,
  key: Buffer,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(encrypted)) {
    if (typeof v !== 'string') {
      throw new Error(`凭据字段 ${k} 应为加密密文`);
    }
    out[k] = decryptField(v, key) as string | number | boolean;
  }
  return out;
}

/** 脱敏视图：保留键，值统一替换为遮蔽串（不暴露密钥长度等信息） */
export function maskCredentials(
  encrypted: Record<string, unknown> | null | undefined,
): { credentials: Record<string, string> | null; hasCredentials: boolean } {
  if (!encrypted || Object.keys(encrypted).length === 0) {
    return { credentials: null, hasCredentials: false };
  }
  const masked: Record<string, string> = {};
  for (const key of Object.keys(encrypted)) {
    masked[key] = '******';
  }
  return { credentials: masked, hasCredentials: true };
}