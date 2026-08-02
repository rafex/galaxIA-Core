/**
 * Script para registrar proveedores mock en el Registry FHS.
 * Uso: npx tsx scripts/mock-providers.ts
 *
 * Cada mock genera una identidad Ed25519 efímera (did:key real) y firma
 * hello/register — el Atlas verifica firmas desde DEC-0030/DEC-0057, un mock
 * sin firma sería rechazado con INVALID_SIGNATURE.
 */
import WebSocket from "ws";
import {
  generateIdentity,
  signPayload,
  helloSignaturePayload,
  registerSignaturePayload,
  FHS_VERSION,
} from "@rafex/galaxia-fhs-protocol";

const REGISTRY_URL = "ws://localhost:8083/fhs/v1/ws";

function registerProvider(name: string, buildManifest: (providerId: string) => Record<string, unknown>) {
  const identity = generateIdentity();
  const providerId = identity.did;
  const manifest = buildManifest(providerId);
  const ws = new WebSocket(REGISTRY_URL);

  const sendRegister = () => {
    const timestamp = Date.now();
    ws.send(
      JSON.stringify({
        type: "register",
        providerId,
        manifest,
        timestamp,
        signature: signPayload(identity.privateKey, registerSignaturePayload(providerId, timestamp, manifest)),
      })
    );
  };

  ws.on("open", () => {
    const timestamp = Date.now();
    ws.send(
      JSON.stringify({
        type: "hello",
        providerId,
        timestamp,
        fhsVersion: FHS_VERSION,
        signature: signPayload(identity.privateKey, helloSignaturePayload(providerId, timestamp)),
      })
    );
  });

  ws.on("message", (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as { type?: string };
    console.log(`[${name}]`, msg.type, msg);

    if (msg.type === "welcome") {
      sendRegister();
    }
  });

  ws.on("error", (err) => {
    console.error(`[${name}] error`, err.message);
  });

  // Renovar registro periódicamente
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      sendRegister();
    }
  }, 25000);

  // Heartbeat
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 10000);
}

registerProvider("Mac mini de Raúl", (id) => ({
  fhsVersion: "0.1",
  provider: {
    id,
    name: "Mac mini de Raúl",
    type: "llm",
    visibility: "community",
  },
  endpoint: {
    protocol: "fhs",
    url: "ws://localhost:43111/fhs/v1/chat",
  },
  models: [
    {
      id: "qwen2.5-0.5b-instruct",
      displayName: "Qwen 2.5 0.5B Instruct",
      capabilities: ["chat"],
      contextWindow: 2048,
      toolCalling: { supported: false },
    },
  ],
  privacy: { retention: "none", trainingUse: false },
}));

registerProvider("OCR FHS Provider", (id) => ({
  fhsVersion: "0.1",
  provider: {
    id,
    name: "OCR FHS Provider",
    type: "mcp",
    visibility: "community",
  },
  endpoint: {
    protocol: "fhs",
    url: "ws://localhost:43112/fhs/v1/tools",
  },
  capabilities: [
    {
      id: "document.ocr",
      name: "Extracción de texto",
      inputMediaTypes: ["image/jpeg", "image/png", "application/pdf"],
      languages: ["es", "en"],
    },
  ],
  privacy: { retention: "none" },
}));

console.log("Mock providers registered. Press Ctrl+C to exit.");
