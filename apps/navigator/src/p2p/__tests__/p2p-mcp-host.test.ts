import { describe, expect, it } from "vitest";
import { advertisedTools } from "../p2p-mcp-host.js";

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
