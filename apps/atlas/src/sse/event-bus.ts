import type { AgentSSEEvent } from "@rafex/galaxia-fhs-protocol";

export interface SSEClient {
  id: string;
  send(event: AgentSSEEvent): void;
}

export class EventBus {
  private clients = new Map<string, SSEClient>();
  private runtimes: Array<(event: AgentSSEEvent) => void> = [];

  subscribe(client: SSEClient): () => void {
    this.clients.set(client.id, client);
    return () => {
      this.clients.delete(client.id);
    };
  }

  subscribeToRuntime(handler: (event: AgentSSEEvent) => void): () => void {
    this.runtimes.push(handler);
    return () => {
      const idx = this.runtimes.indexOf(handler);
      if (idx >= 0) this.runtimes.splice(idx, 1);
    };
  }

  emit(event: AgentSSEEvent) {
    for (const client of this.clients.values()) {
      client.send(event);
    }
    for (const handler of this.runtimes) {
      handler(event);
    }
  }

  broadcastToRuntimes(event: AgentSSEEvent) {
    for (const handler of this.runtimes) {
      handler(event);
    }
  }
}
