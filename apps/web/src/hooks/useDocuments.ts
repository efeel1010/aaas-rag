import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteDocument,
  indexDocument,
  listDocuments,
  uploadDocument,
  type PageResult,
} from '../api/datasets.js';
import type { DocumentView } from '@pulse/contracts';

export const documentKeys = {
  all: (datasetId: string) => ['datasets', datasetId, 'documents'] as const,
};

/** 文档列表；存在中间态（parsing/splitting/indexing）时自动轮询刷新进度 */
export function useDocuments(datasetId: string, page = 1, perPage = 20) {
  return useQuery({
    queryKey: [...documentKeys.all(datasetId), page, perPage] as const,
    queryFn: () => listDocuments(datasetId, page, perPage),
    refetchInterval: (query) => {
      const data = query.state.data as PageResult<DocumentView> | undefined;
      const busy = data?.items.some((d) =>
        ['parsing', 'splitting', 'indexing'].includes(d.status),
      );
      return busy ? 2000 : false;
    },
  });
}

export function useUploadDocument(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadDocument(datasetId, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentKeys.all(datasetId) });
      qc.invalidateQueries({ queryKey: ['datasets', datasetId] });
      qc.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

export function useIndexDocument(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => indexDocument(datasetId, documentId),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: documentKeys.all(datasetId) });
      // 刷新 dataset（docCount）与切片
      qc.invalidateQueries({ queryKey: ['datasets', datasetId] });
      qc.invalidateQueries({ queryKey: ['segments', datasetId] });
      void doc;
    },
  });
}

export function useDeleteDocument(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => deleteDocument(datasetId, documentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentKeys.all(datasetId) });
      qc.invalidateQueries({ queryKey: ['datasets', datasetId] });
      qc.invalidateQueries({ queryKey: ['datasets'] });
      qc.invalidateQueries({ queryKey: ['segments', datasetId] });
    },
  });
}
