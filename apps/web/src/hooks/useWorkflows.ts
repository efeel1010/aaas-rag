import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateWorkflowInput, UpdateWorkflowInput, WorkflowStatus } from '@pulse/contracts';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  listRuns,
  setWorkflowStatus,
  updateWorkflow,
} from '../api/workflows.js';

export const workflowKeys = {
  all: ['workflows'] as const,
  detail: (id: string) => ['workflows', id] as const,
  runs: (id: string) => ['workflows', id, 'runs'] as const,
};

export function useWorkflows() {
  return useQuery({ queryKey: workflowKeys.all, queryFn: listWorkflows });
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: workflowKeys.detail(id ?? ''),
    queryFn: () => getWorkflow(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkflowInput) => createWorkflow(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  });
}

export function useUpdateWorkflow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWorkflowInput) => updateWorkflow(id, input),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: workflowKeys.all });
      qc.setQueryData(workflowKeys.detail(id), updated);
    },
  });
}

export function useSetWorkflowStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: WorkflowStatus) => setWorkflowStatus(id, status),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: workflowKeys.all });
      qc.setQueryData(workflowKeys.detail(id), updated);
    },
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  });
}

export function useWorkflowRuns(workflowId: string | undefined) {
  return useQuery({
    queryKey: workflowKeys.runs(workflowId ?? ''),
    queryFn: () => listRuns(workflowId as string),
    enabled: Boolean(workflowId),
  });
}
