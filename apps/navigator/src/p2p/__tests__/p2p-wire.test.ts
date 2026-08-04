import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "@rafex/galaxia-fhs-protocol";
import { dynamicValueFromUnknown, dynamicValueToUnknown, makeToolCallEnvelope } from "../p2p-wire.js";

describe("FHS protobuf wire adapters", () => {
  it("conserva valores dinámicos sin JSON en los argumentos de una tool", () => {
    const args = {
      text: "hola",
      count: 3,
      enabled: true,
      nested: { tags: ["a", "b"] },
    };
    const envelope = makeToolCallEnvelope("did:key:navigator", "mission-1", "demo.tool", args);
    const decoded = decodeEnvelope(encodeEnvelope(envelope));

    expect(decoded.payload.case).toBe("toolCall");
    if (decoded.payload.case !== "toolCall") return;
    expect(dynamicValueToUnknown(decoded.payload.value.toolCalls[0]?.function?.arguments)).toEqual(args);
  });

  it("rechaza null porque DynamicValue no tiene una variante nula en el contrato", () => {
    expect(() => dynamicValueFromUnknown(null)).toThrow(TypeError);
  });
});
