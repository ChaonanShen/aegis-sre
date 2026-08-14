import React, { createContext, useContext, useMemo } from 'react';
import { createFixtureApprovalGateway } from '../features/approvals/adapters/fixtureApprovalGateway';
import { ApprovalGateway } from '../features/approvals/ports/ApprovalGateway';
import { createFixtureAlertGateway } from '../features/alerts/adapters/fixtureAlertGateway';
import { AlertGateway } from '../features/alerts/ports/AlertGateway';
import { createFixtureAuditGateway } from '../features/audit/adapters/fixtureAuditGateway';
import { AuditGateway } from '../features/audit/ports/AuditGateway';
import { createFixtureKnowledgeGateway } from '../features/knowledge/adapters/fixtureKnowledgeGateway';
import { KnowledgeGateway } from '../features/knowledge/ports/KnowledgeGateway';
import { createResourcePlaybookCrudGateway } from '../features/playbooks/adapters/resourcePlaybookCrudGateway';
import { PlaybookCrudGateway } from '../features/playbooks/ports/PlaybookCrudGateway';
import { createFixtureSkillGateway } from '../features/skills/adapters/fixtureSkillGateway';
import { SkillGateway } from '../features/skills/ports/SkillGateway';
import { createFixtureWorkbenchGateway } from '../features/workbench/adapters/fixtureWorkbenchGateway';
import { createResourceWorkbenchGateway } from '../features/workbench/adapters/resourceWorkbenchGateway';
import { WorkbenchGateway } from '../features/workbench/ports/WorkbenchGateway';
import { createFixtureFolderGateway } from './adapters/fixtureFolderGateway';
import { createGrafanaFolderGateway } from './adapters/grafanaFolderGateway';
import { FolderGateway } from './ports/FolderGateway';
import { createResourceKnowledgeManagementGateway } from '../features/knowledge/adapters/resourceKnowledgeManagementGateway';
import { KnowledgeManagementGateway } from '../features/knowledge/ports/KnowledgeManagementGateway';
import {
  unavailableAlertGateway,
  unavailableApprovalGateway,
  unavailableAuditGateway,
  unavailableKnowledgeGateway,
  unavailableSkillGateway,
} from './adapters/unavailableGateways';

export interface AppServices {
  runtimeMode: RuntimeMode;
  auditGateway: AuditGateway;
  alertGateway: AlertGateway;
  approvalGateway: ApprovalGateway;
  folderGateway: FolderGateway;
  knowledgeGateway: KnowledgeGateway;
  knowledgeManagementGateway?: KnowledgeManagementGateway;
  playbookGateway: PlaybookCrudGateway;
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
  playbookGateway: createResourcePlaybookCrudGateway(),
  skillGateway: createFixtureSkillGateway(),
  workbenchGateway: createFixtureWorkbenchGateway(),
};

const AppServicesContext = createContext<AppServices | undefined>(undefined);

export function AppServicesProvider({
  children,
  services,
  runtimeMode = 'real',
}: React.PropsWithChildren<{ services?: Partial<AppServices>; runtimeMode?: RuntimeMode }>) {
  const value = useMemo(() => {
    // 只有显式 fixture 模式才允许内存数据；真实模式未接通的能力必须明确失败。
    const defaults: AppServices = {
      runtimeMode,
      auditGateway: runtimeMode === 'fixture' ? fixtureServices.auditGateway : unavailableAuditGateway,
      alertGateway: runtimeMode === 'fixture' ? fixtureServices.alertGateway : unavailableAlertGateway,
      approvalGateway: runtimeMode === 'fixture' ? fixtureServices.approvalGateway : unavailableApprovalGateway,
      folderGateway:
        services?.folderGateway ??
        (runtimeMode === 'fixture' ? fixtureServices.folderGateway : createGrafanaFolderGateway()),
      knowledgeGateway: runtimeMode === 'fixture' ? fixtureServices.knowledgeGateway : unavailableKnowledgeGateway,
      knowledgeManagementGateway:
        runtimeMode === 'real' && !services?.knowledgeGateway ? createResourceKnowledgeManagementGateway() : undefined,
      skillGateway: runtimeMode === 'fixture' ? fixtureServices.skillGateway : unavailableSkillGateway,
      workbenchGateway:
        services?.workbenchGateway ??
        (runtimeMode === 'fixture' ? fixtureServices.workbenchGateway : createResourceWorkbenchGateway()),
      playbookGateway: services?.playbookGateway ?? createResourcePlaybookCrudGateway(),
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
