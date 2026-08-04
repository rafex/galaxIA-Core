import {
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";

/** Codec del wire FHS. Nunca convierte mensajes a JSON. */
export interface FhsWireCodec<T> {
  encode(message: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

/** Crea un codec binario para un schema generado desde fhs-protocol.proto. */
export function protobufCodec<Desc extends DescMessage>(schema: Desc): FhsWireCodec<MessageShape<Desc>> {
  return {
    encode: (message) => toBinary(schema, message),
    decode: (bytes) => fromBinary(schema, bytes),
  };
}
