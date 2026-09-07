import { QueryClient } from '@tanstack/react-query';

/** 全局 QueryClient：查询失败默认静默重试 1 次（避免 404 抖动） */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});
