import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_STORAGE_KEY,
  createChatHistory,
  deriveConversationTitle,
  formatDuration,
  loadChatHistory,
  saveChatHistory,
  upsertConversation,
} from "../src/services/chat-history.js";
import type { ChatMessage } from "../src/types/fhs.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("chat-history", () => {
  it("persiste conversaciones en almacenamiento local y conserva su título", () => {
    const storage = new MemoryStorage();
    const message: ChatMessage = { id: "m1", role: "user", content: "¿Qué hora es?", createdAt: 1_000 };
    const conversation = { id: "c1", title: "Nueva conversación", createdAt: 1_000, updatedAt: 1_000, messages: [message] };
    const history = upsertConversation(createChatHistory(), conversation);

    saveChatHistory(history, storage);
    const restored = loadChatHistory(storage);

    expect(storage.getItem(CHAT_HISTORY_STORAGE_KEY)).toContain("¿Qué hora es?");
    expect(restored.conversations[0]?.title).toBe("¿Qué hora es?");
    expect(restored.conversations[0]?.messages).toEqual([message]);
  });

  it("acorta títulos largos y formatea la duración de la respuesta", () => {
    const message: ChatMessage = { id: "m1", role: "user", content: "a".repeat(60), createdAt: 1_000 };
    expect(deriveConversationTitle([message])).toHaveLength(49);
    expect(formatDuration(2_450)).toBe("2.5 s");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
  });
});
