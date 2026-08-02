/**
 * Historial de latencia/éxito por nodo + capability, y rating derivado
 * (SPEC-SATRATING-0001). Persistido en SQLite (WAL) para que sobreviva un
 * reinicio de Atlas — a diferencia del catálogo de nodos (MemoryAtlasStore),
 * que se reconstruye solo vía reconexión de providers y no debe persistir.
 * Ventana acotada por cantidad de muestras (no por tiempo) para simplicidad
 * de esta v1.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface LatencySample {
  /** null si el nodo nunca envió dispatch.ack (timeout/caída, o nodo viejo sin soporte) */
  dispatchMs: number | null;
  totalMs: number;
  success: boolean;
  at: number; // epoch ms
}

export interface NodeMetricsSummary {
  rating: number; // 0.0–5.0
  avgDispatchMs: number | null;
  avgTotalMs: number;
  successRate: number;
  sampleCount: number;
}

// Ventana de muestras por (providerId, capability). Fija por ahora — ajustable
// sin tocar el protocolo (es cálculo interno, no forma parte del mensaje FHS).
const WINDOW_SIZE = 50;

// Tope de latencia total para normalizar el score de velocidad, ver
// "Fórmula del rating" en spec-native/specs/satelite-rating/SPEC.md.
const P_MAX_MS = 60_000;

interface SampleRow {
  dispatch_ms: number | null;
  total_ms: number;
  success: number;
}

export class NodeMetricsStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    // WAL: lecturas (getSummary) no bloquean a la escritura (recordSample) y
    // viceversa — necesario porque ambas ocurren en el mismo proceso pero en
    // momentos distintos de cada turno de chat. NORMAL (no FULL) porque una
    // muestra de telemetría perdida en un crash es aceptable; no es dato
    // crítico como el manifiesto o la identidad del nodo.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        dispatch_ms INTEGER,
        total_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_samples_key_at
        ON samples (provider_id, capability, at);
    `);
  }

  recordSample(providerId: string, capability: string, sample: LatencySample) {
    this.db
      .prepare(
        `INSERT INTO samples (provider_id, capability, dispatch_ms, total_ms, success, at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(providerId, capability, sample.dispatchMs, sample.totalMs, sample.success ? 1 : 0, sample.at);

    // Mantener la ventana: borrar todo lo que no esté entre las WINDOW_SIZE
    // muestras más recientes de esta (providerId, capability).
    this.db
      .prepare(
        `DELETE FROM samples
         WHERE provider_id = ? AND capability = ?
           AND id NOT IN (
             SELECT id FROM samples
             WHERE provider_id = ? AND capability = ?
             ORDER BY at DESC
             LIMIT ?
           )`
      )
      .run(providerId, capability, providerId, capability, WINDOW_SIZE);
  }

  getSummary(providerId: string, capability: string): NodeMetricsSummary | null {
    const rows = this.db
      .prepare(
        `SELECT dispatch_ms, total_ms, success FROM samples
         WHERE provider_id = ? AND capability = ?
         ORDER BY at DESC
         LIMIT ?`
      )
      .all(providerId, capability, WINDOW_SIZE) as SampleRow[];

    if (rows.length === 0) return null;

    const successCount = rows.filter((r) => r.success === 1).length;
    const successRate = successCount / rows.length;

    const totalMsList = rows.map((r) => r.total_ms);
    const avgTotalMs = totalMsList.reduce((a, b) => a + b, 0) / totalMsList.length;

    const dispatchMsList = rows
      .map((r) => r.dispatch_ms)
      .filter((v): v is number => v !== null);
    const avgDispatchMs =
      dispatchMsList.length > 0
        ? dispatchMsList.reduce((a, b) => a + b, 0) / dispatchMsList.length
        : null;

    const latencyScore = clamp(1 - avgTotalMs / P_MAX_MS, 0, 1);
    const rating = Math.round((0.6 * successRate + 0.4 * latencyScore) * 5 * 10) / 10;

    return {
      rating,
      avgDispatchMs,
      avgTotalMs,
      successRate,
      sampleCount: rows.length,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
