/**
 * Adaptadores entre los modelos de aplicación del Navigator y el contrato
 * protobuf generado de FHS. Después de esta frontera, ningún mensaje FHS se
 * serializa como JSON: el stream, pubsub y DHT reciben bytes protobuf.
 */

import { create, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import {
  FhsProto,
  encodeMessage,
  decodeMessage,
  newEnvelope,
  type GenerateRequest,
  type LlmMessage,
  type ToolDefinition as AppToolDefinition,
  type ToolCall as AppToolCall,
  type ToolParameterSchema,
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

export function protobufMessageCodec<Desc extends DescMessage>(schema: Desc): ProtoCodec<MessageShape<Desc>> {
  return {
    encode: (message) => encodeMessage(schema, message),
    decode: (bytes) => decodeMessage(schema, bytes),
  };
}

export const nodeAdvertiseCodec = protobufMessageCodec(FhsProto.NodeAdvertiseMessageSchema);
export const missionOfferCodec = protobufMessageCodec(FhsProto.MissionOfferMessageSchema);
export const missionBidCodec = protobufMessageCodec(FhsProto.MissionBidMessageSchema);
export const missionAssignCodec = protobufMessageCodec(FhsProto.MissionAssignMessageSchema);
export const dhtBeaconCodec = protobufMessageCodec(FhsProto.DhtBeaconRecordSchema);

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
