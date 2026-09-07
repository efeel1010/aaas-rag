/**
 * 测试环境兜底。
 *
 * env.ts 采用「启动即校验、缺配置 fail-fast」策略（process.exit(1)），
 * 但单测只验证逻辑、不依赖真实密钥/数据库。这里在 worker 加载测试文件
 * 前注入合法的占位环境变量，避免 env 链（agent-store → db → env）在 import 时终止进程。
 */
process.env.NODE_ENV ??= 'test';
process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.MOCK_MODELS ??= 'true';
process.env.MOCK_INGEST ??= 'true';
