import { Hono } from 'hono';
import { agentsRoutes } from './modules/agents.js';
import { apiKeysRoutes } from './modules/api-keys.js';
import { chatRoutes } from './modules/chat.js';
import { datasetsRoutes } from './modules/datasets.js';
import { healthRoutes } from './modules/health.js';
import { modelsRoutes } from './modules/models.js';
import { providersRoutes } from './modules/providers.js';
import { shareRoutes } from './modules/share.js';
import { workflowsRoutes } from './modules/workflows.js';
import type { AppEnv } from '../types.js';

/**
 * /api/v1 下的路由聚合。
 * 新增业务模块时：在 modules/ 下建文件，并在此挂载。
 */
export const v1Routes = new Hono<AppEnv>()
  .route('', healthRoutes)
  .route('/datasets', datasetsRoutes)
  .route('/agents', agentsRoutes)
  .route('/workflows', workflowsRoutes)
  .route('/models', modelsRoutes)
  .route('/providers', providersRoutes)
  .route('/api-keys', apiKeysRoutes)
  .route('/share', shareRoutes)
  .route('/chat', chatRoutes);