import { defineConfig } from 'tsup';

/**
 * API 构建配置：
 * - 内联工作区包 @pulse/contracts（其源码为 .ts），保证产物可被 node 直接运行；
 * - 第三方依赖（hono / zod / pino 等）保持 external，从 node_modules 运行时解析。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'node22',
  clean: true,
  sourcemap: true,
  noExternal: ['@pulse/contracts'],
});