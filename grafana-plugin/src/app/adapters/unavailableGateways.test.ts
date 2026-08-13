import {
  CapabilityUnavailableError,
  unavailableAlertGateway,
  unavailableApprovalGateway,
  unavailableAuditGateway,
  unavailableFolderGateway,
  unavailableKnowledgeGateway,
  unavailableSkillGateway,
} from './unavailableGateways';

describe('real-mode unavailable gateways', () => {
  test.each([
    ['folders', () => unavailableFolderGateway.listFolders()],
    ['alerts', () => unavailableAlertGateway.listAlerts({})],
    ['approvals', () => unavailableApprovalGateway.getApproval('apr_abcdefgh')],
    ['audit', () => unavailableAuditGateway.queryAudit({})],
    ['knowledge', () => unavailableKnowledgeGateway.getSnapshot('folder')],
    ['skills', () => unavailableSkillGateway.getSkill('skl_abcdefgh')],
  ])('%s fails explicitly instead of returning fixture data', async (_name, operation) => {
    await expect(operation()).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(operation()).rejects.toMatchObject({ code: 'capability_unavailable' });
  });
});
