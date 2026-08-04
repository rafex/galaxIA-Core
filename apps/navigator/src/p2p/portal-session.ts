/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/*
 * Sesión Portal ↔ Navigator sobre el stream libp2p FHS.
 *
 * Este handler es la frontera de aplicación del Portal: recibe y emite
 * únicamente Envelope/Protobuf. El EventBus sigue usando eventos locales,
 * pero nunca los serializa como JSON ni los expone por HTTP.
 */

import { create } from "@bufbuild/protobuf";
import {
  FHS_STREAM_PROTOCOL,
  FhsProto,
  newEnvelope,
  type PrivacyScope,
} from "@rafex/galaxia-fhs-protocol";
import type { EventBus } from "../sse/event-bus.js";
import type { AgentEvent } from "../agent/events.js";
import { AgentRuntime, type ModelPreferences } from "../agent/runtime.js";
import type { FhsIdentity, FhsNode } from "./nav-node.js";
import { decodeStream, sendEnvelope } from "./stream-codec.js";
import type { P2pProviders } from "./index.js";

export function registerPortalSession(
  node: FhsNode,
  identity: FhsIdentity,
  eventBus: EventBus,
  providers: P2pProviders,
): void {
  node.handle(FHS_STREAM_PROTOCOL, async (stream: FhsNode) => {
    const messages = decodeStream(stream);
    const first = await messages.next();
    if (first.done || first.value.payload.case !== "handshake") {
      return;
    }

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
    const clientId = `p2p-portal-${remoteDid}-${Date.now()}`;
    const unsubscribe = eventBus.subscribe({
      id: clientId,
      send: (event) => {
        if (!sessionId || !belongsToSession(event, sessionId)) return;
        const envelope = eventToEnvelope(event, identity.did, remoteDid, sessionId);
        if (envelope) sendEnvelope(stream, envelope);
      },
    });

    try {
      for await (const envelope of messages) {
        switch (envelope.payload.case) {
          case "agentStart":
            sessionId = envelope.payload.value.sessionId || sessionId || crypto.randomUUID();
            preferences = {
              model: envelope.payload.value.model || undefined,
              scope: toPrivacyScope(envelope.payload.value.scope),
            };
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
            activeRuntime = new AgentRuntime(
              providers.atlasClient,
              eventBus,
              conversationId,
              remoteDid,
              providers.llmGateway,
              providers.mcpHost,
            );
            const currentPreferences = {
              ...preferences,
              model: request.model || preferences.model,
            };
            void activeRuntime.run(
              { role: "user", content: lastMessage.content },
              currentPreferences,
            ).catch((error: unknown) => {
              eventBus.emit({
                type: "error",
                data: {
                  conversationId,
                  code: "RUNTIME_ERROR",
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            });
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
      return newEnvelope({ sourcePeerId, destPeerId, payload: {
        case: "agentStatus",
        value: create(FhsProto.AgentStatusMessageSchema, { missionId, status: event.data.status }),
      } });
    case "llm.selected":
      return newEnvelope({ sourcePeerId, destPeerId, payload: {
        case: "starSelected",
        value: create(FhsProto.StarSelectedMessageSchema, {
          missionId,
          providerId: event.data.providerId,
          model: event.data.modelId,
        }),
      } });
    case "tool.selected":
      return newEnvelope({ sourcePeerId, destPeerId, payload: {
        case: "toolSelected",
        value: create(FhsProto.ToolSelectedMessageSchema, {
          missionId,
          providerId: event.data.providerId,
          capabilityId: event.data.capability,
        }),
      } });
    case "assistant.delta":
      return newEnvelope({ sourcePeerId, destPeerId, payload: {
        case: "assistantDelta",
        value: create(FhsProto.AssistantDeltaMessageSchema, { missionId, delta: event.data.text }),
      } });
    case "assistant.completed":
      return newEnvelope({ sourcePeerId, destPeerId, payload: {
        case: "assistantCompleted",
        value: create(FhsProto.AssistantCompletedMessageSchema, {
          missionId,
          provenance: create(FhsProto.ProvenanceInfoSchema, {
            providerId: event.data.provenance.llm.providerId,
            model: event.data.provenance.llm.model,
            toolProviderIds: event.data.provenance.tools.map((tool) => tool.providerId),
            dataExported: event.data.provenance.dataExported === "true",
            jurisdiction: event.data.provenance.jurisdiction,
          }),
        }),
      } });
    case "error":
      return errorEnvelope(sourcePeerId, destPeerId, missionId, event.data.code, event.data.message);
    default:
      return undefined;
  }
}

function sendError(
  stream: FhsNode,
  sourcePeerId: string,
  destPeerId: string,
  missionId: string | undefined,
  code: string,
  message: string,
): void {
  sendEnvelope(stream, errorEnvelope(sourcePeerId, destPeerId, missionId ?? "", code, message));
}

function errorEnvelope(sourcePeerId: string, destPeerId: string, missionId: string, code: string, message: string) {
  return newEnvelope({ sourcePeerId, destPeerId, payload: {
    case: "error",
    value: create(FhsProto.ErrorMessageSchema, {
      code: code === "CANCELLED" ? FhsProto.FhsErrorCode.CANCELLED : FhsProto.FhsErrorCode.INTERNAL_ERROR,
      message: `${missionId}: ${message}`,
    }),
  } });
}

function toPrivacyScope(value: string): PrivacyScope | undefined {
  return value === "local" || value === "network" || value === "community" || value === "external"
    ? value
    : undefined;
}
