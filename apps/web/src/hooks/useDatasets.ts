import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDatasetInput, UpdateDatasetInput } from '@pulse/contracts';
import {
  createDataset,
  deleteDataset,
  getDataset,
  listDatasets,
  updateDataset,
} from '../api/datasets.js';

export const datasetKeys = {
  all: ['datasets'] as const,
  detail: (id: string) => ['datasets', id] as const,
};

export function useDatasets() {
  return useQuery({ queryKey: datasetKeys.all, queryFn: listDatasets });
}

export function useDataset(id: string | undefined) {
  return useQuery({
    queryKey: datasetKeys.detail(id ?? ''),
    queryFn: () => getDataset(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDatasetInput) => createDataset(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: datasetKeys.all }),
  });
}

export function useUpdateDataset(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDatasetInput) => updateDataset(id, input),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: datasetKeys.all });
      qc.setQueryData(datasetKeys.detail(id), updated);
    },
  });
}

export function useDeleteDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDataset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: datasetKeys.all }),
  });
}
