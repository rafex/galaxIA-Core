/**
 * Smoke E2E del stack FHS (SPEC-QUALITY-0001, DEC-0073) — automatiza el
 * patrón de verificación manual del proyecto: con Atlas y Navigator ya
 * corriendo, levanta un Star mock real (WebSocket propio, identidad Ed25519
 * efímera), lo registra con los payloads endurecidos de DEC-0069, y ejerce
 * un chat completo por la API pública del Navigator, verificando cada
 * garantía del protocolo en el camino:
 *
 *   1. `welcome` firmado por el Atlas (se verifica la firma contra su did).
 *   2. `register` firmado con hash canónico del manifiesto → `registered`.
 *   3. El catálogo REST del Atlas expone el nodo con `visibility`.
 *   4. `chat.request` entrante trae CallerAuth válido (did + firma del
 *      Navigator) — se verifica antes de responder.
 *   5. `dispatch.ack` + `chat.completed` → el evento SSE `assistant.completed`
 *      llega al cliente con la respuesta del mock.
 *
 * Uso (CI o local):
 *   ATLAS_URL / NAVIGATOR_URL opcionales (default localhost:8081 / :8090).
 *   npx tsx scripts/e2e-smoke.ts
 * Sale con código 0 si todo pasa; !=0 con el detalle de qué falló.
 */

import WebSocket, { WebSocketServer } from "ws";
import * as http from "node:http";
import {
  generateIdentity,
  signPayload,
  verifySignature,
  helloSignaturePayload,
  registerSignaturePayload,
  welcomeSignaturePayload,
  invokeSignaturePayload,
  FHS_VERSION,
} from "@rafex/galaxia-fhs-protocol";

const ATLAS_HTTP = process.env.ATLAS_URL || "http://localhost:8081";
const ATLAS_WS = ATLAS_HTTP.replace(/^http/, "ws") + "/fhs/v1/ws";
const NAVIGATOR_HTTP = process.env.NAVIGATOR_URL || "http://localhost:8090";
const STAR_PORT = Number(process.env.E2E_STAR_PORT || 43311);
const REPLY_TEXT = "e2e-smoke-ok::respuesta-del-star-mock";

function fail(step: string, detail: string): never {
  console.error(`❌ [${step}] ${detail}`);
  process.exit(1);
}

function ok(step: string, detail: string) {
  console.log(`✅ [${step}] ${detail}`);
}

interface RawMsg {
  type?: string;
  missionId?: string;
  registryId?: string;
  timestamp?: number;
  signature?: string;
  callerId?: string;
  data?: { code?: string; message?: string };
}

async function main() {
  const identity = generateIdentity();
  let callerAuthVerified = false;

  // ── Star mock: servidor WS que responde chat.request ────────────────────
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/fhs/v1/chat" });
  wss.on("connection", (socket) => {
    socket.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as RawMsg & { request?: { messages?: Array<{ content?: string }> } };
      if (msg.type !== "chat.request" || !msg.missionId) return;

      // Garantía 4: el Navigator firma sus invocaciones (DEC-0069).
      if (!msg.callerId || !msg.timestamp || !msg.signature) {
        fail("caller-auth", `chat.request sin CallerAuth: ${JSON.stringify({ callerId: msg.callerId, timestamp: msg.timestamp })}`);
      }
      const payload = invokeSignaturePayload(msg.callerId, msg.missionId, msg.timestamp);
      if (!verifySignature(msg.callerId, payload, msg.signature)) {
        fail("caller-auth", "firma de CallerAuth inválida en chat.request");
      }
      callerAuthVerified = true;
      ok("caller-auth", `chat.request firmado por ${msg.callerId.slice(0, 24)}…`);

      socket.send(JSON.stringify({ type: "dispatch.ack", missionId: msg.missionId, queuedAt: Date.now() }));
      socket.send(
        JSON.stringify({
          type: "chat.completed",
          missionId: msg.missionId,
          response: {
            message: { role: "assistant", content: REPLY_TEXT },
            model: "e2e-mock-model",
            toolCalls: [],
          },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(STAR_PORT, resolve));
  ok("star", `Star mock escuchando en :${STAR_PORT}`);

  // ── Registro contra Atlas (payloads DEC-0069) ────────────────────────────
  const manifest = {
    fhsVersion: FHS_VERSION,
    provider: { id: identity.did, name: "E2E Star Mock", type: "llm", visibility: "community" },
    endpoint: { protocol: "fhs", url: `ws://localhost:${STAR_PORT}/fhs/v1/chat` },
    models: [
      {
        id: "e2e-mock-model",
        displayName: "E2E Mock",
        capabilities: ["chat"],
        contextWindow: 4096,
        toolCalling: { supported: false },
      },
    ],
    privacy: { retention: "none", trainingUse: false },
  };

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(ATLAS_WS);
    const timer = setTimeout(() => reject(new Error("Timeout registrando en Atlas")), 15000);
    ws.on("open", () => {
      const ts = Date.now();
      ws.send(
        JSON.stringify({
          type: "hello",
          providerId: identity.did,
          timestamp: ts,
          fhsVersion: FHS_VERSION,
          signature: signPayload(identity.privateKey, helloSignaturePayload(identity.did, ts)),
        })
      );
    });
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as RawMsg;
      if (msg.type === "welcome") {
        // Garantía 1: welcome firmado por el did del Atlas.
        if (!msg.registryId?.startsWith("did:key:z") || !msg.timestamp || !msg.signature) {
          fail("welcome", `welcome sin identidad/firma: ${JSON.stringify(msg)}`);
        }
        if (!verifySignature(msg.registryId, welcomeSignaturePayload(msg.registryId, msg.timestamp), msg.signature)) {
          fail("welcome", "firma del welcome inválida — ¿Atlas impostor?");
        }
        ok("welcome", `welcome firmado por Atlas ${msg.registryId.slice(0, 24)}…`);
        const ts = Date.now();
        ws.send(
          JSON.stringify({
            type: "register",
            providerId: identity.did,
            manifest,
            timestamp: ts,
            signature: signPayload(identity.privateKey, registerSignaturePayload(identity.did, ts, manifest)),
          })
        );
      } else if (msg.type === "registered") {
        clearTimeout(timer);
        ok("register", "registered recibido (firma con hash de manifiesto aceptada)");
        resolve();
      } else if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(`Atlas respondió error: ${msg.data?.code} ${msg.data?.message}`));
      }
    });
    ws.on("error", reject);
    // mantener el lease vivo durante el test
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 5000).unref();
  }).catch((err: Error) => fail("register", err.message));

  // Garantía 3: catálogo REST con visibility propagada.
  const providers = (await (await fetch(`${ATLAS_HTTP}/api/fhs/providers`)).json()) as Array<{
    providerId: string;
    service: { visibility?: string };
  }>;
  const mine = providers.find((p) => p.providerId === identity.did);
  if (!mine) fail("catalog", "el Star mock no aparece en /api/fhs/providers");
  if (mine.service.visibility !== "community") {
    fail("catalog", `visibility no propagada (esperaba "community", llegó ${JSON.stringify(mine.service.visibility)})`);
  }
  ok("catalog", "catálogo REST expone el nodo con visibility=community");

  // ── Chat E2E por la API pública del Navigator ────────────────────────────
  const conversationId = `e2e-${Date.now()}`;
  const completed = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout esperando assistant.completed por SSE")), 60000);
    void (async () => {
      const res = await fetch(`${NAVIGATOR_HTTP}/api/chat/${conversationId}/events`);
      if (!res.ok || !res.body) throw new Error(`SSE no disponible: ${res.status}`);
      // Node's fetch Response.body (undici) es async-iterable de Buffer/Uint8Array
      // — evita el reader tipado `any` sin lib DOM (este script corre bajo
      // scripts/tsconfig.json, sin "dom" en lib).
      const decoder = new TextDecoder();
      let buffer = "";
      let lastEvent = "";
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) lastEvent = line.slice(7).trim();
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6)) as { conversationId?: string; message?: string; error?: string };
            if (data.conversationId !== conversationId) continue;
            if (lastEvent === "assistant.completed" || lastEvent === "assistant.delta") {
              clearTimeout(timer);
              resolve(lastEvent);
              return;
            }
            if (lastEvent === "error") {
              clearTimeout(timer);
              reject(new Error(`evento error del runtime: ${JSON.stringify(data)}`));
              return;
            }
          }
        }
      }
    })().catch(reject);
  });

  // darle un instante a la suscripción SSE antes de disparar el chat
  await new Promise((r) => setTimeout(r, 500));
  const chatRes = await fetch(`${NAVIGATOR_HTTP}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      message: { role: "user", content: "hola desde el smoke e2e" },
      preferences: { scope: "community" },
    }),
  });
  if (chatRes.status !== 202) fail("chat", `POST /api/chat respondió ${chatRes.status}`);
  ok("chat", "POST /api/chat aceptado (202)");

  const finalEvent = await completed.catch((err: Error) => fail("chat", err.message));
  if (!callerAuthVerified) fail("caller-auth", "el Star mock nunca recibió un chat.request firmado");
  ok("chat", `conversación completada (${finalEvent}) — respuesta generada por el Star mock`);

  console.log("\n🎉 Smoke E2E completo: registro firmado + welcome verificado + visibility + CallerAuth + chat de punta a punta.");
  process.exit(0);
}

main().catch((err: Error) => fail("main", err.stack || err.message));
