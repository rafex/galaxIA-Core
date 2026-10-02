import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";
import { describe, expect, it } from "vitest";
import {
  decisionsFor,
  destinationLabel,
  isFinal,
  itemLabel,
  outcomeLabel,
  riskNotes,
  shortDid,
  toggleItem,
  trustLabel,
  type AuthItemView,
} from "../src/services/authorization.js";

const item = (over: Partial<AuthItemView> = {}): AuthItemView => ({
  itemId: "a",
  capabilityId: "document.ocr",
  providerDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  providerName: "OCR",
  trustLevel: "community",
  policyVersion: "auth-1",
  dataClass: FhsProto.AuthorizationDataClass.DOCUMENT,
  dataSummary: "factura.pdf · 240 KB",
  destination: FhsProto.AuthorizationDestination.NETWORK,
  retention: FhsProto.AuthorizationRetention.EPHEMERAL,
  dependsOn: [],
  firstTimeNode: false,
  publicNetwork: false,
  failover: false,
  sideEffects: false,
  retry: false,
  implicit: false,
  ...over,
});

describe("tarjeta de autorización", () => {
  const items = [
    item({ itemId: "subir", capabilityId: "ipfs.upload" }),
    item({ itemId: "ocr", dependsOn: ["subir"] }),
    item({ itemId: "kb", capabilityId: "knowledge.query" }),
  ];

  it("marcar un ítem marca de qué depende", () => {
    const next = toggleItem(items, new Set(), "ocr", true);
    expect([...next].sort()).toEqual(["ocr", "subir"]);
  });

  it("desmarcar un ítem desmarca lo que depende de él", () => {
    const all = new Set(["subir", "ocr", "kb"]);
    const next = toggleItem(items, all, "subir", false);
    expect([...next]).toEqual(["kb"]);
  });

  it("las decisiones cubren todos los ítems y solo permiten los marcados", () => {
    const decisions = decisionsFor(items, new Set(["kb"]));
    expect(decisions).toEqual([
      { itemId: "subir", allow: false },
      { itemId: "ocr", allow: false },
      { itemId: "kb", allow: true },
    ]);
    expect(decisionsFor(items, new Set()).every((d) => !d.allow)).toBe(true);
  });

  it("describe cada envío con palabras de persona", () => {
    expect(itemLabel(item())).toContain("OCR");
    expect(itemLabel(item({ capabilityId: "chat", dataClass: FhsProto.AuthorizationDataClass.DERIVED_TEXT }))).toContain("fragmentos");
    expect(itemLabel(item({ capabilityId: "chat", dataClass: FhsProto.AuthorizationDataClass.TOOL_OUTPUT_TO_LLM }))).toContain("herramienta");
    expect(itemLabel(item({ capabilityId: "algo.raro" }))).toBe("algo.raro");
    expect(destinationLabel(FhsProto.AuthorizationDestination.PUBLIC_IPFS)).toBe("IPFS público");
    expect(trustLabel("operator")).toBe("verificado por el operador");
    expect(trustLabel("community")).toBe("comunidad, sin verificar");
    expect(shortDid("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK")).toBe("did:key:z6MkhaXg…ta2doK");
    expect(shortDid("did:key:z6Mk")).toBe("did:key:z6Mk");
  });

  it("avisa de los riesgos que la persona debe ver", () => {
    const notes = riskNotes(item({ publicNetwork: true, firstTimeNode: true, failover: true, retry: true, sideEffects: true }));
    expect(notes).toHaveLength(5);
    expect(notes[0]).toContain("no se puede garantizar el borrado");
    expect(riskNotes(item())).toEqual([]);
  });

  it("distingue lo pendiente de lo resuelto", () => {
    expect(isFinal(FhsProto.AuthorizationOutcome.PENDING)).toBe(false);
    expect(isFinal(FhsProto.AuthorizationOutcome.ALLOWED)).toBe(true);
    expect(isFinal(FhsProto.AuthorizationOutcome.EXPIRED)).toBe(true);
    expect(outcomeLabel(FhsProto.AuthorizationOutcome.EXPIRED)).toContain("no se envió nada");
  });
});
