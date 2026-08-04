#!/usr/bin/env node
// Servidor estático de portal-chat. Las sesiones FHS se conectan directamente
// al peer libp2p del Navigator desde el navegador; este proceso no proxifica
// HTTP, WebSocket ni SSE de aplicación.

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const DIST_DIR = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: true });

  await app.register(fastifyStatic, {
    root: DIST_DIR,
    index: ["index.html"],
  });

  // Equivalente a `try_files $uri $uri/ /index.html` de nginx.conf.template
  // — cualquier ruta no servida como archivo estático ni proxeada es una
  // ruta de la SPA (client-side routing), se resuelve con index.html.
  app.setNotFoundHandler((_req, reply) => {
    reply.type("text/html").sendFile("index.html");
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`portal-chat sirviendo estáticos en http://${HOST}:${PORT}; sesiones FHS vía libp2p`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
