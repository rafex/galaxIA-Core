import { DatabaseSync } from "node:sqlite";
import type { ParserProfile } from "./types.js";

/** Carga todos los perfiles de un catalog.sqlite ya compilado — usado por un consumidor (ej. un Star). */
export function loadCatalog(dbPath: string): ParserProfile[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT id, model_pattern, strategy, rule, notes, source_incident FROM parser_catalog").all();
  db.close();

  return rows.map((row: any) => ({
    id: row.id,
    modelPattern: row.model_pattern,
    strategy: row.strategy,
    rule: JSON.parse(row.rule),
    notes: row.notes ?? undefined,
    sourceIncident: row.source_incident ?? undefined,
  }));
}
