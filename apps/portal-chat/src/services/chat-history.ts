import type { ChatConversation, ChatMessage, RagMode, RagSource } from "../types/fhs.js";

export const CHAT_HISTORY_STORAGE_KEY = "fhs.chat.history.v1";
export const CHAT_HISTORY_SCHEMA_VERSION = 1;

export interface ChatHistory {
  schemaVersion: typeof CHAT_HISTORY_SCHEMA_VERSION;
  conversations: ChatConversation[];
}

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 500;

export function createChatHistory(): ChatHistory {
  return { schemaVersion: CHAT_HISTORY_SCHEMA_VERSION, conversations: [] };
}

export function loadChatHistory(storage: Storage = window.localStorage): ChatHistory {
  try {
    const raw = storage.getItem(CHAT_HISTORY_STORAGE_KEY);
    if (!raw) return createChatHistory();
    const parsed: unknown = JSON.parse(raw);
    if (!isChatHistory(parsed)) return createChatHistory();
    return trimHistory(parsed);
  } catch {
    return createChatHistory();
  }
}

export function saveChatHistory(history: ChatHistory, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(trimHistory(history)));
  } catch {
    // Quota privada o almacenamiento deshabilitado: la conversación sigue
    // funcionando en memoria durante esta sesión.
  }
}

export function createConversation(
  now = Date.now(),
  id = crypto.randomUUID(),
  ragMode: RagMode = "common",
  ragSource: RagSource = "local",
): ChatConversation {
  return { id, title: "Nueva conversación", createdAt: now, updatedAt: now, ragMode, ragSource, messages: [] };
}

export function deriveConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "Nueva conversación";
  const title = firstUserMessage.content.replace(/\s+/g, " ").trim();
  return title.length > 48 ? `${title.slice(0, 48).trimEnd()}…` : title || "Nueva conversación";
}

export function upsertConversation(history: ChatHistory, conversation: ChatConversation): ChatHistory {
  const conversations = history.conversations.filter((item) => item.id !== conversation.id);
  conversations.push({
    ...conversation,
    ragMode: normalizeRagMode(conversation.ragMode),
    ragSource: normalizeRagSource(conversation.ragSource),
    title: deriveConversationTitle(conversation.messages),
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
  });
  return trimHistory({ schemaVersion: CHAT_HISTORY_SCHEMA_VERSION, conversations });
}

export function formatMessageTime(timestamp: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

export function formatDayLabel(timestamp: number, now = Date.now(), locale?: string): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  if (sameLocalDay(date, today)) return "Hoy";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(date, yesterday)) return "Ayer";
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function trimHistory(history: ChatHistory): ChatHistory {
  return {
    schemaVersion: CHAT_HISTORY_SCHEMA_VERSION,
    conversations: [...history.conversations]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
      .map((conversation) => ({
        ...conversation,
        ragMode: normalizeRagMode(conversation.ragMode),
        ragSource: normalizeRagSource(conversation.ragSource),
        messages: conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
      })),
  };
}

function isChatHistory(value: unknown): value is ChatHistory {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { schemaVersion?: unknown; conversations?: unknown };
  return candidate.schemaVersion === CHAT_HISTORY_SCHEMA_VERSION &&
    Array.isArray(candidate.conversations) &&
    candidate.conversations.every(isChatConversation);
}

function isChatConversation(value: unknown): value is ChatConversation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatConversation>;
  return typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    (candidate.ragMode === undefined || candidate.ragMode === "common" || candidate.ragMode === "independent") &&
    (candidate.ragSource === undefined || candidate.ragSource === "local" || candidate.ragSource === "network") &&
    Array.isArray(candidate.messages) &&
    candidate.messages.every(isChatMessage);
}

function normalizeRagMode(mode: RagMode | undefined): RagMode {
  return mode === "independent" ? "independent" : "common";
}

function normalizeRagSource(source: RagSource | undefined): RagSource {
  return source === "network" ? "network" : "local";
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatMessage> & { failed?: unknown; failureMessage?: unknown };
  return typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    typeof candidate.createdAt === "number" &&
    (candidate.failed === undefined || typeof candidate.failed === "boolean") &&
    (candidate.failureMessage === undefined || typeof candidate.failureMessage === "string");
}
