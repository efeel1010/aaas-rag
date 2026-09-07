import { Link, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout.js';
import { DashboardPage } from './pages/dashboard/DashboardPage.js';
import { DatasetsPage } from './pages/knowledge/DatasetsPage.js';
import { DatasetFormPage } from './pages/knowledge/DatasetFormPage.js';
import { DatasetDetailPage } from './pages/knowledge/DatasetDetailPage.js';
import { AgentsPage } from './pages/agents/AgentsPage.js';
import { AgentFormPage } from './pages/agents/AgentFormPage.js';
import { AgentDetailPage } from './pages/agents/AgentDetailPage.js';
import { WorkflowsPage } from './pages/workflows/WorkflowsPage.js';
import { WorkflowEditorPage } from './pages/workflows/WorkflowEditorPage.js';
import { ModelsPage } from './pages/models/ModelsPage.js';
import { Button } from './components/ui/Button.js';
import { EmptyState } from './components/ui/EmptyState.js';

function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon="alert"
        title="页面不存在"
        description="访问的地址不存在或已被移除。"
        action={
          <Link to="/">
            <Button icon={<span />}>返回 Dashboard</Button>
          </Link>
        }
      />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<DashboardPage />} />
        {/* 知识库 */}
        <Route path="/datasets" element={<DatasetsPage />} />
        <Route path="/datasets/new" element={<DatasetFormPage />} />
        <Route path="/datasets/:id" element={<DatasetDetailPage />} />
        <Route path="/datasets/:id/edit" element={<DatasetFormPage />} />
        {/* Agent */}
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/new" element={<AgentFormPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/agents/:id/edit" element={<AgentFormPage />} />
        {/* 工作流 */}
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/new" element={<WorkflowEditorPage />} />
        <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
        {/* 模型配置 */}
        <Route path="/providers" element={<ModelsPage />} />
        {/* 兜底 404 */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
