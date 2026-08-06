import { create } from "@bufbuild/protobuf";
import { generateKeyPair, publicKeyFromRaw } from "@libp2p/crypto/keys";
import { base58btc } from "multiformats/bases/base58";
import type { AgentEvent } from "../types/fhs.js";
import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";
import {
  decodeEnvelopeFrame,
  encodeEnvelopeFrame,
  encodeMessage,
  newEnvelope,
} from "@rafex/galaxia-fhs-protocol/wire";
import { FHS_STREAM_PROTOCOL } from "@rafex/galaxia-fhs-protocol/constants";
import { loadBootstrapAddresses } from "./p2p-config.js";
import { createPortalP2pNode, discoverNavigator, type P2pStream, type PortalP2pNode } from "./p2p-discovery.js";

export interface ApiOptions {
  conversationId?: string;
  message: string;
  artifacts?: string[];
  attachmentName?: string;
  /** Contexto OCR efímero del chat; viaja como DocumentContext Protobuf. */
  documentContext?: {
    filename: string;
    documentId?: string;
    source?: "local" | "network";
    embeddingModel?: string;
    embeddingDimensions?: number;
    chunks: Array<{
      chunkId: string;
      filename: string;
      chunkIndex: number;
      text: string;
      score: number;
      source?: string;
    }>;
  };
  documentId?: string;
  preferences?: {
    model?: string;
    scope?: "local" | "network" | "community" | "external";
    allowExternalProviders?: boolean;
    kb?: string;
    kbMaxPerQuestion?: number;
    ipfs?: {
      enabled: boolean;
      network: "public" | "private";
      retention: "ephemeral" | "reuse";
    };
    ragSource?: "local" | "network";
  };
}

export interface ChatConnection {
  send(options: ApiOptions): void;
  sendKbDecision(conversationId: string, use: boolean): void;
  reconnect(): void;
  close(): void;
}

export type ChatConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ChatConnectionStatusInfo {
  automatic: boolean;
  attempt: number;
  retryInMs?: number;
  message?: string;
  exhausted?: boolean;
}

const MAX_AUTOMATIC_RECONNECT_ATTEMPTS = 5;
const AUTOMATIC_RECONNECT_BASE_DELAY_MS = 1_000;
const AUTOMATIC_RECONNECT_MAX_DELAY_MS = 15_000;

type P2pPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>;

export function connectToChat(
  onEvent: (event: AgentEvent) => void,
  onOpen?: () => void,
  onStatus?: (status: ChatConnectionStatus, info?: ChatConnectionStatusInfo) => void,
): ChatConnection {
  let node: PortalP2pNode | undefined;
  let stream: P2pStream | undefined;
  let pending: ApiOptions | null = null;
  let closedByCaller = false;
  const sessionId = crypto.randomUUID();
  let ready = false;
  let privateKey: P2pPrivateKey | undefined;
  let sourcePeerId = "";
  let opening = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;

  void openSession();

  async function openSession(): Promise<void> {
    if (opening || closedByCaller) return;
    opening = true;
    const generation = ++connectionGeneration;
    ready = false;
    onStatus?.("connecting", { automatic: reconnectAttempt > 0, attempt: reconnectAttempt });
    const previousNode = node;
    node = undefined;
    stream = undefined;
    privateKey = undefined;
    sourcePeerId = "";
    await previousNode?.stop().catch(() => undefined);
    let bootstrapAddrs: string[];
    try {
      bootstrapAddrs = await loadBootstrapAddresses(
        [import.meta.env.VITE_FHS_BOOTSTRAP_ADDRS as string | undefined],
        typeof localStorage === "undefined" ? undefined : localStorage,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStatus?.("disconnected", { automatic: false, attempt: reconnectAttempt, message, exhausted: true });
      onEvent({ type: "error", data: { code: "P2P_CONFIG", message } });
      opening = false;
      return;
    }
    if (bootstrapAddrs.length === 0) {
      const message = "Falta FHS_BOOTSTRAP_ADDRS o fhs.bootstrap-addrs";
      onStatus?.("disconnected", { automatic: false, attempt: reconnectAttempt, message, exhausted: true });
      onEvent({ type: "error", data: { code: "P2P_CONFIG", message } });
      opening = false;
      return;
    }

    try {
      privateKey = await generateKeyPair("Ed25519");
      sourcePeerId = didFromRaw(privateKey.publicKey.raw);
      node = await createPortalP2pNode(privateKey);
      const discovered = await discoverNavigator(node, bootstrapAddrs);
      const openedStream = await discovered.connection.newStream(FHS_STREAM_PROTOCOL);
      stream = openedStream;

      await sendEnvelope(openedStream, makeHandshake(privateKey.publicKey.raw), privateKey);
      void readFrames(openedStream, privateKey.publicKey.raw, generation);
    } catch (error) {
      const failedNode = node;
      node = undefined;
      stream = undefined;
      privateKey = undefined;
      sourcePeerId = "";
      await failedNode?.stop().catch(() => undefined);
      handleTransportFailure("P2P_CONNECT", error instanceof Error ? error.message : String(error));
    } finally {
      opening = false;
    }
  }

  async function readFrames(streamToRead: P2pStream, publicKey: Uint8Array, generation: number): Promise<void> {
    let buffer = new Uint8Array();
    try {
      for await (const chunk of streamToRead) {
        const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
        const joined = new Uint8Array(buffer.byteLength + bytes.byteLength);
        joined.set(buffer);
        joined.set(bytes, buffer.byteLength);
        buffer = joined;

        while (buffer.byteLength > 0) {
          try {
            const decoded = decodeEnvelopeFrame(buffer);
            buffer = buffer.slice(decoded.bytesConsumed);
            if (!await verifyEnvelope(decoded.envelope, publicKey)) continue;
            handleEnvelope(decoded.envelope, generation);
          } catch (error) {
            if (error instanceof Error && error.message.includes("incompleto")) break;
            throw error;
          }
        }
      }
      if (!closedByCaller && generation === connectionGeneration) handleTransportFailure("P2P_CLOSED", "Sesión libp2p cerrada");
    } catch (error) {
      if (!closedByCaller && generation === connectionGeneration) {
        handleTransportFailure("P2P_STREAM", error instanceof Error ? error.message : String(error));
      }
    }
  }

  function handleEnvelope(envelope: FhsProto.Envelope, generation: number): void {
    if (generation !== connectionGeneration) return;
    switch (envelope.payload.case) {
      case "handshakeAck":
        ready = true;
        reconnectAttempt = 0;
        clearReconnectTimer();
        onStatus?.("connected", { automatic: false, attempt: 0 });
        if (pending) {
          const next = pending;
          pending = null;
          send(next);
        }
        onOpen?.();
        break;
      case "agentStatus":
        onEvent({ type: "agent.status", data: { conversationId: envelope.payload.value.missionId, status: envelope.payload.value.status, message: envelope.payload.value.status } });
        break;
      case "starSelected":
        onEvent({ type: "llm.selected", data: { conversationId: envelope.payload.value.missionId, providerId: envelope.payload.value.providerId, providerName: envelope.payload.value.providerId, modelId: envelope.payload.value.model, reason: [] } });
        break;
      case "toolSelected":
        onEvent({ type: "tool.selected", data: { conversationId: envelope.payload.value.missionId, capability: envelope.payload.value.capabilityId, providerId: envelope.payload.value.providerId, providerName: envelope.payload.value.providerId } });
        break;
      case "assistantDelta":
        onEvent({ type: "assistant.delta", data: { conversationId: envelope.payload.value.missionId, text: envelope.payload.value.delta } });
        break;
      case "assistantCompleted": {
        const provenance = envelope.payload.value.provenance;
        if (!provenance) break;
        onEvent({ type: "assistant.completed", data: { conversationId: envelope.payload.value.missionId, provenance: {
          llm: { providerId: provenance.providerId, providerName: provenance.providerId, model: provenance.model },
          tools: provenance.toolProviderIds.map((providerId) => ({ capability: "tool", providerId, providerName: providerId })),
          dataExported: provenance.dataExported ? "true" : "Ninguno",
          jurisdiction: provenance.jurisdiction,
        } } });
        break;
      }
      case "ocrExtracted":
        onEvent({ type: "ocr.extracted", data: { conversationId: envelope.payload.value.missionId, filename: envelope.payload.value.filename, text: envelope.payload.value.text } });
        break;
      case "kbRecommended":
        onEvent({ type: "kb.recommended", data: {
          conversationId: envelope.payload.value.missionId,
          candidates: envelope.payload.value.candidates.map((candidate) => ({ providerId: candidate.providerId, providerName: candidate.providerName, description: candidate.description })),
          chosenByLlm: envelope.payload.value.chosenByLlm,
        } });
        break;
      case "error":
        onEvent({ type: "error", data: { conversationId: sessionId, code: String(envelope.payload.value.code), message: envelope.payload.value.message } });
        break;
      default:
        break;
    }
  }

  function send(options: ApiOptions): void {
    if (!ready) {
      pending = options;
      clearReconnectTimer();
      void openSession();
      return;
    }
    const preferences = options.preferences ?? {};
    void (async () => {
      if (!stream || !privateKey) return;
      await sendEnvelope(stream, newEnvelope({
      sourcePeerId,
      destPeerId: "",
      payload: {
        case: "agentStart",
        value: create(FhsProto.AgentStartMessageSchema, {
          sessionId,
          scope: preferences.scope ?? "community",
          model: preferences.model ?? "",
          kb: preferences.kb ?? "",
          kbMaxPerQuestion: preferences.kbMaxPerQuestion ?? 1,
          ipfsEnabled: preferences.ipfs?.enabled ?? false,
          ipfsNetwork: preferences.ipfs?.network ?? "public",
          ipfsRetention: preferences.ipfs?.retention ?? "ephemeral",
          ragSource: preferences.ragSource === "network" ? FhsProto.RagSource.NETWORK : FhsProto.RagSource.LOCAL,
        }),
      },
      }), privateKey);
      await sendChatRequest(options);
    })().catch((error: unknown) => {
      onEvent({ type: "error", data: { conversationId: sessionId, code: "P2P_SEND", message: error instanceof Error ? error.message : String(error) } });
    });
  }

  async function sendChatRequest(options: ApiOptions): Promise<void> {
    if (!stream || !privateKey) return;
    await sendEnvelope(stream, newEnvelope({
      sourcePeerId,
      payload: {
        case: "chatRequest",
        value: create(FhsProto.ChatRequestMessageSchema, {
          missionId: sessionId,
          messages: [create(FhsProto.MessageSchema, { role: "user", content: options.message })],
          model: options.preferences?.model ?? "",
          artifacts: toInlineArtifacts(options.artifacts, options.attachmentName),
          documentContext: options.documentContext
            ? create(FhsProto.DocumentContextSchema, {
              ...options.documentContext,
              source: options.documentContext.source === "network" ? FhsProto.RagSource.NETWORK : FhsProto.RagSource.LOCAL,
            })
            : undefined,
          documentId: options.documentId ?? options.documentContext?.documentId ?? "",
        }),
      },
    }), privateKey);
  }

  return {
    send,
    sendKbDecision: (conversationId: string, use: boolean) => {
      void sendControlEnvelope({ case: "kbDecision", value: create(FhsProto.KbDecisionMessageSchema, { missionId: conversationId, use }) });
    },
    reconnect: () => {
      if (closedByCaller) closedByCaller = false;
      clearReconnectTimer();
      reconnectAttempt = 0;
      ready = false;
      const activeNode = node;
      node = undefined;
      stream = undefined;
      privateKey = undefined;
      sourcePeerId = "";
      void activeNode?.stop().catch(() => undefined);
      void openSession();
    },
    close: () => {
      closedByCaller = true;
      clearReconnectTimer();
      ready = false;
      onStatus?.("disconnected");
      void node?.stop();
    },
  };

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function handleTransportFailure(code: string, message: string): void {
    if (closedByCaller || reconnectTimer !== undefined) return;
    ready = false;
    const attempt = reconnectAttempt + 1;
    if (attempt <= MAX_AUTOMATIC_RECONNECT_ATTEMPTS) {
      reconnectAttempt = attempt;
      const retryInMs = Math.min(
        AUTOMATIC_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
        AUTOMATIC_RECONNECT_MAX_DELAY_MS,
      );
      onStatus?.("connecting", { automatic: true, attempt, retryInMs, message });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void openSession();
      }, retryInMs);
      return;
    }

    onStatus?.("disconnected", { automatic: true, attempt, message, exhausted: true });
    onEvent({ type: "error", data: { code, message } });
  }

  async function sendControlEnvelope(payload: FhsProto.Envelope["payload"]): Promise<void> {
    if (!stream || !privateKey || !ready) return;
    await sendEnvelope(stream, newEnvelope({ sourcePeerId, payload }), privateKey);
  }
}

async function sendEnvelope(stream: P2pStream, envelope: FhsProto.Envelope, privateKey: { sign(data: Uint8Array): Uint8Array | Promise<Uint8Array> }): Promise<void> {
  if (!envelope.payload.case) return;
  const payload = encodePayload(envelope.payload);
  const signature = await privateKey.sign(new TextEncoder().encode(signaturePayload(
    envelope.messageId,
    envelope.sourcePeerId,
    envelope.destPeerId,
    Number(envelope.timestamp),
    bytesToHex(payload),
  )));
  const sealed = create(FhsProto.EnvelopeSchema, { ...envelope, signature });
  stream.send(encodeEnvelopeFrame(sealed));
}

function makeHandshake(rawPublicKey: Uint8Array): FhsProto.Envelope {
  return newEnvelope({
    sourcePeerId: didFromRaw(rawPublicKey),
    payload: {
      case: "handshake",
      value: create(FhsProto.HandshakeMessageSchema, {
        fhsVersion: "0.1",
        listenAddrs: [],
          beacon: create(FhsProto.BeaconSchema, {
          fhsVersion: "0.1",
          provider: create(FhsProto.ProviderIdentitySchema, { id: didFromRaw(rawPublicKey), type: FhsProto.ProviderType.MULTI, visibility: FhsProto.Visibility.COMMUNITY, name: "Portal" }),
        }),
      }),
    },
  });
}

function didFromRaw(raw: Uint8Array): string {
  return `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...raw]))}`;
}

function encodePayload(payload: FhsProto.Envelope["payload"]): Uint8Array {
  const schemas = {
    handshake: FhsProto.HandshakeMessageSchema,
    handshakeAck: FhsProto.HandshakeAckMessageSchema,
    agentStart: FhsProto.AgentStartMessageSchema,
    chatRequest: FhsProto.ChatRequestMessageSchema,
    chatCancel: FhsProto.ChatCancelMessageSchema,
    agentStatus: FhsProto.AgentStatusMessageSchema,
    starSelected: FhsProto.StarSelectedMessageSchema,
    toolSelected: FhsProto.ToolSelectedMessageSchema,
    assistantDelta: FhsProto.AssistantDeltaMessageSchema,
    assistantCompleted: FhsProto.AssistantCompletedMessageSchema,
    ocrExtracted: FhsProto.OcrExtractedMessageSchema,
    kbRecommended: FhsProto.KbRecommendedMessageSchema,
    kbDecision: FhsProto.KbDecisionMessageSchema,
    error: FhsProto.ErrorMessageSchema,
    ping: FhsProto.PingMessageSchema,
    pong: FhsProto.PongMessageSchema,
    chatDelta: FhsProto.ChatDeltaMessageSchema,
    chatCompleted: FhsProto.ChatCompletedMessageSchema,
    chatError: FhsProto.ChatErrorMessageSchema,
    dispatchAck: FhsProto.DispatchAckMessageSchema,
    toolCall: FhsProto.ToolCallRequestMessageSchema,
    toolCancel: FhsProto.ToolCancelMessageSchema,
    toolResult: FhsProto.ToolCallResultMessageSchema,
    toolError: FhsProto.ToolCallErrorMessageSchema,
    toolList: FhsProto.ToolListRequestMessageSchema,
    toolListResp: FhsProto.ToolListResponseMessageSchema,
    nodeAdvertise: FhsProto.NodeAdvertiseMessageSchema,
    missionOffer: FhsProto.MissionOfferMessageSchema,
    missionBid: FhsProto.MissionBidMessageSchema,
    missionAssign: FhsProto.MissionAssignMessageSchema,
    dhtBeacon: FhsProto.DhtBeaconRecordSchema,
    dhtReputation: FhsProto.DhtReputationRecordSchema,
    missionFeedback: FhsProto.MissionFeedbackMessageSchema,
    reputationUpdate: FhsProto.ReputationUpdateMessageSchema,
  } as const;
  if (!payload.case) return new Uint8Array();
  const schema = schemas[payload.case];
  if (!schema) throw new TypeError(`FHS payload sin schema protobuf: ${payload.case}`);
  return encodeMessage(schema, payload.value as never);
}

async function verifyEnvelope(envelope: FhsProto.Envelope, _ownPublicKey: Uint8Array): Promise<boolean> {
  if (!envelope.sourcePeerId || envelope.signature.byteLength === 0) return false;
  const encoded = base58btc.decode(envelope.sourcePeerId.slice("did:key:".length));
  if (encoded[0] !== 0xed || encoded[1] !== 0x01) return false;
  const publicKey = publicKeyFromRaw(encoded.slice(2));
  const payload = encodePayload(envelope.payload);
  const signed = new TextEncoder().encode(signaturePayload(envelope.messageId, envelope.sourcePeerId, envelope.destPeerId, Number(envelope.timestamp), bytesToHex(payload)));
  return await publicKey.verify(signed, envelope.signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signaturePayload(messageId: string, sourcePeerId: string, destPeerId: string, timestamp: number, payloadBytesHex: string): string {
  return `${messageId}:${sourcePeerId}:${destPeerId}:${timestamp}:${payloadBytesHex}`;
}

function toInlineArtifacts(artifacts: string[] | undefined, filename: string | undefined): FhsProto.ArtifactRef[] {
  return (artifacts ?? []).map((artifact) => {
    const [, encoded] = artifact.split(",", 2);
    const bytes = Uint8Array.from(atob(encoded ?? artifact), (character) => character.charCodeAt(0));
    return create(FhsProto.ArtifactRefSchema, {
      transport: {
        case: "inline",
        value: create(FhsProto.InlineArtifactSchema, { data: bytes, filename: filename ?? "archivo adjunto" }),
      },
    });
  });
}
