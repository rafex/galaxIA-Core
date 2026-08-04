#!/usr/bin/env node
// Servidor HTTPS estático de portal-chat. Las sesiones FHS se conectan
// directamente al peer libp2p del Navigator desde el navegador; este proceso
// no proxifica HTTP, WebSocket ni SSE de aplicación.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = resolve(DIST_DIR, "../../../certs/portal-chat");
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || resolve(CERT_DIR, "portal.crt");
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || resolve(CERT_DIR, "portal.key");

async function main() {
  let certificate: Buffer;
  let privateKey: Buffer;
  try {
    certificate = readFileSync(TLS_CERT_PATH);
    privateKey = readFileSync(TLS_KEY_PATH);
  } catch (error) {
    throw new Error(
      `Portal requiere HTTPS. No se pudieron leer TLS_CERT_PATH=${TLS_CERT_PATH} ` +
        `y TLS_KEY_PATH=${TLS_KEY_PATH}. Ejecuta "npm run generate:cert -w apps/portal-chat" antes de iniciar.`,
      { cause: error },
    );
  }

  const app = Fastify({ https: { cert: certificate, key: privateKey }, logger: true });

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
    app.log.info(`portal-chat sirviendo estáticos en https://${HOST}:${PORT}; sesiones FHS vía libp2p`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
