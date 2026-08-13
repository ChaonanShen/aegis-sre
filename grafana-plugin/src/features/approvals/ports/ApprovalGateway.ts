import { Approval, ApprovalListResult, ApprovalQuery, ApproveApprovalInput, RejectApprovalInput } from '../model';

export interface ApprovalGateway {
  listApprovals(query: ApprovalQuery, signal?: AbortSignal): Promise<ApprovalListResult>;
  getApproval(id: string, signal?: AbortSignal): Promise<Approval>;
  approve(input: ApproveApprovalInput, signal?: AbortSignal): Promise<Approval>;
  reject(input: RejectApprovalInput, signal?: AbortSignal): Promise<Approval>;
}
