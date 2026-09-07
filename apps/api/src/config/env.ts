import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

/**
 * 布尔型环境变量解析：字符串 "true"/"false"（大小写不敏感）→ boolean。
 * 注意不可直接使用 z.coerce.boolean()：它会用 Boolean() 做转换，把字符串 "false"
 * 也判为 true（任何非空字符串皆 truthy），导致 .env 里的 MOCK_*=false 被错误地解析为 true。
 */
const booleanFromEnv = z.preprocess((v) => {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return v;
}, z.boolean());

// 显式加载仓库根目录的 .env：必须在下方 schema 基于 process.env 求值之前执行。
// tsx dev 从 apps/api 目录启动，dotenv/config 只扫 cwd，找不到根 .env，故用绝对路径指向仓库根。
dotenvConfig({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});

/**
 * 集中式、启动即校验的配置。
 * 缺失 / 非法环境变量会导致进程 fail-fast，绝不静默使用默认值继续运行。
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://pulse:pulse@localhost:5432/pulse'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  // M2 模型网关
  /** 字段级加密密钥（AES-256-GCM），64 位 hex。生成：openssl rand -hex 32 */
  MODEL_CREDENTIALS_ENCRYPTION_KEY: z.string().length(64),
  /** 置为 true 时全部 Provider 走本地 Mock，不发起真实请求（无外网可测） */
  MOCK_MODELS: booleanFromEnv.default(false),
  /** 置为 true 时 ingest 全部使用确定性假向量，跳过真实 embedding（无外网可跑通入库+检索） */
  MOCK_INGEST: booleanFromEnv.default(false),
  // M7 开放 API 网关
  /** 对外 API Key 明文前缀（如 rk），用于生成 / 识别密钥 */
  API_KEY_PREFIX: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/).default('rk'),
  // M-A 工具循环
  /** ReAct 工具循环最大轮数（每轮 = 一次工具决策 + 一次执行）；超限强制收敛到最终生成 */
  AGENT_TOOL_MAX_ROUNDS: z.coerce.number().int().min(1).max(20).default(3),
  // M-C 第三方实时工具（OpenAlex 学术检索）
  /** 置为 true 时第三方实时工具（openalex_search 等）返回确定性假数据，不发起真实请求（无外网可测） */
  MOCK_TOOLS: booleanFromEnv.default(false),
  /** OpenAlex 免费 API Key（2026-02 起更稳；可选，不配也能跑 1rps）。也可经 ctx.openAlexApiKey 注入 */
  OPENALEX_API_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).optional(),
  ),
  /** OpenAlex 联络邮箱（mailto，走 polite pool 5rps 更稳；可选，缺省用占位邮箱） */
  OPENALEX_MAILTO: z.string().trim().optional(),
  /** 置为 true 时「管理类」路由也强制要求 API Key（默认仅对外调用类强制） */
  ENABLE_API_KEY_FOR_MANAGEMENT: booleanFromEnv.default(false),
  /** Redis 连接/命令超时(ms)：连接失败或超时即降级为「放行 + 降级日志」，不阻塞业务 */
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(2000),
  /** Redis 降级后重试冷却(ms)：到期后会重新尝试连接以自动恢复限流 */
  REDIS_RETRY_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    `[config] 环境变量校验失败，进程终止:\n${JSON.stringify(
      parsed.error.flatten().fieldErrors,
      null,
      2,
    )}`,
  );
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';