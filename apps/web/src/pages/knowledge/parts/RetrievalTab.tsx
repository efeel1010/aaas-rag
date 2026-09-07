import { useState } from 'react';
import { retrieveDataset } from '../../../api/datasets.js';
import { useModels } from '../../../hooks/useModels.js';
import { Button } from '../../../components/ui/Button.js';
import { Field, Input, Select } from '../../../components/ui/Input.js';
import { Badge } from '../../../components/ui/Badge.js';
import { Icon } from '../../../components/ui/Icon.js';
import { Card } from '../../../components/ui/Table.js';
import { EmptyState } from '../../../components/ui/EmptyState.js';
import { useToast } from '../../../components/ui/Toast.js';
import type { RetrievalResult } from '@pulse/contracts';

function sourceTone(source: string): 'success' | 'info' | 'primary' {
  if (source === 'hybrid') return 'success';
  if (source === 'vector') return 'primary';
  return 'info';
}

const SOURCE_TEXT: Record<string, string> = {
  vector: '向量',
  keyword: '关键词',
  hybrid: '混合命中',
};

export function RetrievalTab({ datasetId }: { datasetId: string }) {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState('5');
  const [rerankModelId, setRerankModelId] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { data: models } = useModels();
  const rerankModels = (models ?? [])
    .filter((m) => m.modelType === 'rerank' && m.status === 'active')
    .map((m) => ({ value: m.id, label: m.name }));

  const run = async () => {
    const q = query.trim();
    if (!q) {
      toast.error('请输入检索查询');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await retrieveDataset(datasetId, {
        query: q,
        topK: Number(topK) || 5,
        rerankModelId: rerankModelId || undefined,
      });
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : '检索失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      {/* 查询配置 */}
      <div className="space-y-4">
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-ink">查询配置</h3>
          <div className="space-y-3">
            <Field label="Query" required hint="模拟一次真实检索的查询语句">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例如：产品的定价策略是什么？"
                onKeyDown={(e) => e.key === 'Enter' && run()}
              />
            </Field>
            <Field label="TopK" hint="召回切片数量">
              <Select
                value={topK}
                onChange={(e) => setTopK(e.target.value)}
                options={[3, 5, 10, 20].map((n) => ({ value: String(n), label: `召回 ${n} 条` }))}
              />
            </Field>
            <Field
              label="Rerank 模型"
              hint={
                rerankModels.length === 0
                  ? '暂无可用 rerank 模型（可留空，直接返回 RRF 结果）'
                  : '可选；RRF 候选先经该模型重排后再取 TopK，留空不重排'
              }
            >
              <Select
                value={rerankModelId}
                onChange={(e) => setRerankModelId(e.target.value)}
                options={[{ value: '', label: '（不启用 Rerank）' }, ...rerankModels]}
              />
            </Field>
            <Button block icon={<Icon name="search" size={15} />} onClick={run} loading={loading}>
              测试检索
            </Button>
          </div>
        </Card>
        <Card padded={false} className="text-[13px]">
          <div className="border-b border-line-soft px-4 py-2.5 text-xs font-semibold text-ink-3">
            检索说明
          </div>
          <div className="space-y-2 px-4 py-3 text-ink-3 leading-relaxed">
            <p>检索采用 <b className="text-ink-2">混合检索</b>：pgvector 余弦相似度 + 关键词（tsvector/pg_trgm），经 RRF 融合排序。</p>
            <p><b className="text-ink-2">score</b> 为融合后相关分（越高越相关）；vectorScore / keywordScore 为单路得分。</p>
            <p>选择 <b className="text-ink-2">Rerank 模型</b> 后，RRF 候选会先经该模型重排（结果带 rerankScore / originalRank），再取 TopK。</p>
            <p>mock 模式下向量为确定性伪向量，命中结果用于验证链路连通性。</p>
          </div>
        </Card>
      </div>

      {/* 结果 */}
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {!result && !error && (
          <Card className="flex items-center justify-center py-16">
            <EmptyState
              icon="search"
              title="输入查询开始检索"
              description="结果将展示命中的切片、相关分与命中来源。"
            />
          </Card>
        )}
        {result && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">
                检索结果
                <span className="ml-2 text-xs font-normal text-ink-3">
                  命中 {result.total} 条（TopK={result.topK}）
                </span>
              </h3>
              <span className="text-xs text-ink-3">query: “{result.query}”</span>
            </div>
            {result.hits.length === 0 && (
              <Card>
                <EmptyState icon="search" title="未命中任何切片" description="可调整查询或补充更多文档。">
                </EmptyState>
              </Card>
            )}
            {result.hits.map((hit, i) => (
              <div
                key={hit.chunkId}
                className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-primary/40"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="primary">Top {i + 1}</Badge>
                  <Badge tone={sourceTone(hit.source)}>{SOURCE_TEXT[hit.source] ?? hit.source}</Badge>
                  <span className="font-mono text-ink-2">score {hit.score.toFixed(4)}</span>
                  {hit.vectorScore !== null && (
                    <span className="font-mono text-ink-3">vec {hit.vectorScore?.toFixed(4)}</span>
                  )}
                  {hit.keywordScore !== null && (
                    <span className="font-mono text-ink-3">kw {hit.keywordScore?.toFixed(4)}</span>
                  )}
                  {hit.rerankScore != null && (
                    <span className="font-mono text-primary">rerank {hit.rerankScore?.toFixed(4)}</span>
                  )}
                  {hit.originalRank != null && (
                    <span className="font-mono text-ink-3">原排名 #{hit.originalRank}</span>
                  )}
                  {typeof hit.metadata?.documentName === 'string' && (
                    <span className="flex items-center gap-1 text-ink-3">
                      <Icon name="file" size={12} />
                      {hit.metadata.documentName}
                      {typeof hit.metadata.index === 'number' && ` #${hit.metadata.index}`}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{hit.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
