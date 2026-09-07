import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProviderInput, UpdateProviderInput } from '@pulse/contracts';
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  pingProvider,
  updateProvider,
} from '../api/providers.js';

export const providerKeys = {
  all: ['providers'] as const,
  detail: (id: string) => ['providers', id] as const,
};

export function useProviders() {
  return useQuery({ queryKey: providerKeys.all, queryFn: listProviders });
}

export function useProvider(id: string | undefined) {
  return useQuery({
    queryKey: providerKeys.detail(id ?? ''),
    queryFn: () => getProvider(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProviderInput) => createProvider(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: providerKeys.all }),
  });
}

export function useUpdateProvider(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProviderInput) => updateProvider(id, input),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: providerKeys.all });
      qc.setQueryData(providerKeys.detail(id), updated);
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProvider(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providerKeys.all });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });
}

export function usePingProvider(id: string) {
  return useMutation({
    mutationFn: (modelId?: string) => pingProvider(id, modelId),
  });
}
