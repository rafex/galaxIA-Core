/**
 * Adaptadores entre los modelos de aplicación del Navigator y el contrato
 * protobuf generado de FHS. Después de esta frontera, ningún mensaje FHS se
 * serializa como JSON: el stream, pubsub y DHT reciben bytes protobuf.
 */

import { create, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import {
  FhsProto,
  dhtBeaconSignaturePayload,
  envelopeSignaturePayload,
  encodeMessage,
  decodeMessage,
  missionAssignSignaturePayload,
  missionBidSignaturePayload,
  missionOfferSignaturePayload,
  nodeAdvertiseSignaturePayload,
  newEnvelope,
  type GenerateRequest,
  type LlmMessage,
  type ToolDefinition as AppToolDefinition,
  type ToolCall as AppToolCall,
  type ToolParameterSchema,
  verifySignature,
} from "@rafex/galaxia-fhs-protocol";

export function dynamicValueFromUnknown(value: unknown): FhsProto.DynamicValue {
  if (typeof value === "boolean") {
    return create(FhsProto.DynamicValueSchema, { kind: { case: "booleanValue", value } });
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? create(FhsProto.DynamicValueSchema, { kind: { case: "integerValue", value: BigInt(value) } })
      : create(FhsProto.DynamicValueSchema, { kind: { case: "numberValue", value } });
  }
  if (typeof value === "string") {
    return create(FhsProto.DynamicValueSchema, { kind: { case: "stringValue", value } });
  }
  if (value instanceof Uint8Array) {
    return create(FhsProto.DynamicValueSchema, { kind: { case: "bytesValue", value } });
  }
  if (Array.isArray(value)) {
    return create(FhsProto.DynamicValueSchema, {
      kind: {
        case: "listValue",
        value: create(FhsProto.DynamicListSchema, {
          values: value.map(dynamicValueFromUnknown),
        }),
      },
    });
  }
  if (value !== null && typeof value === "object") {
    const fields: Record<string, FhsProto.DynamicValue> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      fields[key] = dynamicValueFromUnknown(fieldValue);
    }
    return create(FhsProto.DynamicValueSchema, {
      kind: {
        case: "objectValue",
        value: create(FhsProto.DynamicObjectSchema, { fields }),
      },
    });
  }
  throw new TypeError("FHS protobuf no soporta valores null/undefined en DynamicValue");
}

export interface ProtoCodec<T> {
  encode(message: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

let signer: { did: string; privateKey: { sign(data: Uint8Array): Uint8Array } } | undefined;

export function configureSigner(did: string, privateKey: unknown): void {
  signer = { did, privateKey: privateKey as { sign(data: Uint8Array): Uint8Array } };
}

function envelopePayloadBytes(payload: FhsProto.Envelope["payload"]): Uint8Array {
  if (payload.case === undefined) return new Uint8Array();
  const schemas = {
    handshake: FhsProto.HandshakeMessageSchema,
    handshakeAck: FhsProto.HandshakeAckMessageSchema,
    ping: FhsProto.PingMessageSchema,
    pong: FhsProto.PongMessageSchema,
    error: FhsProto.ErrorMessageSchema,
    chatRequest: FhsProto.ChatRequestMessageSchema,
    chatCancel: FhsProto.ChatCancelMessageSchema,
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
  } as const;
  const schema = schemas[payload.case as keyof typeof schemas];
  return encodeMessage(schema, payload.value as never);
}

export function sealEnvelope(envelope: FhsProto.Envelope): FhsProto.Envelope {
  const payloadHex = Buffer.from(envelopePayloadBytes(envelope.payload)).toString("hex");
  const signature = sign(envelopeSignaturePayload(
    envelope.messageId,
    envelope.sourcePeerId,
    envelope.destPeerId,
    Number(envelope.timestamp),
    payloadHex
  ));
  return create(FhsProto.EnvelopeSchema, { ...envelope, signature });
}

export function verifyEnvelope(envelope: FhsProto.Envelope): boolean {
  if (envelope.signature.byteLength === 0 || !envelope.sourcePeerId) return false;
  const payloadHex = Buffer.from(envelopePayloadBytes(envelope.payload)).toString("hex");
  return verifySignature(
    envelope.sourcePeerId,
    envelopeSignaturePayload(envelope.messageId, envelope.sourcePeerId, envelope.destPeerId, Number(envelope.timestamp), payloadHex),
    Buffer.from(envelope.signature).toString("base64")
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sign(payload: string): Uint8Array {
  if (!signer) throw new Error("FHS wire signer no configurado");
  return signer.privateKey.sign(new TextEncoder().encode(payload));
}

function signedCodec<T extends { signature: Uint8Array }>(
  schema: DescMessage,
  payload: (message: T) => string,
  signerDid: (message: T) => string,
  required = true
): ProtoCodec<T> {
  return {
    encode: (message) => {
      const unsigned = { ...message, signature: new Uint8Array() } as T;
      const signature = signer ? sign(payload(unsigned)) : new Uint8Array();
      return encodeMessage(schema, { ...unsigned, signature } as never);
    },
    decode: (bytes) => {
      const message = decodeMessage(schema, bytes) as unknown as T;
      if (required && message.signature.byteLength === 0) throw new Error("Firma FHS ausente");
      if (required && !verifySignature(signerDid(message), payload(message), Buffer.from(message.signature).toString("base64"))) {
        throw new Error("Firma FHS inválida");
      }
      return message;
    },
  };
}

export function protobufMessageCodec<Desc extends DescMessage>(schema: Desc): ProtoCodec<MessageShape<Desc>> {
  return {
    encode: (message) => encodeMessage(schema, message),
    decode: (bytes) => decodeMessage(schema, bytes),
  };
}

const beaconHash = (beacon: FhsProto.Beacon | undefined): string =>
  sha256(encodeMessage(FhsProto.BeaconSchema, beacon ?? create(FhsProto.BeaconSchema)));

export const nodeAdvertiseCodec = signedCodec<FhsProto.NodeAdvertiseMessage>(
  FhsProto.NodeAdvertiseMessageSchema,
  (message) => nodeAdvertiseSignaturePayload(message.did, beaconHash(message.beacon), Number(message.timestamp), message.ttlSeconds),
  (message) => message.did
);
export const missionOfferCodec = signedCodec<FhsProto.MissionOfferMessage>(
  FhsProto.MissionOfferMessageSchema,
  (message) => missionOfferSignaturePayload(message.missionId, message.navigatorDid, message.missionType, Number(message.bidDeadlineMs), Number(message.timestamp)),
  (message) => message.navigatorDid
);
export const missionBidCodec = signedCodec<FhsProto.MissionBidMessage>(
  FhsProto.MissionBidMessageSchema,
  (message) => missionBidSignaturePayload(message.missionId, message.providerDid, message.offeredCapabilities, Number(message.timestamp)),
  (message) => message.providerDid
);
export const missionAssignCodec = signedCodec<FhsProto.MissionAssignMessage>(
  FhsProto.MissionAssignMessageSchema,
  (message) => missionAssignSignaturePayload(message.missionId, message.navigatorDid, message.assignedProvider, Number(message.timestamp)),
  (message) => message.navigatorDid
);
export const dhtBeaconCodec = signedCodec<FhsProto.DhtBeaconRecord>(
  FhsProto.DhtBeaconRecordSchema,
  (message) => dhtBeaconSignaturePayload(message.did, beaconHash(message.beacon), Number(message.publishedAt), Number(message.expiresAt)),
  (message) => message.did
);

export function dynamicValueToUnknown(value: FhsProto.DynamicValue | undefined): unknown {
  if (!value?.kind.case) return undefined;
  switch (value.kind.case) {
    case "booleanValue":
    case "numberValue":
    case "stringValue":
    case "bytesValue":
      return value.kind.value;
    case "integerValue":
      return Number(value.kind.value);
    case "listValue":
      return value.kind.value.values.map(dynamicValueToUnknown);
    case "objectValue":
      return Object.fromEntries(
        Object.entries(value.kind.value.fields).map(([key, field]) => [key, dynamicValueToUnknown(field)])
      );
  }
}

export function toolInputSchemaFromLegacy(
  schema: ToolParameterSchema | undefined
): FhsProto.ToolInputSchema | undefined {
  if (!schema) return undefined;
  const properties: Record<string, FhsProto.ToolInputSchema> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (property && typeof property === "object") {
      properties[name] = toolInputSchemaFromLegacy(property as ToolParameterSchema) ??
        create(FhsProto.ToolInputSchemaSchema, { type: "object" });
    }
  }
  return create(FhsProto.ToolInputSchemaSchema, {
    type: schema.type,
    properties,
    required: schema.required ?? [],
  });
}

function toolDefinitionFromLegacy(tool: AppToolDefinition): FhsProto.ToolDefinition {
  return create(FhsProto.ToolDefinitionSchema, {
    name: tool.function.name,
    description: tool.function.description ?? "",
    inputSchema: toolInputSchemaFromLegacy(tool.function.parameters),
  });
}

function toolCallFromLegacy(tool: AppToolCall): FhsProto.ToolCall {
  let args: unknown;
  try {
    // JSON solo cruza el límite del formato local que devuelve el modelo; se
    // convierte inmediatamente a DynamicValue antes de entrar al wire FHS.
    args = JSON.parse(tool.function.arguments);
  } catch {
    throw new TypeError(`Argumentos JSON inválidos para tool ${tool.function.name}`);
  }
  return create(FhsProto.ToolCallSchema, {
    id: tool.id,
    type: tool.type,
    function: create(FhsProto.ToolCallFunctionSchema, {
      name: tool.function.name,
      arguments: dynamicValueFromUnknown(args),
    }),
  });
}

export function toolCallToLegacy(tool: FhsProto.ToolCall): AppToolCall {
  const fn = tool.function;
  if (!fn) throw new TypeError("ToolCall protobuf sin función");
  return {
    id: tool.id,
    type: "function",
    function: {
      name: fn.name,
      // El modelo de aplicación conserva el formato esperado por el runtime;
      // el wire FHS ya fue decodificado de DynamicValue, no de JSON recibido.
      arguments: JSON.stringify(dynamicValueToUnknown(fn.arguments)),
    },
  };
}

function messageFromLegacy(message: LlmMessage): FhsProto.Message {
  return create(FhsProto.MessageSchema, {
    role: message.role,
    content: message.content ?? "",
    toolCallId: message.tool_call_id ?? "",
    toolCalls: (message.tool_calls ?? []).map(toolCallFromLegacy),
  });
}

export function makeNavigatorBeacon(): FhsProto.Beacon {
  return create(FhsProto.BeaconSchema, {
    fhsVersion: "0.1",
    provider: create(FhsProto.ProviderIdentitySchema, {
      id: "navigator",
      type: FhsProto.ProviderType.MULTI,
      visibility: FhsProto.Visibility.COMMUNITY,
      name: "Navigator FHS",
    }),
  });
}

export function makeHandshakeEnvelope(sourcePeerId: string, listenAddrs: string[]): FhsProto.Envelope {
  return newEnvelope({
    sourcePeerId,
    payload: {
      case: "handshake",
      value: create(FhsProto.HandshakeMessageSchema, {
        fhsVersion: "0.1",
        listenAddrs,
        beacon: makeNavigatorBeacon(),
      }),
    },
  });
}

export function makeChatRequestEnvelope(
  sourcePeerId: string,
  missionId: string,
  request: GenerateRequest
): FhsProto.Envelope {
  return newEnvelope({
    sourcePeerId,
    payload: {
      case: "chatRequest",
      value: create(FhsProto.ChatRequestMessageSchema, {
        missionId,
        messages: request.messages.map(messageFromLegacy),
        tools: (request.tools ?? []).map(toolDefinitionFromLegacy),
        model: request.model ?? "",
      }),
    },
  });
}

export function makeToolCallEnvelope(
  sourcePeerId: string,
  missionId: string,
  toolName: string,
  args: Record<string, unknown>
): FhsProto.Envelope {
  return newEnvelope({
    sourcePeerId,
    payload: {
      case: "toolCall",
      value: create(FhsProto.ToolCallRequestMessageSchema, {
        missionId,
        toolCalls: [
          create(FhsProto.ToolCallSchema, {
            id: missionId,
            type: "function",
            function: create(FhsProto.ToolCallFunctionSchema, {
              name: toolName,
              arguments: dynamicValueFromUnknown(args),
            }),
          }),
        ],
      }),
    },
  });
}
