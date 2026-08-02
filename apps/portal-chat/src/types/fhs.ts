import type { AgentSSEEvent, ProvenanceInfo } from "@rafex/galaxia-fhs-protocol";

export * from "@rafex/galaxia-fhs-protocol";

export type ChatMessage =
  | { role: "user"; content: string; attachmentName?: string; attachmentIsPdf?: boolean }
  | { role: "assistant"; content: string; provenance?: ProvenanceInfo };

export interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  selectedModel: string;
  privacyScope: "local" | "network" | "community" | "external";
  ocrMode: "confirm" | "auto";
  /** "" = modo recomendado (matching determinístico + confirmación); un providerId = modo manual (SPEC-KB-0001) */
  kbProviderId: string;
  /** SPEC-KB-0002 (DEC-0054) — cuántas KBs se consultan por pregunta cuando no hay selección manual. */
  kbMaxPerQuestion: number;
  /** SPEC-IPFS-0001 (DEC-0052) — configuración explícita, no por adjunto/conversación. */
  ipfsEnabled: boolean;
  ipfsNetwork: "public" | "private";
  ipfsRetention: "ephemeral" | "reuse";
}

export type { AgentSSEEvent };
