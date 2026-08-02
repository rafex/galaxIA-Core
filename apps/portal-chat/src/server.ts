#!/usr/bin/env node
// Servidor estático+proxy de portal-chat para la ruta de distribución npm
// (`npx @rafex/galaxia-portal-chat`) — reemplaza el rol de
// containers/portal-chat/nginx.conf.template para quien no usa contenedores.
// Mismo mapeo de rutas: /api/fhs + /fhs/v1/ws -> Atlas, resto de /api ->
// Navigator (DEC-0035), configurable por ATLAS_URL/NAVIGATOR_URL para que
// cada servicio pueda vivir en una máquina distinta (DEC-0060).

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyHttpProxy from "@fastify/http-proxy";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ATLAS_URL = process.env.ATLAS_URL || "http://localhost:8081";
const NAVIGATOR_URL = process.env.NAVIGATOR_URL || "http://localhost:8090";

const DIST_DIR = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: true });

  // Rutas más específicas primero — @fastify/http-proxy registra cada
  // prefijo como su propia ruta, Fastify resuelve por especificidad, no
  // por orden de registro, pero mantenerlas agrupadas ayuda a la lectura.
  await app.register(fastifyHttpProxy, {
    upstream: ATLAS_URL,
    prefix: "/api/fhs",
    rewritePrefix: "/api/fhs",
  });
  await app.register(fastifyHttpProxy, {
    upstream: ATLAS_URL,
    prefix: "/fhs/v1/ws",
    rewritePrefix: "/fhs/v1/ws",
    websocket: true,
  });
  await app.register(fastifyHttpProxy, {
    upstream: NAVIGATOR_URL,
    prefix: "/api/chat/ws",
    rewritePrefix: "/api/chat/ws",
    websocket: true,
  });
  await app.register(fastifyHttpProxy, {
    upstream: NAVIGATOR_URL,
    prefix: "/api",
    rewritePrefix: "/api",
  });

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
    app.log.info(`portal-chat sirviendo en http://${HOST}:${PORT} (Atlas: ${ATLAS_URL}, Navigator: ${NAVIGATOR_URL})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
