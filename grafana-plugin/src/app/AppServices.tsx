import React, { createContext, useContext, useMemo } from 'react';
import { createFixtureApprovalGateway } from '../features/approvals/adapters/fixtureApprovalGateway';
import { ApprovalGateway } from '../features/approvals/ports/ApprovalGateway';
import { createFixtureAlertGateway } from '../features/alerts/adapters/fixtureAlertGateway';
import { AlertGateway } from '../features/alerts/ports/AlertGateway';
import { createFixtureAuditGateway } from '../features/audit/adapters/fixtureAuditGateway';
import { AuditGateway } from '../features/audit/ports/AuditGateway';
import { createFixtureKnowledgeGateway } from '../features/knowledge/adapters/fixtureKnowledgeGateway';
import { KnowledgeGateway } from '../features/knowledge/ports/KnowledgeGateway';
import { createFixturePlaybookGateway } from '../features/playbooks/adapters/fixturePlaybookGateway';
import { PlaybookGateway } from '../features/playbooks/ports/PlaybookGateway';
import { createFixtureSkillGateway } from '../features/skills/adapters/fixtureSkillGateway';
import { SkillGateway } from '../features/skills/ports/SkillGateway';
import { createFixtureWorkbenchGateway } from '../features/workbench/adapters/fixtureWorkbenchGateway';
import { createResourceWorkbenchGateway } from '../features/workbench/adapters/resourceWorkbenchGateway';
import { WorkbenchGateway } from '../features/workbench/ports/WorkbenchGateway';
import { createFixtureFolderGateway } from './adapters/fixtureFolderGateway';
import { FolderGateway } from './ports/FolderGateway';

export interface AppServices {
  runtimeMode: RuntimeMode;
  auditGateway: AuditGateway;
  alertGateway: AlertGateway;
  approvalGateway: ApprovalGateway;
  folderGateway: FolderGateway;
  knowledgeGateway: KnowledgeGateway;
  playbookGateway: PlaybookGateway;
  skillGateway: SkillGateway;
  workbenchGateway: WorkbenchGateway;
}

export type RuntimeMode = 'real' | 'fixture';

const fixtureServices: Omit<AppServices, 'runtimeMode'> = {
  auditGateway: createFixtureAuditGateway(),
  alertGateway: createFixtureAlertGateway(),
  approvalGateway: createFixtureApprovalGateway(),
  folderGateway: createFixtureFolderGateway(),
  knowledgeGateway: createFixtureKnowledgeGateway(),
  playbookGateway: createFixturePlaybookGateway(),
  skillGateway: createFixtureSkillGateway(),
  workbenchGateway: createFixtureWorkbenchGateway(),
};

const unavailableFolderGateway: FolderGateway = {
  async listFolders(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    // Grafana Folder 的真实读取和授权尚未接入，真实模式不能用 fixture 权限代替。
    return [];
  },
};

const AppServicesContext = createContext<AppServices | undefined>(undefined);

export function AppServicesProvider({
  children,
  services,
  runtimeMode = 'real',
}: React.PropsWithChildren<{ services?: Partial<AppServices>; runtimeMode?: RuntimeMode }>) {
  const value = useMemo(() => {
    // 只有显式 fixture 模式才使用内存会话；其他未接通的页面暂时继续使用各自 fixture。
    const defaults: AppServices = {
      ...fixtureServices,
      runtimeMode,
      folderGateway: runtimeMode === 'fixture' ? fixtureServices.folderGateway : unavailableFolderGateway,
      workbenchGateway:
        services?.workbenchGateway ??
        (runtimeMode === 'fixture' ? fixtureServices.workbenchGateway : createResourceWorkbenchGateway()),
    };
    // runtimeMode 由 Provider 统一拥有，普通 gateway 覆盖不能悄悄改变能力边界。
    return { ...defaults, ...services, runtimeMode };
  }, [runtimeMode, services]);
  return <AppServicesContext.Provider value={value}>{children}</AppServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) {
    throw new Error('useAppServices must be used inside AppServicesProvider.');
  }
  return services;
}
