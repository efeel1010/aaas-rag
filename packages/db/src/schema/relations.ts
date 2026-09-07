/**
 * Drizzle relations —— 便于 with 联表查询。
 */
import { relations } from 'drizzle-orm';
import { providers, models } from './providers';
import { datasets, documents, datasetChunks } from './datasets';
import { agents, agentDatasets } from './agents';
import { intents, agentIntents } from './intents';
import { workflows, workflowNodes, workflowEdges, workflowRuns } from './workflows';
import { conversations, messages } from './conversations';

export const providersRelations = relations(providers, ({ many }) => ({
  models: many(models),
}));

export const modelsRelations = relations(models, ({ one }) => ({
  provider: one(providers, { fields: [models.providerId], references: [providers.id] }),
}));

export const datasetsRelations = relations(datasets, ({ many, one }) => ({
  documents: many(documents),
  chunks: many(datasetChunks),
  embeddingModel: one(models, {
    fields: [datasets.embeddingModelId],
    references: [models.id],
  }),
}));

export const documentsRelations = relations(documents, ({ many, one }) => ({
  dataset: one(datasets, { fields: [documents.datasetId], references: [datasets.id] }),
  chunks: many(datasetChunks),
}));

export const datasetChunksRelations = relations(datasetChunks, ({ one }) => ({
  dataset: one(datasets, { fields: [datasetChunks.datasetId], references: [datasets.id] }),
  document: one(documents, {
    fields: [datasetChunks.documentId],
    references: [documents.id],
  }),
}));

export const agentsRelations = relations(agents, ({ many, one }) => ({
  model: one(models, { fields: [agents.modelId], references: [models.id] }),
  rerankModel: one(models, {
    fields: [agents.rerankModelId],
    references: [models.id],
  }),
  agentDatasets: many(agentDatasets),
  agentIntents: many(agentIntents),
  conversations: many(conversations),
}));

export const agentDatasetsRelations = relations(agentDatasets, ({ one }) => ({
  agent: one(agents, { fields: [agentDatasets.agentId], references: [agents.id] }),
  dataset: one(datasets, {
    fields: [agentDatasets.datasetId],
    references: [datasets.id],
  }),
}));

export const intentsRelations = relations(intents, ({ many }) => ({
  agentIntents: many(agentIntents),
}));

export const agentIntentsRelations = relations(agentIntents, ({ one }) => ({
  agent: one(agents, { fields: [agentIntents.agentId], references: [agents.id] }),
  intent: one(intents, { fields: [agentIntents.intentId], references: [intents.id] }),
  dataset: one(datasets, {
    fields: [agentIntents.datasetId],
    references: [datasets.id],
  }),
}));

export const workflowsRelations = relations(workflows, ({ many }) => ({
  nodes: many(workflowNodes),
  edges: many(workflowEdges),
  runs: many(workflowRuns),
}));

export const workflowNodesRelations = relations(workflowNodes, ({ one }) => ({
  workflow: one(workflows, {
    fields: [workflowNodes.workflowId],
    references: [workflows.id],
  }),
}));

export const workflowEdgesRelations = relations(workflowEdges, ({ one }) => ({
  workflow: one(workflows, {
    fields: [workflowEdges.workflowId],
    references: [workflows.id],
  }),
}));

export const workflowRunsRelations = relations(workflowRuns, ({ one }) => ({
  workflow: one(workflows, {
    fields: [workflowRuns.workflowId],
    references: [workflows.id],
  }),
}));

export const conversationsRelations = relations(conversations, ({ many, one }) => ({
  agent: one(agents, { fields: [conversations.agentId], references: [agents.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  agent: one(agents, { fields: [messages.agentId], references: [agents.id] }),
}));