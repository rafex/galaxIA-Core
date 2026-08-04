/** Eventos recibidos por la interfaz local. No son parte del protocolo FHS. */

import type { KbCitation } from "@rafex/galaxia-fhs-protocol";

export interface ProvenanceInfo {
  llm: { providerId: string; providerName: string; model: string };
  tools: Array<{ capability: string; providerId: string; providerName: string; retention?: string; citations?: KbCitation[] }>;
  dataExported: string;
  jurisdiction: string;
}

export type AgentEvent =
  | { type: "session"; data: { conversationId: string } }
  | { type: "agent.status"; data: { conversationId: string; status: string; message: string } }
  | { type: "llm.selected"; data: { conversationId: string; providerId: string; providerName: string; modelId: string; reason: string[] } }
  | { type: "llm.streaming"; data: { conversationId: string; delta: string } }
  | { type: "tool.selected"; data: { conversationId: string; capability: string; providerId: string; providerName: string } }
  | { type: "tool.running"; data: { conversationId: string; name: string; providerId: string } }
  | { type: "tool.completed"; data: { conversationId: string; name: string; duration: number; success: boolean } }
  | { type: "tool.error"; data: { conversationId: string; name: string; error: string } }
  | { type: "assistant.delta"; data: { conversationId: string; text: string } }
  | { type: "assistant.completed"; data: { conversationId: string; provenance: ProvenanceInfo } }
  | { type: "ocr.extracted"; data: { conversationId: string; filename: string; text: string } }
  | { type: "node.lost"; data: { providerId: string; providerName: string; services: { kind: string; capabilities: string[] }[] } }
  | { type: "node.online"; data: { providerId: string; providerName: string; services: { kind: string; capabilities: string[] }[] } }
  | { type: "kb.recommended"; data: { conversationId: string; candidates: Array<{ providerId: string; providerName: string; description: string }>; chosenByLlm?: boolean } }
  | { type: "provider.failover"; data: { conversationId: string; capability: string; failedProviderId: string; failedProviderName: string; nextProviderId: string; nextProviderName: string } }
  | { type: "error"; data: { conversationId?: string; code: string; message: string } };
