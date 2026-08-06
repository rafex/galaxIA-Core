import { describe, expect, it } from "vitest";
import { chunkText, scopeKey } from "../src/services/local-rag/chunking.js";

describe("local-rag chunking", () => {
  it("divide el OCR de forma determinista y conserva solapamiento", () => {
    const chunks = chunkText("uno dos tres cuatro cinco seis siete ocho nueve diez", 5, 2);

    expect(chunks).toEqual([
      "uno dos tres cuatro cinco",
      "cuatro cinco seis siete ocho",
      "siete ocho nueve diez",
    ]);
  });

  it("devuelve vacío para texto sin contenido indexable", () => {
    expect(chunkText("   \n\t ", 10, 2)).toEqual([]);
  });

  it("aísla documentos y conversaciones mediante una clave estable", () => {
    expect(scopeKey("conversation-a", "document-a")).not.toBe(scopeKey("conversation-a", "document-b"));
    expect(scopeKey("conversation-a")).toBe("conversation-a");
  });
});
