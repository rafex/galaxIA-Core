import type {
  LocalRagChunk,
  LocalRagDocument,
  LocalRagIndexResult,
  LocalRagQuery,
  LocalRagRequestPayload,
  LocalRagRequest,
  LocalRagResponse,
  LocalRagStatus,
} from "./types.js";

export type { LocalRagChunk, LocalRagDocument, LocalRagIndexResult, LocalRagQuery, LocalRagStatus } from "./types.js";
export { chunkText, scopeKey } from "./chunking.js";

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

export class LocalRagStore {
  private readonly worker: Worker;
  private readonly pending = new Map<string, Pending<LocalRagIndexResult | LocalRagChunk[]>>();
  private statusListener: ((status: LocalRagStatus) => void) | undefined;

  constructor() {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<LocalRagResponse>) => {
      const response = event.data;
      if (response.type === "status") {
        this.statusListener?.(response.status);
        return;
      }
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.type === "error") pending.reject(new Error(response.message));
      else pending.resolve(response.value);
    });
    this.worker.addEventListener("error", (event) => {
      const error = event.error instanceof Error ? event.error : new Error(event.message);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  onStatus(listener: (status: LocalRagStatus) => void): void {
    this.statusListener = listener;
  }

  index(document: LocalRagDocument): Promise<LocalRagIndexResult> {
    return this.send<LocalRagIndexResult>({ type: "index", document });
  }

  query(query: LocalRagQuery): Promise<LocalRagChunk[]> {
    return this.send<LocalRagChunk[]>({ type: "query", query });
  }

  deleteConversation(conversationId: string): Promise<LocalRagIndexResult> {
    return this.send<LocalRagIndexResult>({ type: "delete-conversation", conversationId });
  }

  close(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Local RAG cerrado"));
    this.pending.clear();
  }

  private send<T extends LocalRagIndexResult | LocalRagChunk[]>(
    request: LocalRagRequestPayload,
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: LocalRagIndexResult | LocalRagChunk[]) => void, reject });
      this.worker.postMessage({ ...request, requestId } satisfies LocalRagRequest);
    });
  }
}
