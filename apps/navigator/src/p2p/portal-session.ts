/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/*
 * Sesión Portal ↔ Navigator sobre el stream libp2p FHS.
 *
 * Esta es la frontera de aplicación del Portal: recibe y emite únicamente
 * Envelope/Protobuf. El EventBus sigue usando eventos locales, pero nunca los
 * serializa como JSON ni los expone por HTTP.
 */

import { create } from "@bufbuild/protobuf";
import {
  FHS_STREAM_PROTOCOL,
  FhsProto,
  newEnvelope,
  type PrivacyScope,
} from "@rafex/galaxia-fhs-protocol";
import type { EventBus } from "../events/event-bus.js";
import type { AgentEvent } from "../agent/events.js";
import { AgentRuntime, type ModelPreferences } from "../agent/runtime.js";
import type { FhsIdentity, FhsNode } from "./nav-node.js";
import { decodeStream, sendEnvelope } from "./stream-codec.js";
import type { P2pProviders } from "./index.js";

interface PendingAttachment {
  text: string;
  filename: string;
  question?: string;
  preferences: ModelPreferences;
  confirmed: boolean;
}

interface PendingKbRecommendation {
  message: { role: "user"; content: string };
  preferences: ModelPreferences;
  candidates: Array<{ providerId: string; providerName: string; description: string }>;
}

export function registerPortalSession(
  node: FhsNode,
  identity: FhsIdentity,
  eventBus: EventBus,
  providers: P2pProviders,
): void {
  node.handle(FHS_STREAM_PROTOCOL, async (stream: FhsNode) => {
    const messages = decodeStream(stream);
    const first = await messages.next();
    if (first.done || first.value.payload.case !== "handshake") return;

    const remoteDid = first.value.sourcePeerId;
    sendEnvelope(stream, newEnvelope({
      sourcePeerId: identity.did,
      destPeerId: remoteDid,
      payload: {
        case: "handshakeAck",
        value: create(FhsProto.HandshakeAckMessageSchema, {
          fhsVersion: "0.1",
          leaseSeconds: 300,
          heartbeatSeconds: 30,
          leaseExpires: BigInt(Date.now() + 300_000),
          trustLevel: "community",
        }),
      },
    }));

    let sessionId: string | undefined;
    let preferences: ModelPreferences = {};
    let activeRuntime: AgentRuntime | undefined;
    const pendingAttachments = new Map<string, PendingAttachment>();
    const pendingKbRecommendations = new Map<string, PendingKbRecommendation>();
    const ragActiveConversations = new Set<string>();
    const clientId = `p2p-portal-${remoteDid}-${Date.now()}`;

    const unsubscribe = eventBus.subscribe({
      id: clientId,
      send: (event) => {
        if (!sessionId || !belongsToSession(event, sessionId)) return;
        const envelope = eventToEnvelope(event, identity.did, remoteDid, sessionId);
        if (envelope) sendEnvelope(stream, envelope);
      },
    });

    const runChat = (
      id: string,
      message: { role: "user"; content: string },
      currentPreferences: ModelPreferences,
      preExtractedText?: string,
      artifacts?: string[],
      kbProviderIds?: string[],
    ) => {
      activeRuntime = new AgentRuntime(
        providers.atlasClient,
        eventBus,
        id,
        remoteDid,
        providers.llmGateway,
        providers.mcpHost,
      );
      void activeRuntime.run(
        message,
        currentPreferences,
        artifacts,
        preExtractedText,
        ragActiveConversations.has(id),
        kbProviderIds,
      ).catch((error: unknown) => {
        eventBus.emit({
          type: "error",
          data: {
            conversationId: id,
            code: "RUNTIME_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    };

    const resolveKbAndChat = (id: string, message: { role: "user"; content: string }, currentPreferences: ModelPreferences) => {
      if (currentPreferences.kb) {
        runChat(id, message, currentPreferences, undefined, undefined, [currentPreferences.kb]);
        return;
      }

      const runtime = new AgentRuntime(
        providers.atlasClient,
        eventBus,
        id,
        remoteDid,
        providers.llmGateway,
        providers.mcpHost,
      );
      void runtime.resolveKbCandidates(message.content, currentPreferences).then(({ candidates, chosenByLlm }) => {
        if (candidates.length === 0) {
          runChat(id, message, currentPreferences);
          return;
        }
        pendingKbRecommendations.set(id, { message, preferences: currentPreferences, candidates });
        eventBus.emit({ type: "kb.recommended", data: { conversationId: id, candidates, chosenByLlm } });
      }).catch(() => runChat(id, message, currentPreferences));
    };

    const indexForRag = (id: string, text: string, currentPreferences: ModelPreferences) => {
      const runtime = new AgentRuntime(
        providers.atlasClient,
        eventBus,
        id,
        remoteDid,
        providers.llmGateway,
        providers.mcpHost,
      );
      void runtime.indexDocumentForRag(text, currentPreferences).then((indexed) => {
        if (indexed) ragActiveConversations.add(id);
      }).catch(() => undefined);
    };

    try {
      for await (const envelope of messages) {
        switch (envelope.payload.case) {
          case "agentStart":
            sessionId = envelope.payload.value.sessionId || sessionId || crypto.randomUUID();
            preferences = preferencesFromStart(envelope.payload.value);
            break;
          case "chatRequest": {
            const request = envelope.payload.value;
            const lastMessage = request.messages.at(-1);
            if (!lastMessage || lastMessage.role !== "user") {
              sendError(stream, identity.did, remoteDid, sessionId, "INVALID_ARGUMENTS", "Se requiere un mensaje user");
              break;
            }

            const conversationId = sessionId || request.missionId || crypto.randomUUID();
            sessionId = conversationId;
            const currentPreferences = { ...preferences, model: request.model || preferences.model };
            let artifacts: string[];
            try {
              artifacts = await artifactRefsToDataUrls(request.artifacts);
            } catch (error: unknown) {
              sendError(stream, identity.did, remoteDid, conversationId, "INVALID_ARGUMENTS", error instanceof Error ? error.message : String(error));
              break;
            }
            if (artifacts.length > 0) {
              if (currentPreferences.ocrMode === "auto") {
                runChat(conversationId, { role: "user", content: lastMessage.content }, currentPreferences, undefined, artifacts);
                break;
              }
              const runtime = new AgentRuntime(providers.atlasClient, eventBus, conversationId, remoteDid, providers.llmGateway, providers.mcpHost);
              void runtime.extractOcrText(artifacts, artifactFilename(request.artifacts[0]), currentPreferences).then((text) => {
                if (text) {
                  pendingAttachments.set(conversationId, {
                    text,
                    filename: artifactFilename(request.artifacts[0]),
                    question: lastMessage.content || undefined,
                    preferences: currentPreferences,
                    confirmed: false,
                  });
                } else {
                  sendError(stream, identity.did, remoteDid, conversationId, "OCR_FAILED", "No se pudo procesar el archivo adjunto.");
                }
              }).catch((error: unknown) => sendError(stream, identity.did, remoteDid, conversationId, "RUNTIME_ERROR", error instanceof Error ? error.message : String(error)));
              break;
            }

            const pending = pendingAttachments.get(conversationId);
            if (pending?.confirmed) {
              pendingAttachments.delete(conversationId);
              runChat(conversationId, { role: "user", content: lastMessage.content }, currentPreferences, pending.text);
              break;
            }
            resolveKbAndChat(conversationId, { role: "user", content: lastMessage.content }, currentPreferences);
            break;
          }
          case "attachmentDecision": {
            const decision = envelope.payload.value;
            const pending = pendingAttachments.get(decision.missionId);
            if (!pending) break;
            if (!decision.use) {
              pendingAttachments.delete(decision.missionId);
              break;
            }
            indexForRag(decision.missionId, pending.text, pending.preferences);
            if (pending.question) {
              pendingAttachments.delete(decision.missionId);
              runChat(decision.missionId, { role: "user", content: pending.question }, pending.preferences, pending.text);
            } else {
              pending.confirmed = true;
            }
            break;
          }
          case "kbDecision": {
            const decision = envelope.payload.value;
            const pending = pendingKbRecommendations.get(decision.missionId);
            if (!pending) break;
            pendingKbRecommendations.delete(decision.missionId);
            runChat(decision.missionId, pending.message, pending.preferences, undefined, undefined, decision.use ? pending.candidates.map((candidate) => candidate.providerId) : undefined);
            break;
          }
          case "chatCancel":
            activeRuntime = undefined;
            sendError(stream, identity.did, remoteDid, sessionId, "CANCELLED", "Misión cancelada");
            break;
          default:
            break;
        }
      }
    } finally {
      unsubscribe();
      activeRuntime = undefined;
    }
  });
}

function preferencesFromStart(value: FhsProto.AgentStartMessage): ModelPreferences {
  return {
    model: value.model || undefined,
    scope: toPrivacyScope(value.scope),
    ocrMode: value.ocrMode === "auto" ? "auto" : "confirm",
    kb: value.kb || undefined,
    kbMaxPerQuestion: value.kbMaxPerQuestion || undefined,
    ipfs: value.ipfsEnabled ? {
      enabled: true,
      network: value.ipfsNetwork === "private" ? "private" : "public",
      retention: value.ipfsRetention === "reuse" ? "reuse" : "ephemeral",
    } : undefined,
  };
}

function artifactFilename(value: FhsProto.ArtifactRef | undefined): string {
  if (!value) return "archivo adjunto";
  if (value.transport.case === "inline") return value.transport.value.filename || "archivo adjunto";
  if (value.transport.case === "ipfs") return value.transport.value.filename || "archivo adjunto";
  return "archivo adjunto";
}

async function artifactRefsToDataUrls(artifacts: FhsProto.ArtifactRef[]): Promise<string[]> {
  const values: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.transport.case === "inline") {
      values.push(`data:${mimeFromFilename(artifact.transport.value.filename)};base64,${Buffer.from(artifact.transport.value.data).toString("base64")}`);
    } else if (artifact.transport.case === "ipfs") {
      const baseUrl = artifact.transport.value.gatewayUrl || "https://ipfs.io/ipfs";
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/${artifact.transport.value.cid}`);
      if (!response.ok) throw new Error(`No se pudo leer el ArtifactRef IPFS (${response.status})`);
      values.push(`data:application/octet-stream;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`);
    }
  }
  return values;
}

function mimeFromFilename(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop();
  return extension === "pdf" ? "application/pdf" : extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "application/octet-stream";
}

function belongsToSession(event: AgentEvent, sessionId: string): boolean {
  return "conversationId" in event.data ? event.data.conversationId === sessionId : true;
}

function eventToEnvelope(
  event: AgentEvent,
  sourcePeerId: string,
  destPeerId: string,
  missionId: string,
) {
  switch (event.type) {
    case "agent.status":
      return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "agentStatus", value: create(FhsProto.AgentStatusMessageSchema, { missionId, status: event.data.status }) } });
    case "llm.selected":
      return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "starSelected", value: create(FhsProto.StarSelectedMessageSchema, { missionId, providerId: event.data.providerId, model: event.data.modelId }) } });
    case "tool.selected":
      return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "toolSelected", value: create(FhsProto.ToolSelectedMessageSchema, { missionId, providerId: event.data.providerId, capabilityId: event.data.capability }) } });
    case "assistant.delta":
      return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "assistantDelta", value: create(FhsProto.AssistantDeltaMessageSchema, { missionId, delta: event.data.text }) } });
    case "ocr.extracted":
      return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "ocrExtracted", value: create(FhsProto.OcrExtractedMessageSchema, { missionId, filename: event.data.filename, text: event.data.text }) } });
    case "kb.recommended":
      return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "kbRecommended", value: create(FhsProto.KbRecommendedMessageSchema, { missionId, chosenByLlm: event.data.chosenByLlm ?? false, candidates: event.data.candidates.map((candidate) => create(FhsProto.KbCandidateSchema, candidate)) }) } });
    case "assistant.completed":
      return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "assistantCompleted", value: create(FhsProto.AssistantCompletedMessageSchema, { missionId, provenance: create(FhsProto.ProvenanceInfoSchema, { providerId: event.data.provenance.llm.providerId, model: event.data.provenance.llm.model, toolProviderIds: event.data.provenance.tools.map((tool) => tool.providerId), dataExported: event.data.provenance.dataExported === "true", jurisdiction: event.data.provenance.jurisdiction }) }) } });
    case "error":
      return errorEnvelope(sourcePeerId, destPeerId, missionId, event.data.code, event.data.message);
    default:
      return undefined;
  }
}

function sendError(stream: FhsNode, sourcePeerId: string, destPeerId: string, missionId: string | undefined, code: string, message: string): void {
  sendEnvelope(stream, errorEnvelope(sourcePeerId, destPeerId, missionId ?? "", code, message));
}

function errorEnvelope(sourcePeerId: string, destPeerId: string, missionId: string, code: string, message: string) {
  return newEnvelope({ sourcePeerId, destPeerId, payload: { case: "error", value: create(FhsProto.ErrorMessageSchema, { code: code === "CANCELLED" ? FhsProto.FhsErrorCode.CANCELLED : FhsProto.FhsErrorCode.INTERNAL_ERROR, message: `${missionId}: ${message}` }) } });
}

function toPrivacyScope(value: string): PrivacyScope | undefined {
  return value === "local" || value === "network" || value === "community" || value === "external" ? value : undefined;
}
