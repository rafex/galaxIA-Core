/**
 * Script para probar el chat por WebSocket.
 * Uso: npx tsx scripts/test-chat-ws.ts "Extrae el texto de esta imagen"
 */
import WebSocket from "ws";

const message = process.argv[2] || "Hola";
const WS_URL = "ws://127.0.0.1:8083/api/chat/ws";

const socket = new WebSocket(WS_URL);

socket.on("open", () => {
  console.log("WebSocket connected");
  socket.send(
    JSON.stringify({
      type: "start",
      message: { role: "user", content: message },
      preferences: { model: "auto", scope: "community" },
    })
  );
});

socket.on("message", (data: Buffer) => {
  const event = JSON.parse(data.toString()) as { type?: string; data?: unknown };
  console.log("EVENT:", event.type, JSON.stringify(event.data, null, 2));
});

socket.on("error", (err) => {
  console.error("WebSocket error:", err.message);
});

socket.on("close", () => {
  console.log("WebSocket closed");
});

setTimeout(() => socket.close(), 60000);
