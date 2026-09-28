/**
 * Prueba contra un Navigator real (TS o galaxIA-agent) con el mismo código de
 * sesión que el navegador: js-libp2p (WSS + Noise + yamux), handshake,
 * verificación de firmas re-codificando con protobuf-es y mapeo de eventos.
 * Se omite salvo que se defina FHS_E2E_NAVIGATOR.
 *
 *   FHS_E2E_NAVIGATOR   multiaddr del Navigator con /p2p/<id> (obligatoria)
 *   FHS_E2E_BOOTSTRAP   multiaddr de Atlas; activa la prueba del beacon DHT
 *   FHS_E2E_PDF         PDF pequeño con texto; activa las pruebas de adjunto
 *   FHS_E2E_NAVIGATOR_STATUS  URL de /status del Navigator; con FHS_E2E_PDF
 *                       activa la prueba de adjunto vía IPFS público (DEC-0095)
 *   FHS_E2E_IPFS_RETENTION  ephemeral (default) | reuse
 *   FHS_E2E_IPFS_EXPECT     release (default): el pin se libera tras la gracia
 *                       y el barrido; keep: sigue fijado a los 100 s (reuse,
 *                       o un reinicio del Navigator durante la gracia)
 *   NODE_EXTRA_CA_CERTS certificado del laboratorio
 *
 * Ejemplo (agente en sombra en Bastion, por túnel SSH):
 *   ssh -N -L 14011:127.0.0.1:4011 rafex@192.168.1.139 &
 *   FHS_E2E_NAVIGATOR=/ip4/127.0.0.1/tcp/14011/tls/ws/p2p/<id> \
 *   FHS_E2E_BOOTSTRAP=/ip4/192.168.1.139/tcp/4001/tls/ws/p2p/<atlas> \
 *   FHS_E2E_PDF=sample.pdf NODE_EXTRA_CA_CERTS=lab.crt \
 *   npx vitest run tests/e2e
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { base58btc } from "multiformats/bases/base58";
import { afterEach, describe, expect, it } from "vitest";
import { connectToChat, type ApiOptions, type ChatConnection } from "../../src/services/api.js";
import { diagnostics } from "../../src/services/diagnostics.js";
import { chunkText } from "../../src/services/local-rag/chunking.js";
import { createPortalP2pNode, discoverNavigator, readDhtBeacon } from "../../src/services/p2p-discovery.js";
import type { AgentEvent } from "../../src/types/fhs.js";

const NAVIGATOR = process.env.FHS_E2E_NAVIGATOR ?? "";
const BOOTSTRAP = process.env.FHS_E2E_BOOTSTRAP ?? "";
const PDF = process.env.FHS_E2E_PDF ?? "";
const NAVIGATOR_STATUS = process.env.FHS_E2E_NAVIGATOR_STATUS ?? "";
const IPFS_RETENTION = process.env.FHS_E2E_IPFS_RETENTION === "reuse" ? "reuse" : "ephemeral";
const IPFS_EXPECT = process.env.FHS_E2E_IPFS_EXPECT === "keep" ? "keep" : "release";
const TURN_TIMEOUT_MS = 240_000;
const KB_QUESTION = "¿Qué establece el artículo 3 de la Constitución sobre la educación?";

function navigatorDid(address: string): string {
  const peer = multiaddr(address).getComponents().find((c) => c.name === "p2p")?.value ?? "";
  const raw = peerIdFromString(peer).publicKey?.raw;
  if (!raw) throw new Error(`FHS_E2E_NAVIGATOR sin PeerId Ed25519: ${address}`);
  return `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...raw]))}`;
}

/** Sesión del Portal contra FHS_E2E_NAVIGATOR que acumula los eventos. */
class Session {
  readonly events: AgentEvent[] = [];
  readonly chat: ChatConnection;
  private readonly waiters = new Set<() => void>();

  constructor() {
    this.chat = connectToChat((event) => this.push(event), undefined, undefined, {
      bootstrapAddrs: [NAVIGATOR],
      discover: async (node) => ({
        connection: await node.dial(multiaddr(NAVIGATOR)),
        did: navigatorDid(NAVIGATOR),
        multiaddr: NAVIGATOR,
      }),
    });
  }

  send(options: ApiOptions): number {
    const from = this.events.length;
    this.chat.send(options);
    return from;
  }

  /** Primer evento de `type` desde `from`; falla si antes llega un `error`. */
  async next<T extends AgentEvent["type"]>(type: T, from: number): Promise<Extract<AgentEvent, { type: T }>> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      const seen = this.events.slice(from);
      const error = seen.find((e) => e.type === "error");
      if (error) throw new Error(`error del Navigator: ${JSON.stringify(error.data)}`);
      const hit = seen.find((e) => e.type === type);
      if (hit) return hit as Extract<AgentEvent, { type: T }>;
      if (Date.now() > deadline) throw new Error(`sin ${type}; recibido: ${seen.map((e) => e.type).join(", ")}`);
      await new Promise<void>((resolve) => {
        const wake = () => { this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake);
        setTimeout(wake, 1_000);
      });
    }
  }

  /** Contesta la recomendación de KB (si llega) y espera la respuesta. */
  async answer(from: number, useKb: boolean): Promise<{ text: string; completed: Extract<AgentEvent, { type: "assistant.completed" }> }> {
    const kb = await Promise.race([
      this.next("kb.recommended", from).then((e) => e, () => null),
      this.next("assistant.completed", from).then(() => null, () => null),
    ]);
    if (kb) this.chat.sendKbDecision(kb.data.conversationId, useKb);
    const completed = await this.next("assistant.completed", from);
    const text = this.events.slice(from)
      .flatMap((e) => (e.type === "assistant.delta" ? [e.data.text] : []))
      .join("");
    return { text, completed };
  }

  private push(event: AgentEvent): void {
    this.events.push(event);
    for (const wake of this.waiters) wake();
  }
}

function pdfArtifact(): Pick<ApiOptions, "artifacts" | "attachmentName"> {
  return {
    artifacts: [`data:application/pdf;base64,${readFileSync(PDF).toString("base64")}`],
    attachmentName: basename(PDF),
  };
}

type IpfsStatus = { pins: number; pendingUnpins: string[]; degraded: string | null; foreignPins: string[] };

async function ipfsStatus(): Promise<IpfsStatus> {
  const response = await fetch(NAVIGATOR_STATUS);
  const body = (await response.json()) as { ipfs: IpfsStatus | null };
  if (!body.ipfs) throw new Error("el Navigator no tiene IPFS configurado");
  return body.ipfs;
}

function signatureRejections(): string[] {
  return diagnostics.list().filter((e) => e.message.includes("firma inválida")).map((e) => e.message);
}

describe.skipIf(!NAVIGATOR)("Navigator real con la sesión del Portal", () => {
  let session: Session | undefined;
  afterEach(() => {
    session?.chat.close();
    session = undefined;
    expect(signatureRejections()).toEqual([]);
  });

  it.skipIf(!BOOTSTRAP)("publica un beacon DHT firmado que el Portal acepta", async () => {
    const node = await createPortalP2pNode(await generateKeyPair("Ed25519"));
    try {
      await node.dial(multiaddr(BOOTSTRAP));
      const record = await readDhtBeacon(node, navigatorDid(NAVIGATOR), diagnostics);
      expect(record, "readDhtBeacon descartó o no encontró el registro").not.toBeNull();
      expect(record?.beacon?.provider?.id).toBe("navigator");
      expect(record?.multiaddrs.length).toBeGreaterThan(0);
    } finally {
      await node.stop();
    }
  }, 30_000);

  it.skipIf(!BOOTSTRAP)("descubre al Navigator por GossipSub a través del bootstrap", async () => {
    // El mismo camino que el navegador: bootstrap → anuncio firmado reenviado
    // por Atlas → beacon DHT → dial al Navigator.
    const node = await createPortalP2pNode(await generateKeyPair("Ed25519"));
    try {
      const found = await discoverNavigator(node, [BOOTSTRAP], 45_000, diagnostics);
      expect(found.did).toBe(navigatorDid(NAVIGATOR));
    } finally {
      await node.stop();
    }
  }, 60_000);

  it("responde por streaming con la KB recomendada", async () => {
    session = new Session();
    const from = session.send({ message: KB_QUESTION, preferences: { scope: "community", ragSource: "network" } });
    const { text, completed } = await session.answer(from, true);
    const deltas = session.events.slice(from).filter((e) => e.type === "assistant.delta").length;
    expect(deltas, "llegó la respuesta en un solo delta").toBeGreaterThan(1);
    expect(text.length).toBeGreaterThan(20);
    expect(completed.data.provenance.llm.providerId).toMatch(/^did:key:/);
    expect(completed.data.provenance.tools.length).toBeGreaterThan(0);
  }, TURN_TIMEOUT_MS);

  it.skipIf(!PDF)("adjunto con RAG de red: OCR y respuesta sobre el documento", async () => {
    session = new Session();
    const from = session.send({
      message: "¿Qué dice el artículo 1 del documento?",
      ...pdfArtifact(),
      preferences: { scope: "community", ragSource: "network" },
    });
    const ocr = await session.next("ocr.extracted", from);
    expect(ocr.data.text.length).toBeGreaterThan(10);
    const { text, completed } = await session.answer(from, false);
    expect(text.length).toBeGreaterThan(0);
    expect(completed.data.provenance.tools.length).toBeGreaterThan(0);
  }, TURN_TIMEOUT_MS);

  it.skipIf(!PDF || !NAVIGATOR_STATUS)(`adjunto vía IPFS público (${IPFS_RETENTION}, ${IPFS_EXPECT}): OCR por Kubo y ciclo del pin`, async () => {
    const before = await ipfsStatus();
    expect(before.degraded).toBeNull();
    session = new Session();
    const from = session.send({
      message: "¿Qué dice el artículo 1 del documento?",
      ...pdfArtifact(),
      preferences: {
        scope: "community",
        ragSource: "local",
        ipfs: { enabled: true, network: "public", retention: IPFS_RETENTION },
      },
    });
    const ocr = await session.next("ocr.extracted", from);
    expect(ocr.data.text.length).toBeGreaterThan(10);

    // Gracia de 30 s tras un OCR exitoso: el CID sigue fijado.
    const pinned = await ipfsStatus();
    expect(pinned.pins).toBeGreaterThan(before.pins);

    if (IPFS_EXPECT === "keep") {
      await new Promise((resolve) => setTimeout(resolve, 100_000));
      const kept = await ipfsStatus();
      expect(kept.pins, "el pin debía seguir fijado").toBeGreaterThan(before.pins);
      return;
    }

    // Vence el lease y el siguiente barrido (cada minuto) lo despinea.
    const deadline = Date.now() + 30_000 + 60_000 + 30_000;
    let current = pinned;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      current = await ipfsStatus();
      if (current.pins === before.pins && current.pendingUnpins.length === 0) break;
    }
    expect(current.pins, "el pin no se liberó tras la gracia y el barrido").toBe(before.pins);
    expect(current.pendingUnpins).toEqual([]);
    expect(current.foreignPins).toEqual([]);
  }, TURN_TIMEOUT_MS);

  it.skipIf(!PDF)("adjunto con RAG local: OCR y pregunta con fragmentos del navegador", async () => {
    session = new Session();
    const question = "¿Qué dice el artículo 1 del documento?";
    const first = session.send({ message: question, ...pdfArtifact(), preferences: { scope: "community", ragSource: "local" } });
    const ocr = await session.next("ocr.extracted", first);

    // Lo que hace chat-view.ts: indexar en el navegador y reenviar la pregunta
    // con los fragmentos, sin el adjunto.
    const documentId = crypto.randomUUID();
    const from = session.send({
      message: question,
      documentContext: {
        filename: ocr.data.filename,
        documentId,
        source: "local",
        chunks: chunkText(ocr.data.text).map((text, chunkIndex) => ({
          chunkId: `${documentId}:${chunkIndex}`,
          filename: ocr.data.filename,
          chunkIndex,
          text,
          score: 1,
        })),
      },
      preferences: { scope: "community", ragSource: "local" },
    });
    const { text } = await session.answer(from, false);
    expect(text.length).toBeGreaterThan(0);
  }, TURN_TIMEOUT_MS);
});
