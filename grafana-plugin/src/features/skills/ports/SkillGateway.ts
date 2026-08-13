import {
  CreateSkillInput,
  ResolveSkillRunInput,
  Skill,
  SkillListInput,
  SkillRun,
  SkillRunEvent,
  SkillsRuntimeInfo,
  StartSkillRunInput,
  UpdateSkillInput,
} from '../model';

export interface SkillGateway {
  listSkills(input: SkillListInput, signal?: AbortSignal): Promise<Skill[]>;
  getSkill(id: string, signal?: AbortSignal): Promise<Skill>;
  createSkill(input: CreateSkillInput, signal?: AbortSignal): Promise<Skill>;
  updateSkill(
    id: string,
    input: UpdateSkillInput,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<Skill>;
  deleteSkill(id: string, expectedVersion: number, signal?: AbortSignal): Promise<void>;
  getRuntimeInfo(signal?: AbortSignal): Promise<SkillsRuntimeInfo>;
  listRuns(skillId: string, signal?: AbortSignal): Promise<SkillRun[]>;
  startDryRun(input: StartSkillRunInput, signal: AbortSignal): AsyncIterable<SkillRunEvent>;
  resolveRun(input: ResolveSkillRunInput, signal: AbortSignal): AsyncIterable<SkillRunEvent>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<SkillRun>;
}
