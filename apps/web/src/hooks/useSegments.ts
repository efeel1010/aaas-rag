import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SegmentUpdateInput } from '@pulse/contracts';
import { deleteSegment, listSegments, updateSegment } from '../api/datasets.js';

export const segmentKeys = {
  all: (datasetId: string) => ['segments', datasetId] as const,
};

export function useSegments(
  datasetId: string,
  opts: { page?: number; perPage?: number; documentId?: string } = {},
) {
  return useQuery({
    queryKey: [...segmentKeys.all(datasetId), opts.page ?? 1, opts.perPage ?? 20, opts.documentId] as const,
    queryFn: () => listSegments(datasetId, opts),
  });
}

export function useUpdateSegment(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ segmentId, input }: { segmentId: string; input: SegmentUpdateInput }) =>
      updateSegment(datasetId, segmentId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: segmentKeys.all(datasetId) }),
  });
}

export function useDeleteSegment(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (segmentId: string) => deleteSegment(datasetId, segmentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: segmentKeys.all(datasetId) }),
  });
}
