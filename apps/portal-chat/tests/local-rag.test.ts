import { describe, expect, it } from "vitest";
import { COMMON_RAG_SCOPE, RAG_SCOPE_SEPARATOR, chunkText, scopeKey } from "../src/services/local-rag/chunking.js";
import { rankCosineTopK } from "../src/services/local-rag/ranking.js";

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

  it("usa un ámbito común estable para compartir documentos entre conversaciones", () => {
    expect(scopeKey(COMMON_RAG_SCOPE, "document-a")).toBe(`browser-common${RAG_SCOPE_SEPARATOR}document-a`);
    expect(scopeKey(COMMON_RAG_SCOPE, "document-a")).toBe(scopeKey(COMMON_RAG_SCOPE, "document-a"));
  });
});

describe("local-rag ranking", () => {
  interface VectorRecord { id: string; vector: Float32Array }

  const rank = (records: VectorRecord[], query: Float32Array, topK: number) =>
    rankCosineTopK(records, query, (record) => record.vector, topK);

  it("devuelve una lista vacía para corpus vacío o top-K no positivo", () => {
    expect(rank([], new Float32Array([1]), 4)).toEqual([]);
    expect(rank([{ id: "a", vector: new Float32Array([1]) }], new Float32Array([1]), 0)).toEqual([]);
  });

  it("asigna score cero a vectores nulos y conserva empates en orden de entrada", () => {
    const records = [
      { id: "zero-a", vector: new Float32Array([0, 0]) },
      { id: "match-a", vector: new Float32Array([1, 0]) },
      { id: "match-duplicate", vector: new Float32Array([1, 0]) },
      { id: "zero-b", vector: new Float32Array([0, 0]) },
    ];

    expect(rank(records, new Float32Array([1, 0]), 4).map(({ record, score }) => [record.id, score])).toEqual([
      ["match-a", 1],
      ["match-duplicate", 1],
      ["zero-a", 0],
      ["zero-b", 0],
    ]);
  });

  it("devuelve solo top-K ordenado para una colección grande", () => {
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      id: `vector-${index}`,
      vector: new Float32Array([index + 1, 1]),
    }));
    const results = rank(records, new Float32Array([1, 0]), 4);

    expect(results).toHaveLength(4);
    expect(results.map(({ record }) => record.id)).toEqual(["vector-9999", "vector-9998", "vector-9997", "vector-9996"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });
});
