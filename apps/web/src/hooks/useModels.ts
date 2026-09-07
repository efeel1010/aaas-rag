import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateModelInput, UpdateModelInput } from '@pulse/contracts';
import { createModel, deleteModel, listModels, updateModel } from '../api/models.js';

export const modelKeys = {
  all: (providerId?: string) => ['models', providerId ?? 'all'] as const,
};

export function useModels(providerId?: string) {
  return useQuery({
    queryKey: modelKeys.all(providerId),
    queryFn: () => listModels(providerId),
  });
}

export function useCreateModel(providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateModelInput) => createModel(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: modelKeys.all(providerId) });
      qc.invalidateQueries({ queryKey: modelKeys.all() });
      qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

export function useUpdateModel(providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateModelInput }) => updateModel(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: modelKeys.all(providerId) });
      qc.invalidateQueries({ queryKey: modelKeys.all() });
    },
  });
}

export function useDeleteModel(providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteModel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: modelKeys.all(providerId) });
      qc.invalidateQueries({ queryKey: modelKeys.all() });
      qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}
