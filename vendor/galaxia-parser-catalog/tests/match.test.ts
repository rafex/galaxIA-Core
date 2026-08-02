import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../src/load.js";
import { matchProfile, tryParse } from "../src/match.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadCatalog(join(root, "catalog.sqlite"));

// Caso real: qwen2.5-coder-3b-instruct decide invocar ocr_extract pero el
// motor de inferencia escribe el JSON como texto plano en content (DEC-0016).
const fixture = readFileSync(
  join(root, "tests/fixtures/qwen2.5-coder-3b/plain-json-tool-call.txt"),
  "utf-8"
);
const requestedTools = [{ function: { name: "ocr_extract" } }];

const profile = matchProfile("qwen2.5-coder-3b-instruct", catalog);
assert.ok(profile, "debe encontrar un perfil para qwen2.5-coder-3b-instruct");
assert.equal(profile!.id, "jinja-plain-json-toolcall-fallback-v1");

const parsed = tryParse(fixture, requestedTools, profile!);
assert.ok(parsed, "debe parsear la tool call desde el JSON plano");
assert.equal(parsed!.function.name, "ocr_extract");
assert.deepEqual(JSON.parse(parsed!.function.arguments), {
  imageUrl: "https://example.com/scan.png",
});

// Falso positivo evitado: nombre de tool no ofrecida en la petición.
const untrusted = matchProfile("qwen2.5-coder-3b-instruct", catalog);
const rejected = tryParse(
  '{"name": "delete_all_files", "arguments": {}}',
  requestedTools,
  untrusted!
);
assert.equal(rejected, null, "no debe aceptar una tool no ofrecida en la petición");

// Modelo no catalogado: no debe encontrar perfil.
const noMatch = matchProfile("llama-3-70b-instruct", catalog);
assert.equal(noMatch, null, "no debe encontrar perfil para un modelo no catalogado");

console.log("OK: tests de galaxia-parser-catalog pasaron");
