import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from "./types.js";

/**
 * Chunking determinista y agnóstico al idioma. El texto OCR ya normalizado se
 * corta por palabras para no partir UTF-16 en mitad de un carácter.
 */
export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_CHUNK_OVERLAP,
): string[] {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  if (chunkSize <= 0 || overlap < 0 || overlap >= chunkSize) {
    throw new RangeError("chunkSize debe ser positivo y overlap menor que chunkSize");
  }

  const chunks: string[] = [];
  const step = chunkSize - overlap;
  for (let start = 0; start < words.length; start += step) {
    const chunk = words.slice(start, start + chunkSize).join(" ");
    if (chunk) chunks.push(chunk);
    if (start + chunkSize >= words.length) break;
  }
  return chunks;
}

export function scopeKey(conversationId: string, documentId?: string): string {
  return documentId ? `${conversationId}\u0000${documentId}` : conversationId;
}
