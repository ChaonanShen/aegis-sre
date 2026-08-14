import type { components } from '../../api/generated/controlPlane';

export type KnowledgeBaseRecord = components['schemas']['KnowledgeBase'];
export type KnowledgeDocumentRecord = components['schemas']['Document'];
export type KnowledgeChunkRecord = components['schemas']['KnowledgeChunk'];
export type KnowledgeSearchHit = components['schemas']['KnowledgeSearchHit'];

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
  limit: number;
  threshold: number;
}
