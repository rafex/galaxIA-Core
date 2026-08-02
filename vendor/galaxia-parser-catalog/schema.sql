-- Esquema de catalog.sqlite — artefacto de distribución compilado desde profiles/*.json.

CREATE TABLE IF NOT EXISTS parser_catalog (
  id TEXT PRIMARY KEY,
  model_pattern TEXT NOT NULL,
  strategy TEXT NOT NULL,
  rule TEXT NOT NULL,           -- JSON serializado, ver profiles/*.json
  notes TEXT,
  source_incident TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Trazabilidad de intentos de parseo, para eval de falsos positivos/negativos
-- con el tiempo. Nunca guarda el contenido crudo de una respuesta de modelo
-- (puede derivar de una pregunta de usuario) — solo un hash.
CREATE TABLE IF NOT EXISTS parse_attempts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  request_id TEXT,
  model_id TEXT NOT NULL,
  parser_id TEXT REFERENCES parser_catalog(id),
  matched INTEGER NOT NULL,    -- 0 | 1
  content_hash TEXT NOT NULL,
  at TEXT NOT NULL
);
