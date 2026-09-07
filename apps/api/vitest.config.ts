import { defineConfig } from 'vitest/config';

/**
 * @pulse/api 测试配置：
 * - setupFiles 在每个 worker 加载测试文件前注入测试环境变量，
 *   使依赖 env 链（db/env 启动校验）的服务层单测可无 DB 运行。
 */
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup-env.ts'],
  },
});
