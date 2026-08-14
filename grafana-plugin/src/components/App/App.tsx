import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppRootProps, PageLayoutType } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { AppServicesProvider, RuntimeMode } from '../../app/AppServices';
import { AppShell } from '../../app/AppShell';
import { AppShellProvider } from '../../app/AppShellContext';
import { FeaturePendingPage } from '../../app/FeaturePendingPage';
import { ROUTES } from '../../constants';
import '../../app/app.css';

const WorkbenchPage = React.lazy(() => import('../../features/workbench/WorkbenchPage'));
const KnowledgePage = React.lazy(() => import('../../features/knowledge/KnowledgePage'));
const PlaybooksPage = React.lazy(() => import('../../features/playbooks/PlaybooksPage'));
const SkillsPage = React.lazy(() => import('../../features/skills/SkillsPage'));
const ApprovalsPage = React.lazy(() => import('../../features/approvals/ApprovalsPage'));
const AlertsPage = React.lazy(() => import('../../features/alerts/AlertsPage'));
const AuditPage = React.lazy(() => import('../../features/audit/AuditPage'));

function App(props: AppRootProps) {
  const runtimeMode = configuredRuntimeMode(props.meta.jsonData);
  const realOnlyUnavailable = (title: string, page: React.ReactNode) =>
    runtimeMode === 'real' ? <FeaturePendingPage title={title} /> : page;
  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <AppServicesProvider runtimeMode={runtimeMode}>
        <AppShellProvider>
          <AppShell>
            <Routes>
              <Route path={`${ROUTES.Workbench}/:sessionId?`} element={<WorkbenchPage />} />
              <Route path={ROUTES.Knowledge} element={<KnowledgePage />} />
              <Route path={ROUTES.Playbooks} element={<PlaybooksPage />} />
              <Route path={`${ROUTES.Playbooks}/*`} element={<PlaybooksPage />} />
              <Route path={ROUTES.Skills} element={realOnlyUnavailable('Skills', <SkillsPage />)} />
              <Route path={`${ROUTES.Skills}/*`} element={realOnlyUnavailable('Skills', <SkillsPage />)} />
              <Route path={ROUTES.Approvals} element={realOnlyUnavailable('审批', <ApprovalsPage />)} />
              <Route path={`${ROUTES.Alerts}/:alertId?`} element={realOnlyUnavailable('告警', <AlertsPage />)} />
              <Route path={ROUTES.Audit} element={realOnlyUnavailable('审计', <AuditPage />)} />
              <Route path="*" element={<Navigate replace to={ROUTES.Workbench} />} />
            </Routes>
          </AppShell>
        </AppShellProvider>
      </AppServicesProvider>
    </PluginPage>
  );
}

export function configuredRuntimeMode(jsonData: unknown): RuntimeMode {
  if (
    typeof jsonData === 'object' &&
    jsonData !== null &&
    'workbenchMode' in jsonData &&
    jsonData.workbenchMode === 'fixture'
  ) {
    return 'fixture';
  }
  return 'real';
}

export default App;
