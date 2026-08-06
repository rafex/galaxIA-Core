import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import sqlite3InitModule from "sqlite-wasm-vec";
import { chunkText, RAG_SCOPE_SEPARATOR, scopeKey } from "./chunking.js";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TOP_K,
  type LocalRagChunk,
  type LocalRagDocument,
  type LocalRagIndexResult,
  type LocalRagQuery,
  type LocalRagRequest,
  type LocalRagResponse,
} from "./types.js";

interface SqliteStatement {
  bind(indexOrValues: number | unknown[] | Record<string, unknown>, value?: unknown): SqliteStatement;
  stepReset(): SqliteStatement;
  finalize(): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  selectArrays(sql: string, bind?: unknown): unknown[][];
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface IndexedChunk {
  id: string;
  scopeKey: string;
  conversationId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  embedding: ArrayBuffer;
  embeddingModel: string;
  embeddingDimensions: number;
  createdAt: number;
}

type EmbeddingPipeline = FeatureExtractionPipeline;

let db: SqliteDatabase | undefined;
let sqliteBackend: LocalRagIndexResult["backend"] = "indexeddb";
let extractor: EmbeddingPipeline | undefined;
let nextVectorId = 1;
let sqliteAttempted = false;
let sqliteReady: Promise<void> | undefined;

interface WorkerHost {
  addEventListener(type: "message", listener: (event: MessageEvent<LocalRagRequest>) => void): void;
  postMessage(response: LocalRagResponse): void;
}

const workerScope = globalThis as unknown as WorkerHost;
let requestQueue: Promise<void> = Promise.resolve();

workerScope.addEventListener("message", (event: MessageEvent<LocalRagRequest>) => {
  requestQueue = requestQueue.then(() => handleRequest(event.data)).catch(() => undefined);
});

async function handleRequest(request: LocalRagRequest): Promise<void> {
  try {
    if (request.type === "index") {
      const value = await indexDocument(request.document);
      post({ type: "result", requestId: request.requestId, value });
    } else if (request.type === "query") {
      const value = await queryDocument(request.query);
      post({ type: "result", requestId: request.requestId, value });
    } else if (request.type === "clear") {
      const value = await clearIndex();
      post({ type: "result", requestId: request.requestId, value });
    } else {
      const value = await deleteConversation(request.conversationId);
      post({ type: "result", requestId: request.requestId, value });
    }
  } catch (error) {
    post({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
  }
}

async function indexDocument(document: LocalRagDocument): Promise<LocalRagIndexResult> {
  const chunks = chunkText(document.text, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP);
  if (chunks.length === 0) throw new Error("El documento no contiene texto indexable");
  post({ type: "status", status: { phase: "loading-embedding-model", detail: DEFAULT_EMBEDDING_MODEL } });
  const vectors = await embed(chunks);
  post({ type: "status", status: { phase: "indexing", detail: `${chunks.length} fragmentos` } });
  const key = scopeKey(document.ragScope, document.documentId);
  await ensureSqlite();
  if (db) {
    await indexSqlite(document, key, chunks, vectors);
    return { documentId: document.documentId, chunksIndexed: chunks.length, embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS, backend: sqliteBackend };
  }
  await indexIndexedDb(document, key, chunks, vectors);
  return { documentId: document.documentId, chunksIndexed: chunks.length, embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS, backend: "indexeddb" };
}

async function queryDocument(request: LocalRagQuery): Promise<LocalRagChunk[]> {
  post({ type: "status", status: { phase: "loading-embedding-model", detail: DEFAULT_EMBEDDING_MODEL } });
  const [queryVector] = await embed([request.query]);
  post({ type: "status", status: { phase: "querying", detail: `top-${request.topK ?? DEFAULT_TOP_K}` } });
  const key = scopeKey(request.ragScope, request.documentId);
  await ensureSqlite();
  if (db) return querySqlite(request, key, queryVector);
  return queryIndexedDb(request, key, queryVector);
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  extractor ??= await pipeline("feature-extraction", DEFAULT_EMBEDDING_MODEL, { dtype: "q8" });
  const result = await extractor(texts, { pooling: "mean", normalize: true });
  const data: unknown = result.data as unknown;
  const dimensions = DEFAULT_EMBEDDING_DIMENSIONS;
  const values = data instanceof Float32Array ? data : Float32Array.from(data as Iterable<number>);
  if (values.length !== texts.length * dimensions) {
    throw new Error(`Dimensión de embedding inesperada: ${values.length / texts.length}; se esperaba ${dimensions}`);
  }
  return texts.map((_text, index) => values.slice(index * dimensions, (index + 1) * dimensions));
}

function ensureSqlite(): Promise<void> {
  sqliteReady ??= initializeSqlite();
  return sqliteReady;
}

async function initializeSqlite(): Promise<void> {
  if (db || sqliteAttempted) return;
  sqliteAttempted = true;
  try {
    const sqlite = await sqlite3InitModule();
    if (!sqlite.oo1.OpfsDb) {
      db = undefined;
      sqliteBackend = "indexeddb";
      return;
    }
    db = new sqlite.oo1.OpfsDb("/galaxia-rag.sqlite3", "c");
    sqliteBackend = "sqlite-vec-opfs";
    db.exec(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_dimensions INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        vector_id INTEGER NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS rag_chunks_scope ON rag_chunks(scope_key);
      CREATE VIRTUAL TABLE IF NOT EXISTS rag_embeddings USING vec0(
        embedding float[384] distance_metric=cosine,
        scope_key TEXT partition key
      );
    `);
    const maxId = db.selectArrays("SELECT COALESCE(MAX(vector_id), 0) FROM rag_chunks")[0]?.[0];
    nextVectorId = typeof maxId === "number" ? maxId + 1 : 1;
  } catch (error) {
    db = undefined;
    sqliteBackend = "indexeddb";
    post({ type: "status", status: { phase: "fallback", detail: error instanceof Error ? error.message : "OPFS no disponible" } });
  }
}

async function indexSqlite(document: LocalRagDocument, key: string, chunks: string[], vectors: Float32Array[]): Promise<void> {
  if (!db) return indexIndexedDb(document, key, chunks, vectors);
  const deleteChunks = db.prepare("DELETE FROM rag_chunks WHERE scope_key = ?");
  const deleteVectors = db.prepare("DELETE FROM rag_embeddings WHERE scope_key = ?");
  try {
    deleteVectors.bind([key]).stepReset();
    deleteChunks.bind([key]).stepReset();
  } finally {
    deleteVectors.finalize();
    deleteChunks.finalize();
  }
  const chunkStmt = db.prepare("INSERT INTO rag_chunks (id, scope_key, conversation_id, document_id, filename, chunk_index, text, embedding_model, embedding_dimensions, created_at, vector_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const vectorStmt = db.prepare("INSERT INTO rag_embeddings (rowid, embedding, scope_key) VALUES (?, ?, ?)");
  try {
    for (const [index, text] of chunks.entries()) {
      const vectorId = nextVectorId++;
      const id = `${document.documentId}:${index}`;
      chunkStmt.bind([id, key, document.conversationId, document.documentId, document.filename, index, text, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS, Date.now(), vectorId]).stepReset();
      vectorStmt.bind([vectorId, toArrayBuffer(vectors[index] ?? new Float32Array()), key]).stepReset();
    }
  } finally {
    chunkStmt.finalize();
    vectorStmt.finalize();
  }
}

function querySqlite(request: LocalRagQuery, key: string, queryVector: Float32Array): LocalRagChunk[] {
  if (!db) return [];
  const scopes = request.documentId
    ? [key]
    : db.selectArrays("SELECT DISTINCT scope_key FROM rag_chunks")
      .flatMap((row) => typeof row[0] === "string" ? [row[0]] : []);
  const chunks = scopes.flatMap((scope) => {
    const rows = db?.selectArrays("SELECT rowid, distance FROM rag_embeddings WHERE embedding MATCH ? AND scope_key = ? ORDER BY distance LIMIT ?", [toArrayBuffer(queryVector), scope, request.topK ?? DEFAULT_TOP_K]) ?? [];
    return rows.flatMap((row) => {
      const vectorId = row[0];
      if (typeof vectorId !== "number") return [];
      const chunk = db?.selectArrays("SELECT id, scope_key, conversation_id, document_id, filename, chunk_index, text, embedding_model, embedding_dimensions FROM rag_chunks WHERE vector_id = ?", [vectorId])[0];
      if (!chunk || (request.documentId && String(chunk[3]) !== request.documentId) || (!request.documentId && !String(chunk[1]).startsWith(`${request.ragScope}${RAG_SCOPE_SEPARATOR}`))) return [];
      return [{ id: String(chunk[0]), conversationId: String(chunk[2]), documentId: String(chunk[3]), filename: String(chunk[4]), chunkIndex: Number(chunk[5]), text: String(chunk[6]), score: 1 - Number(row[1]), embeddingModel: String(chunk[7]), embeddingDimensions: Number(chunk[8]) }];
    });
  });
  return chunks.sort((left, right) => right.score - left.score).slice(0, request.topK ?? DEFAULT_TOP_K);
}

async function indexIndexedDb(document: LocalRagDocument, key: string, chunks: string[], vectors: Float32Array[]): Promise<void> {
  const database = await openIndexedDb();
  await deleteIndexedDbScope(database, key);
  await transaction(database, "readwrite", (store) => {
    for (const [index, text] of chunks.entries()) {
      const vector = vectors[index] ?? new Float32Array();
      const record: IndexedChunk = { id: `${document.documentId}:${index}`, scopeKey: key, conversationId: document.conversationId, documentId: document.documentId, filename: document.filename, chunkIndex: index, text, embedding: toArrayBuffer(vector), embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS, createdAt: Date.now() };
      store.put(record);
    }
  });
}

async function queryIndexedDb(request: LocalRagQuery, key: string, queryVector: Float32Array): Promise<LocalRagChunk[]> {
  const database = await openIndexedDb();
  const records = request.documentId
    ? await readIndexedDbScope(database, key)
    : await readIndexedDbRagScope(database, request.ragScope);
  return records.map((record) => ({ record, score: cosine(queryVector, new Float32Array(record.embedding)) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, request.topK ?? DEFAULT_TOP_K)
    .map(({ record, score }) => ({ id: record.id, conversationId: record.conversationId, documentId: record.documentId, filename: record.filename, chunkIndex: record.chunkIndex, text: record.text, score, embeddingModel: record.embeddingModel, embeddingDimensions: record.embeddingDimensions }));
}

async function deleteConversation(conversationId: string): Promise<LocalRagIndexResult> {
  await ensureSqlite();
  if (db) {
    const scopeRows = db.selectArrays("SELECT DISTINCT scope_key FROM rag_chunks WHERE conversation_id = ?", [conversationId]);
    const statement = db.prepare("DELETE FROM rag_chunks WHERE conversation_id = ?");
    try { statement.bind([conversationId]).stepReset(); } finally { statement.finalize(); }
    const vectors = db.prepare("DELETE FROM rag_embeddings WHERE scope_key = ?");
    try {
      for (const row of scopeRows) {
        if (typeof row[0] !== "string") continue;
        vectors.bind([row[0]]).stepReset();
      }
    } finally { vectors.finalize(); }
    return { documentId: "", chunksIndexed: 0, embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS, backend: sqliteBackend };
  }
  const database = await openIndexedDb();
  const records = await readIndexedDbConversation(database, conversationId);
  await transaction(database, "readwrite", (store) => { for (const record of records) store.delete(record.id); });
  return { documentId: "", chunksIndexed: 0, embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS, backend: sqliteBackend };
}

async function clearIndex(): Promise<LocalRagIndexResult> {
  await ensureSqlite();
  if (db) {
    db.exec("DELETE FROM rag_embeddings; DELETE FROM rag_chunks;");
    nextVectorId = 1;
    return { documentId: "", chunksIndexed: 0, embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS, backend: sqliteBackend };
  }
  const database = await openIndexedDb();
  const records = await readIndexedDb(database, () => true);
  await transaction(database, "readwrite", (store) => { for (const record of records) store.delete(record.id); });
  return { documentId: "", chunksIndexed: 0, embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS, backend: sqliteBackend };
}

function toArrayBuffer(vector: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(vector.byteLength);
  new Float32Array(buffer).set(vector);
  return buffer;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
    leftNorm += (left[index] ?? 0) ** 2;
    rightNorm += (right[index] ?? 0) ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function post(response: LocalRagResponse): void {
  workerScope.postMessage(response);
}

interface IndexedDbDatabase {
  transaction(storeNames: string | string[], mode: IDBTransactionMode): IDBTransaction;
}

async function openIndexedDb(): Promise<IndexedDbDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB no está disponible en este navegador");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("galaxia-local-rag", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("chunks", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir IndexedDB"));
  });
}

function transaction(database: IndexedDbDatabase, mode: IDBTransactionMode, callback: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("chunks", mode);
    callback(tx.objectStore("chunks"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Transacción IndexedDB fallida"));
  });
}

async function readIndexedDbScope(database: IndexedDbDatabase, key: string): Promise<IndexedChunk[]> {
  return readIndexedDb(database, (record) => record.scopeKey === key);
}

async function readIndexedDbConversation(database: IndexedDbDatabase, conversationId: string): Promise<IndexedChunk[]> {
  return readIndexedDb(database, (record) => record.conversationId === conversationId);
}

async function readIndexedDbRagScope(database: IndexedDbDatabase, ragScope: string): Promise<IndexedChunk[]> {
  return readIndexedDb(database, (record) => record.scopeKey.startsWith(`${ragScope}${RAG_SCOPE_SEPARATOR}`));
}

function readIndexedDb(database: IndexedDbDatabase, matches: (record: IndexedChunk) => boolean): Promise<IndexedChunk[]> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("chunks", "readonly");
    const request = tx.objectStore("chunks").getAll();
    request.onsuccess = () => resolve((request.result as IndexedChunk[]).filter(matches));
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer IndexedDB"));
  });
}

function deleteIndexedDbScope(database: IndexedDbDatabase, key: string): Promise<void> {
  return readIndexedDbScope(database, key).then((records) => transaction(database, "readwrite", (store) => { for (const record of records) store.delete(record.id); }));
}
