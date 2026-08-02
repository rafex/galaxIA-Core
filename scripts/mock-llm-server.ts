/**
 * Mock LLM server para pruebas locales.
 * Responde a /v1/chat/completions con un mensaje de asistente simple.
 * Si detecta "ocr" o "imagen" en el mensaje del usuario, responde pidiendo la tool ocr_extract.
 *
 * Uso: npx tsx scripts/mock-llm-server.ts
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 43110);

const server = http.createServer((req, res) => {
  if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const data = JSON.parse(body) as {
        model?: string;
        messages?: Array<{ role: string; content?: string }>;
      };
      const messages = data.messages || [];
      const lastUser = messages.filter((m) => m.role === "user").pop();
      const text = lastUser?.content?.toLowerCase() || "";
      // Palabra completa, no substring — "ocr" como substring hacía falso
      // positivo con cualquier texto que contuviera "democrática" (contiene
      // "ocr"), encontrado probando kb-provider/rag-provider con contenido
      // real (SPEC-KB-0001/SPEC-RAG-0001).
      const useTool = /\b(ocr|imagen|foto)\b/.test(text);

      const response = {
        id: "mock-llm-1",
        object: "chat.completion",
        model: data.model || "qwen2.5-coder-3b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: useTool ? "" : "Soy un modelo mock. No tengo capacidad real de razonamiento en este modo.",
              tool_calls: useTool
                ? [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "ocr_extract",
                        arguments: JSON.stringify({ image_base64: "mock-image" }),
                      },
                    },
                  ]
                : undefined,
            },
            finish_reason: useTool ? "tool_calls" : "stop",
          },
        ],
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(400);
      res.end("Bad request");
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mock LLM server running at http://0.0.0.0:${PORT}`);
});
