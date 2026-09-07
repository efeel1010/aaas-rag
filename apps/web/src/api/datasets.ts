import type {
  CreateDatasetInput,
  DatasetRetrieveBody,
  DatasetView,
  DocumentView,
  RetrievalResult,
  SegmentView,
  SegmentUpdateInput,
  UpdateDatasetInput,
} from '@pulse/contracts';
import { del, get, patch, post, upload } from '../lib/api.js';

// ---------------- Dataset ----------------
export function listDatasets(): Promise<DatasetView[]> {
  return get('/datasets');
}

export function getDataset(id: string): Promise<DatasetView> {
  return get(`/datasets/${id}`);
}

export function createDataset(input: CreateDatasetInput): Promise<DatasetView> {
  return post('/datasets', input);
}

export function updateDataset(id: string, input: UpdateDatasetInput): Promise<DatasetView> {
  return patch(`/datasets/${id}`, input);
}

export function deleteDataset(id: string): Promise<{ id: string }> {
  return del(`/datasets/${id}`);
}

// ---------------- Documents ----------------
export interface PageResult<T> {
  items: T[];
  total: number;
}

export function listDocuments(
  datasetId: string,
  page = 1,
  perPage = 20,
): Promise<PageResult<DocumentView>> {
  return get(`/datasets/${datasetId}/documents?page=${page}&perPage=${perPage}`);
}

export function uploadDocument(datasetId: string, file: File): Promise<DocumentView> {
  return upload(`/datasets/${datasetId}/documents`, file);
}

export function indexDocument(datasetId: string, documentId: string): Promise<DocumentView> {
  return post(`/datasets/${datasetId}/documents/${documentId}/index`);
}

export function deleteDocument(datasetId: string, documentId: string): Promise<{ id: string }> {
  return del(`/datasets/${datasetId}/documents/${documentId}`);
}

// ---------------- Segments ----------------
export function listSegments(
  datasetId: string,
  opts: { page?: number; perPage?: number; documentId?: string } = {},
): Promise<PageResult<SegmentView>> {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.perPage) params.set('perPage', String(opts.perPage));
  if (opts.documentId) params.set('documentId', opts.documentId);
  const qs = params.toString();
  return get(`/datasets/${datasetId}/segments${qs ? `?${qs}` : ''}`);
}

export function updateSegment(
  datasetId: string,
  segmentId: string,
  input: SegmentUpdateInput,
): Promise<SegmentView> {
  return patch(`/datasets/${datasetId}/segments/${segmentId}`, input);
}

export function deleteSegment(datasetId: string, segmentId: string): Promise<{ id: string }> {
  return del(`/datasets/${datasetId}/segments/${segmentId}`);
}

// ---------------- Retrieval ----------------
export function retrieveDataset(
  datasetId: string,
  body: DatasetRetrieveBody,
): Promise<RetrievalResult> {
  return post(`/datasets/${datasetId}/retrieve`, body);
}

export function previewDataset(
  datasetId: string,
  query: string,
  topK = 5,
): Promise<RetrievalResult> {
  return get(`/datasets/${datasetId}/preview?query=${encodeURIComponent(query)}&topK=${topK}`);
}
