import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParserProfile } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profilesDir = join(root, "profiles");
const schemaPath = join(root, "schema.sql");
const dbPath = join(root, "catalog.sqlite");

function loadProfiles(): ParserProfile[] {
  return readdirSync(profilesDir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => JSON.parse(readFileSync(join(profilesDir, f), "utf-8")) as ParserProfile);
}

function main() {
  if (existsSync(dbPath)) unlinkSync(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(schemaPath, "utf-8"));

  const insert = db.prepare(
    `INSERT INTO parser_catalog (id, model_pattern, strategy, rule, notes, source_incident, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const profiles = loadProfiles();
  const now = new Date().toISOString();
  for (const profile of profiles) {
    insert.run(
      profile.id,
      profile.modelPattern,
      profile.strategy,
      JSON.stringify(profile.rule),
      profile.notes ?? null,
      profile.sourceIncident ?? null,
      now,
      now
    );
  }

  db.close();
  console.log(`catalog.sqlite compilado con ${profiles.length} perfil(es): ${profiles.map((p) => p.id).join(", ")}`);
}

main();
