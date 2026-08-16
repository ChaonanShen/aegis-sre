import type { components } from '../../api/generated/controlPlane';

export type KnowledgeBaseRecord = components['schemas']['KnowledgeBase'];
export type KnowledgeDocumentRecord = components['schemas']['Document'];
export type DocumentPassageRecord = components['schemas']['DocumentPassage'];
export type KnowledgeSearchHit = components['schemas']['KnowledgeSearchHit'];
export interface KnowledgeAvailability {
  status: 'available' | 'unavailable' | 'degraded';
  reason?: string;
}

export interface DocumentUploadInput {
  file: File;
  service?: string;
  tags?: string[];
  idempotencyKey: string;
}

export interface KnowledgeSearchInput {
  query: string;
  knowledgeBaseIds: string[];
  service?: string;
  tagsAny?: string[];
  tagsAll?: string[];
  limit: number;
}
