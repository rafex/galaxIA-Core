import type { AgentEvent } from "../agent/events.js";

export interface EventClient {
  id: string;
  send(event: AgentEvent): void;
}

export class EventBus {
  private clients = new Map<string, EventClient>();
  private runtimes: Array<(event: AgentEvent) => void> = [];

  subscribe(client: EventClient): () => void {
    this.clients.set(client.id, client);
    return () => {
      this.clients.delete(client.id);
    };
  }

  subscribeToRuntime(handler: (event: AgentEvent) => void): () => void {
    this.runtimes.push(handler);
    return () => {
      const idx = this.runtimes.indexOf(handler);
      if (idx >= 0) this.runtimes.splice(idx, 1);
    };
  }

  emit(event: AgentEvent): void {
    for (const client of this.clients.values()) client.send(event);
    for (const handler of this.runtimes) handler(event);
  }

  broadcastToRuntimes(event: AgentEvent): void {
    for (const handler of this.runtimes) handler(event);
  }
}
