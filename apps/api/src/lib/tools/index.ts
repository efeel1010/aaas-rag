/**
 * M-A 工具集统一出口：模块加载时注册内置工具（local_retrieval / http_request）。
 * M-C 起加入第三方实时工具（openalex_search）。
 */
import { registerTool } from './registry.js';
import { httpRequestTool, localRetrievalTool } from './implementations.js';
import { openAlexSearchTool } from './openalex.js';

export * from './types.js';
export * from './registry.js';
export * from './implementations.js';
export * from './openalex.js';

// 模块加载即注册内置工具（后续第三方工具 openalex/web 同样在各自模块注册）
registerTool(localRetrievalTool);
registerTool(httpRequestTool);
registerTool(openAlexSearchTool);
