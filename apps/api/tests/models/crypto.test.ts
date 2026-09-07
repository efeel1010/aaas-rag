/**
 * AES-256-GCM 字段级加解密单测。
 */
import { describe, expect, it } from 'vitest';
import {
  decryptCredentials,
  decryptField,
  encryptCredentials,
  encryptField,
  keyFromHex,
  maskCredentials,
} from '../../src/lib/models/crypto.js';

// 64 位 hex（32 字节）测试密钥
const KEY = keyFromHex('a'.repeat(64));
const OTHER_KEY = keyFromHex('b'.repeat(64));

describe('crypto (AES-256-GCM field-level)', () => {
  it('keyFromHex 拒绝长度不符的密钥', () => {
    expect(() => keyFromHex('short')).toThrow(/64/);
    expect(() => keyFromHex('a'.repeat(62))).toThrow(/64/);
  });

  it('string 字段加密解密往返', () => {
    const cipher = encryptField('sk-test-123', KEY);
    expect(decryptField(cipher, KEY)).toBe('sk-test-123');
  });

  it('number / boolean 字段加密解密往返', () => {
    expect(decryptField(encryptField(42, KEY), KEY)).toBe(42);
    expect(decryptField(encryptField(true, KEY), KEY)).toBe(true);
    expect(decryptField(encryptField(null, KEY), KEY)).toBeNull();
  });

  it('同一明文两次加密结果不同（随机 IV）', () => {
    const a = encryptField('secret', KEY);
    const b = encryptField('secret', KEY);
    expect(a).not.toBe(b);
  });

  it('密文可被原密钥解密，但被错误密钥拒绝', () => {
    const cipher = encryptField('secret', KEY);
    expect(decryptField(cipher, KEY)).toBe('secret');
    expect(() => decryptField(cipher, OTHER_KEY)).toThrow();
  });

  it('篡改密文会抛出异常（GCM 完整性校验）', () => {
    const cipher = encryptField('secret', KEY);
    const parts = cipher.split('.');
    const data = parts[3]!;
    const tampered = Buffer.from(data, 'base64');
    tampered[0] ^= 0xff;
    const bad = `${parts[0]}.${parts[1]}.${parts[2]}.${tampered.toString('base64')}`;
    expect(() => decryptField(bad, KEY)).toThrow();
  });

  it('非法密文格式直接拒绝', () => {
    expect(() => decryptField('not-a-cipher', KEY)).toThrow(/格式非法/);
  });

  it('整份凭据逐字段加解密往返，保留键', () => {
    const plain = { apiKey: 'sk-abc', organization: 'org-1', timeout: 30 };
    const encrypted = encryptCredentials(plain, KEY);
    expect(Object.keys(encrypted).sort()).toEqual(['apiKey', 'organization', 'timeout']);
    // 密文不应包含明文片段
    expect(JSON.stringify(encrypted)).not.toContain('sk-abc');
    expect(decryptCredentials(encrypted, KEY)).toEqual(plain);
  });

  it('maskCredentials 对外脱敏：值全为 ****** 且传递 hasCredentials', () => {
    const encrypted = encryptCredentials({ apiKey: 'a', apiSecret: 'b' }, KEY);
    const masked = maskCredentials(encrypted);
    expect(masked.hasCredentials).toBe(true);
    expect(masked.credentials).toEqual({ apiKey: '******', apiSecret: '******' });
    // 遮蔽值不得包含真实明文片段（半字母擦除），只保留键
    expect(masked.credentials?.apiKey).toBe('******');
  });

  it('空凭据 / null 返回 hasCredentials=false', () => {
    expect(maskCredentials(null)).toEqual({ credentials: null, hasCredentials: false });
    expect(maskCredentials({})).toEqual({ credentials: null, hasCredentials: false });
  });
});