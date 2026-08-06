export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_TOP_K = 4;
export const DEFAULT_CHUNK_SIZE = 900;
export const DEFAULT_CHUNK_OVERLAP = 120;

export interface LocalRagDocument {
  conversationId: string;
  ragScope: string;
  documentId: string;
  filename: string;
  text: string;
}

export interface LocalRagQuery {
  conversationId: string;
  ragScope: string;
  documentId?: string;
  query: string;
  topK?: number;
}

export interface LocalRagChunk {
  id: string;
  conversationId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface LocalRagIndexResult {
  documentId: string;
  chunksIndexed: number;
  embeddingModel: string;
  embeddingDimensions: number;
  backend: "sqlite-vec-opfs" | "indexeddb";
}

export interface LocalRagStatus {
  phase: "idle" | "loading-embedding-model" | "indexing" | "querying" | "fallback";
  detail?: string;
}

export type LocalRagRequestPayload =
  | { type: "index"; document: LocalRagDocument }
  | { type: "query"; query: LocalRagQuery }
  | { type: "delete-conversation"; conversationId: string }
  | { type: "clear" };

export type LocalRagRequest =
  | { type: "index"; requestId: string; document: LocalRagDocument }
  | { type: "query"; requestId: string; query: LocalRagQuery }
  | { type: "delete-conversation"; requestId: string; conversationId: string }
  | { type: "clear"; requestId: string };

export type LocalRagResponse =
  | { type: "result"; requestId: string; value: LocalRagIndexResult | LocalRagChunk[] }
  | { type: "status"; status: LocalRagStatus }
  | { type: "error"; requestId: string; message: string };
