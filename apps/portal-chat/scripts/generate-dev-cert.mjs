import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const certDir = resolve(root, "certs/portal-chat");
const keyPath = resolve(certDir, "portal.key");
const certPath = resolve(certDir, "portal.crt");

if (existsSync(keyPath) && existsSync(certPath) && !process.env.FORCE_TLS_CERT) {
  console.log(`Certificado HTTPS existente: ${certPath}`);
  process.exit(0);
}

mkdirSync(certDir, { recursive: true, mode: 0o700 });
execFileSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  keyPath,
  "-out",
  certPath,
  "-days",
  "365",
  "-subj",
  "/CN=localhost",
  "-addext",
  "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
], { stdio: "inherit" });
chmodSync(keyPath, 0o600);
console.log(`Certificado HTTPS autofirmado generado: ${certPath}`);
