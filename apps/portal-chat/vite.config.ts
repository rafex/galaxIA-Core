import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const certDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../certs/portal-chat');
const keyPath = resolve(certDir, 'portal.key');
const certPath = resolve(certDir, 'portal.crt');
export default defineConfig(({ command }) => {
  const hasCertificate = existsSync(keyPath) && existsSync(certPath);
  if (command === 'serve' && !hasCertificate) {
    throw new Error('Portal Vite requiere HTTPS. Ejecuta "npm run generate:cert" antes de iniciar.');
  }
  const https = hasCertificate
    ? { key: readFileSync(keyPath), cert: readFileSync(certPath) }
    : undefined;

  return {
    server: {
      port: 3000,
      https,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    preview: {
      https,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    optimizeDeps: { exclude: ['sqlite-wasm-vec'] },
    build: { outDir: 'dist' },
  };
});
