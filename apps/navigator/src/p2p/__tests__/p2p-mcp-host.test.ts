import { describe, expect, it } from "vitest";
import { advertisedTools, missionCapability } from "../p2p-mcp-host.js";

describe("advertisedTools", () => {
  it("usa el nombre de herramienta anunciado por el beacon", () => {
    expect(advertisedTools(["tool:extract_text"], ["document.ocr"])).toEqual([
      { name: "extract_text", capabilityId: "document.ocr" },
    ]);
  });

  it("mantiene fallback a la capability cuando el provider no publica tags de tools", () => {
    expect(advertisedTools([], ["document.ocr"])).toEqual([
      { name: "document.ocr", capabilityId: "document.ocr" },
    ]);
  });

  it("descarta tags que no se pueden asociar a una capability anunciada", () => {
    expect(advertisedTools(["tool:unknown_tool"], ["document.ocr", "knowledge.query"])).toEqual([]);
  });
});

describe("missionCapability", () => {
  it("usa la capability del beacon cuando el runtime la conoce", () => {
    expect(missionCapability("kb_query", { capabilityId: "knowledge.query" })).toBe("knowledge.query");
  });

  it("sin contexto, deduce la capability de los nombres reales de las tools", () => {
    expect(missionCapability("kb_query")).toBe("knowledge.query");
    expect(missionCapability("document_index")).toBe("document.index");
    expect(missionCapability("document_query")).toBe("document.query");
    expect(missionCapability("extract_text")).toBe("document.ocr");
  });
});
