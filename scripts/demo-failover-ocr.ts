/**
 * Demo de Failover OCR FHS — TASK-FHS-0010
 *
 * Escenario:
 *   1. Levanta un LLM mock + dos proveedores OCR mock (Alpha y Beta)
 *   2. Todos se registran en Atlas
 *   3. Primera consulta → Alpha maneja OCR, LLM responde
 *   4. Alpha entra en modo error
 *   5. Segunda consulta → failover automático a Beta + evento provider.failover
 *
 * Uso:
 *   npx tsx --esModuleInterop scripts/demo-failover-ocr.ts [--verbose]
 *
 * Requisitos previos:
 *   - `just dev-atlas` corriendo en :8081
 *   - `just dev-agent` corriendo en :8083 (Navigator)
 *
 * Opciones:
 *   --verbose  Muestra todos los eventos del WebSocket
 */

import WebSocket from "ws";
import { WebSocketServer } from "ws";
import * as http from "node:http";
import {
  generateIdentity,
  signPayload,
  helloSignaturePayload,
  registerSignaturePayload,
  type NodeIdentity,
} from "@rafex/galaxia-fhs-protocol";
import type { AgentEvent } from "../apps/navigator/src/agent/events.js";

/** Envoltorio mínimo de mensajes crudos del protocolo FHS (Atlas/tool WS) — este script mockea el wire format directamente, sin pasar por los tipos completos del SDK. */
interface RawFhsMessage {
  type?: string;
  missionId?: string;
  toolName?: string;
  data?: { conversationId?: string };
}

// ─── Configuración ────────────────────────────────────────────────
const ATLAS_URL = "ws://localhost:8081/fhs/v1/ws";
const ATLAS_HTTP = "http://localhost:8081";
const CHAT_URL = "ws://localhost:8083/api/chat/ws";
const STEP_PAUSE_MS = 1200;

const PROVIDER_A = {
  name: "OCR Alpha",
  port: 14312,
  text: "[ALPHA] Texto extraído correctamente del documento.",
};

const PROVIDER_B = {
  name: "OCR Beta",
  port: 14313,
  text: "[BETA] Texto extraído correctamente del documento.",
};

const LLM_MOCK = {
  name: "LLM Demo Mock",
  port: 14311,
};

// PDF mínimo válido en base64 (un documento de prueba de una página)
const MOCK_FILE_DATAURL =
  "data:application/pdf;base64," +
  Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF")
    .toString("base64");

// ─── Logger ────────────────────────────────────────────────────────
const VERBOSE = process.argv.includes("--verbose");

function log(emoji: string, label: string, ...args: unknown[]) {
  console.log(`${emoji}  [${label}]`, ...args);
}

function vlog(label: string, ...args: unknown[]) {
  if (VERBOSE) console.log(`   [${label}]`, ...args);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Proveedor OCR Mock ───────────────────────────────────────────
class MockOcrProvider {
  private toolServer: http.Server | null = null;
  private atlasWs: WebSocket | null = null;
  private mode: "normal" | "error" | "dead" = "normal";
  private identity: NodeIdentity;

  constructor(
    private cfg: { name: string; port: number; text: string }
  ) {
    this.identity = generateIdentity();
  }

  get id() {
    return this.identity.did;
  }

  async start(): Promise<void> {
    log("\u{1F680}", "MOCK", `Iniciando ${this.cfg.name} en puerto ${this.cfg.port}...`);
    log("\u{1F511}", "MOCK", `  did: ${this.id}`);
    await this.startToolServer();
    await this.registerInAtlas();
  }

  private async startToolServer(): Promise<void> {
    return new Promise((resolve) => {
      this.toolServer = http.createServer();
      const wss = new WebSocketServer({ server: this.toolServer });

      wss.on("connection", (ws: WebSocket) => {
        vlog(`TOOL:${this.cfg.name}`, "Nueva conexión FHS entrante");

        ws.on("message", (raw: Buffer) => {
          let msg: RawFhsMessage;
          try {
            msg = JSON.parse(raw.toString()) as RawFhsMessage;
          } catch {
            return;
          }
          vlog(`TOOL:${this.cfg.name}`, `← ${msg.type}`);

          switch (msg.type) {
            case "tool.list": {
              ws.send(
                JSON.stringify({
                  type: "tool.list.response",
                  missionId: msg.missionId,
                  tools: [
                    {
                      name: "ocr_extract",
                      description: `Extrae texto de imágenes y PDFs (${this.cfg.name})`,
                      inputSchema: {
                        type: "object",
                        properties: {
                          file: { type: "object" },
                        },
                      },
                    },
                  ],
                })
              );
              break;
            }

            case "tool.call": {
              ws.send(
                JSON.stringify({
                  type: "dispatch.ack",
                  missionId: msg.missionId,
                })
              );

              if (this.mode === "error") {
                vlog(
                  `TOOL:${this.cfg.name}`,
                  "→ tool.error (modo error activado)"
                );
                ws.send(
                  JSON.stringify({
                    type: "tool.error",
                    missionId: msg.missionId,
                    toolName: msg.toolName || "ocr_extract",
                    code: "PROVIDER_ERROR",
                    message: `${this.cfg.name}: proveedor no disponible (simulado)`,
                  })
                );
              } else if (this.mode === "dead") {
                ws.close();
              } else {
                setTimeout(() => {
                  ws.send(
                    JSON.stringify({
                      type: "tool.result",
                      missionId: msg.missionId,
                      toolName: msg.toolName || "ocr_extract",
                      content: [{ type: "text", text: this.cfg.text }],
                    })
                  );
                }, 200);
              }
              break;
            }
          }
        });

        ws.on("close", () => {
          vlog(`TOOL:${this.cfg.name}`, "Conexión cerrada");
        });
      });

      this.toolServer.listen(this.cfg.port, () => resolve());
    });
  }

  private async registerInAtlas(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ATLAS_URL);
      this.atlasWs = ws;

      ws.on("open", () => {
        const helloTs = Date.now();
        const helloPayload = helloSignaturePayload(this.id, helloTs);
        ws.send(
          JSON.stringify({
            type: "hello",
            providerId: this.id,
            timestamp: helloTs,
            signature: signPayload(this.identity.privateKey, helloPayload),
          })
        );
      });

      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as RawFhsMessage;
        vlog(`ATLAS:${this.cfg.name}`, `← ${msg.type}${msg.data ? " " + JSON.stringify(msg.data) : ""}`);

        if (msg.type === "welcome") {
          const registerTs = Date.now();
          // La firma de register ancla el hash canónico del manifiesto
          // (revisión del protocolo 2026-07-10) — el manifiesto se construye
          // primero para poder firmarlo.
          const manifest = {
                fhsVersion: "0.1",
                provider: {
                  id: this.id,
                  name: this.cfg.name,
                  type: "mcp",
                  visibility: "community",
                },
                endpoint: {
                  protocol: "fhs",
                  url: `ws://localhost:${this.cfg.port}/fhs/v1/tools`,
                },
                capabilities: [
                  {
                    id: "document.ocr",
                    name: "Extracción de texto",
                    inputMediaTypes: [
                      "image/jpeg",
                      "image/png",
                      "application/pdf",
                    ],
                    languages: ["es", "en"],
                  },
                ],
                privacy: {
                  retention: "session",
                },
          };
          ws.send(
            JSON.stringify({
              type: "register",
              providerId: this.id,
              signature: signPayload(this.identity.privateKey, registerSignaturePayload(this.id, registerTs, manifest)),
              manifest,
              timestamp: registerTs,
            })
          );
        }

        if (msg.type === "registered") {
          resolve();
        }
      });

      ws.on("error", reject);

      setTimeout(() => reject(new Error("Timeout registrando en Atlas")), 10000);
    });
  }

  setMode(mode: "normal" | "error" | "dead") {
    this.mode = mode;
  }

  stop() {
    this.atlasWs?.close();
    this.toolServer?.close();
  }
}

// ─── Proveedor LLM Mock FHS ────────────────────────────────────────
class MockLlmProvider {
  private server: http.Server | null = null;
  private atlasWs: WebSocket | null = null;
  private identity: NodeIdentity;

  constructor(
    private cfg: { name: string; port: number }
  ) {
    this.identity = generateIdentity();
  }

  get id() {
    return this.identity.did;
  }

  async start(): Promise<void> {
    log("\u{1F680}", "MOCK", `Iniciando ${this.cfg.name} en puerto ${this.cfg.port}...`);
    log("\u{1F511}", "MOCK", `  did: ${this.id}`);
    await this.startChatServer();
    await this.registerInAtlas();
  }

  private async startChatServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer();
      const wss = new WebSocketServer({ server: this.server });

      wss.on("connection", (ws: WebSocket) => {
        vlog(`LLM:${this.cfg.name}`, "Nueva conexión FHS entrante");

        ws.on("message", (raw: Buffer) => {
          let msg: RawFhsMessage;
          try {
            msg = JSON.parse(raw.toString()) as RawFhsMessage;
          } catch {
            return;
          }
          vlog(`LLM:${this.cfg.name}`, `← ${msg.type}`);

          if (msg.type === "chat.request") {
            const responseText =
              `[LLM Mock] He procesado tu documento. ` +
              `El texto extraído indica que es un documento de prueba. ` +
              `Toda la información ha sido procesada correctamente.`;

            ws.send(
              JSON.stringify({
                type: "chat.delta",
                missionId: msg.missionId,
                delta: responseText,
              })
            );

            setTimeout(() => {
              ws.send(
                JSON.stringify({
                  type: "chat.completed",
                  missionId: msg.missionId,
                  response: {
                    message: {
                      role: "assistant",
                      content: responseText,
                    },
                    toolCalls: [],
                  },
                })
              );
            }, 100);
          }
        });
      });

      this.server.listen(this.cfg.port, () => resolve());
    });
  }

  private async registerInAtlas(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ATLAS_URL);
      this.atlasWs = ws;

      ws.on("open", () => {
        const helloTs = Date.now();
        const helloPayload = helloSignaturePayload(this.id, helloTs);
        ws.send(
          JSON.stringify({
            type: "hello",
            providerId: this.id,
            timestamp: helloTs,
            signature: signPayload(this.identity.privateKey, helloPayload),
          })
        );
      });

      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as RawFhsMessage;
        vlog(`ATLAS:${this.cfg.name}`, `← ${msg.type}${msg.data ? " " + JSON.stringify(msg.data) : ""}`);

        if (msg.type === "welcome") {
          const registerTs = Date.now();
          const manifest = {
                fhsVersion: "0.1",
                provider: {
                  id: this.id,
                  name: this.cfg.name,
                  type: "llm",
                  visibility: "community",
                },
                endpoint: {
                  protocol: "fhs",
                  url: `ws://localhost:${this.cfg.port}/fhs/v1/chat`,
                },
                models: [
                  {
                    id: "mock-model-1",
                    displayName: "Mock LLM (Demo)",
                    capabilities: ["chat", "tool.calling"],
                    contextWindow: 4096,
                    toolCalling: { supported: true },
                  },
                ],
                privacy: {
                  retention: "session",
                  trainingUse: false,
                },
          };
          ws.send(
            JSON.stringify({
              type: "register",
              providerId: this.id,
              signature: signPayload(this.identity.privateKey, registerSignaturePayload(this.id, registerTs, manifest)),
              manifest,
              timestamp: registerTs,
            })
          );
        }

        if (msg.type === "registered") {
          resolve();
        }
      });

      ws.on("error", reject);
      setTimeout(() => reject(new Error("Timeout registrando LLM en Atlas")), 10000);
    });
  }

  stop() {
    this.atlasWs?.close();
    this.server?.close();
  }
}

// ─── Cliente de chat ──────────────────────────────────────────────
interface ChatResult {
  providerName: string;
  events: AgentEvent[];
}

function sendChat(fileDataUrl: string, marker: string): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = [];
    let providerName = "desconocido";
    let completed = false;

    const ws = new WebSocket(CHAT_URL);

    const timeout = setTimeout(() => {
      if (!completed) {
        ws.close();
        reject(new Error(`Timeout en chat ${marker}`));
      }
    }, 30000);

    ws.on("open", () => {
      vlog(`CHAT:${marker}`, "Conectado");
      ws.send(
        JSON.stringify({
          type: "start",
          message: { role: "user", content: `Extrae el texto de este documento (${marker})` },
          artifacts: [fileDataUrl],
          attachmentName: `demo-${marker}.pdf`,
          preferences: { model: "auto", scope: "community" },
        })
      );
    });

    ws.on("message", (data: Buffer) => {
      const event = JSON.parse(data.toString()) as AgentEvent;
      events.push(event);

      switch (event.type) {
        case "session":
          break;

        case "ocr.extracted":
          vlog(`CHAT:${marker}`, `OCR extraído — uso automático en el contexto de la pregunta`);
          break;

        case "tool.selected":
          providerName = event.data.providerName;
          log("\u{1F4CC}", `CHAT:${marker}`, `Tool seleccionada: ${providerName}`);
          break;

        case "tool.completed":
          log("\u2705", `CHAT:${marker}`, `Tool completada: ${event.data.name} (${event.data.duration}ms)`);
          break;

        case "tool.error":
          log("\u274C", `CHAT:${marker}`, `Tool error: ${event.data.error}`);
          break;

        case "provider.failover":
          log(
            "\u{1F504}",
            `CHAT:${marker}`,
            `FAILOVER: ${event.data.failedProviderName} → ${event.data.nextProviderName}`
          );
          break;

        case "assistant.completed":
          completed = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ providerName, events });
          break;

        case "error":
          log("\u26A0\uFE0F", `CHAT:${marker}`, `Error: ${event.data.message}`);
          if (!completed) {
            completed = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ providerName, events });
          }
          break;
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─── Main ──────────────────────────────────────────────────────────
async function verifyRegistry(_expectedCount: number) {
  try {
    const res = await fetch(`${ATLAS_HTTP}/api/fhs/providers?type=mcp`);
    const providers = (await res.json()) as Array<{
      service?: { capabilities?: Array<{ id: string }> };
    }>;
    const ocrProviders = providers.filter((p) =>
      p.service?.capabilities?.some((c) => c.id === "document.ocr")
    );
    log("\u{1F50D}", "ATLAS", `${ocrProviders.length} proveedor(es) OCR en el catálogo`);
    return ocrProviders;
  } catch {
    return [];
  }
}

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  \u{1F3AC}  DEMO: FAILOVER OCR FHS");
  console.log("═".repeat(60) + "\n");

  // ── Paso 0: verificar precondiciones ──────────────────────────
  log("\u{1F4CB}", "SETUP", "Verificando Atlas y Navigator...");
  try {
    await fetch(`${ATLAS_HTTP}/health`);
    log("\u2705", "SETUP", "Atlas responde OK");
  } catch {
    console.error("\u274C Atlas no responde en", ATLAS_HTTP, "— ¿ejecutaste `just dev-atlas`?");
    process.exit(1);
  }

  try {
    await fetch("http://localhost:8083/health");
    log("\u2705", "SETUP", "Navigator responde OK");
  } catch {
    console.error("\u274C Navigator no responde en :8083 — ¿ejecutaste `just dev-agent`?");
    process.exit(1);
  }

  // ── Paso 1: levantar proveedores ──────────────────────────────
  log("\u{1F4E6}", "PASO 1/6", "Iniciando LLM mock + dos proveedores OCR mock...");
  const llm = new MockLlmProvider(LLM_MOCK);
  const alpha = new MockOcrProvider(PROVIDER_A);
  const beta = new MockOcrProvider(PROVIDER_B);

  await Promise.all([llm.start(), alpha.start(), beta.start()]);
  await sleep(STEP_PAUSE_MS);

  // ── Paso 2: verificar registro ───────────────────────────────
  log("\u{1F4CB}", "PASO 2/6", "Verificando registro en Atlas...");
  const registrados = await verifyRegistry(2);
  if (registrados.length < 2) {
    log("\u26A0\uFE0F", "ATLAS", `Solo ${registrados.length} provider(s) OCR — esperando 2.`);
  }
  try {
    const llmRes = await fetch(`${ATLAS_HTTP}/api/fhs/providers?type=llm`);
    const llmProviders = (await llmRes.json()) as unknown[];
    log("\u{1F50D}", "ATLAS", `${llmProviders.length} proveedor(es) LLM en el catálogo`);
  } catch {
    log("\u26A0\uFE0F", "ATLAS", "No se pudo verificar proveedores LLM");
  }

  // ── Paso 3: primera consulta (ambos OK) ───────────────────────
  log("\u{1F4AC}", "PASO 3/6", "Primera consulta con adjunto (ambos providers activos)...");
  await sleep(STEP_PAUSE_MS);

  console.log("\n" + "─".repeat(40));
  const result1 = await sendChat(MOCK_FILE_DATAURL, "ronda1");
  console.log("─".repeat(40) + "\n");

  log(
    "\u{1F4E4}",
    "RESULTADO 1",
    `Provider usado: ${result1.providerName}`
  );

  // ── Paso 4: activar modo error en Alpha ──────────────────────
  log("\u{1F4A5}", "PASO 4/6", `Activando modo ERROR en ${PROVIDER_A.name}...`);
  alpha.setMode("error");
  await sleep(STEP_PAUSE_MS);

  // ── Paso 5: segunda consulta (failover) ──────────────────────
  log("\u{1F503}", "PASO 5/6", "Segunda consulta — Alpha debería fallar y hacer failover a Beta...");
  await sleep(STEP_PAUSE_MS);

  console.log("\n" + "─".repeat(40));
  const result2 = await sendChat(MOCK_FILE_DATAURL, "ronda2");
  console.log("─".repeat(40) + "\n");

  const failoverEvent = result2.events.find((e) => e.type === "provider.failover");
  log(
    "\u{1F4E4}",
    "RESULTADO 2",
    `Provider usado: ${result2.providerName}`
  );

  if (failoverEvent) {
    log(
      "\u{1F389}",
      "FAILOVER",
      `¡Failover detectado! ${failoverEvent.data.failedProviderName} → ${failoverEvent.data.nextProviderName}`
    );
  }

  // ── Paso 6: apagar Alpha completamente ───────────────────────
  log("\u{1F4A5}", "PASO 6/6", `Apagando ${PROVIDER_A.name} completamente...`);
  alpha.stop();
  // Simular que Atlas marca Alpha como lost (el script no espera el lease expiry)
  await sleep(STEP_PAUSE_MS);

  // ── Cleanup ──────────────────────────────────────────────────
  log("\u{1F9F9}", "CLEANUP", "Apagando proveedores mock...");
  llm.stop();
  beta.stop();

  // ── Resumen ──────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("  \u{1F4CA}  RESUMEN DE LA DEMO");
  console.log("═".repeat(60));
  console.log(`  Consulta 1 → ${result1.providerName.padEnd(14)} (Alpha activo)`);
  console.log(`  Consulta 2 → ${result2.providerName.padEnd(14)} (Alpha en error → failover a Beta)`);
  console.log(`  Evento failover: ${failoverEvent ? "\u2705 Recibido" : "\u274C No recibido"}`);
  console.log("═".repeat(60) + "\n");
}

main().catch((err: unknown) => {
  console.error("\n\u274C Error en la demo:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
