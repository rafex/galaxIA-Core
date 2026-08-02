/**
 * Script para probar el endpoint de chat y recibir eventos SSE.
 * Uso: npx tsx scripts/test-chat.ts "Extrae el texto de esta imagen"
 */
const message = process.argv[2] || "Hola, ¿qué puedes hacer?";

async function main() {
  const response = await fetch("http://localhost:8081/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: { role: "user", content: message },
      preferences: { model: "auto", scope: "community" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat failed: ${response.status} ${response.statusText}`);
  }

  const { conversationId } = await response.json();
  console.log("Conversation:", conversationId);

  const eventSource = new EventSource(
    `http://localhost:8081/api/chat/${conversationId}/events`
  );

  eventSource.onmessage = (event) => {
    console.log("SSE:", event.data);
  };

  eventSource.onerror = (err) => {
    console.error("SSE error", err);
    eventSource.close();
  };

  setTimeout(() => eventSource.close(), 30000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
