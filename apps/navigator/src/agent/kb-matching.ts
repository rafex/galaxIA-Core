// SPEC-KB-0001/0002: matching determinístico de texto para el modo
// "recomendado". Decide qué KB *recomendar*, nunca cuál invocar: eso lo
// confirma el usuario (`kb.recommended`).
//
// Antes se usaba Jaccard sobre tokens crudos (con acentos, sin quitar
// palabras vacías, singular ≠ plural). Dos problemas vistos en el
// laboratorio: "¿Qué dice el artículo 3 sobre la educación?" daba 0 contra
// "Constitución Política de los Estados Unidos Mexicanos", y cualquier
// descripción más rica bajaba el puntaje, porque Jaccard divide entre la
// unión y castiga las descripciones largas. Ahora se mide qué fracción de la
// pregunta aparece en la descripción.

/**
 * Capacidad de una base de conocimiento. SPEC-KB-0001 la llama `kb.query`;
 * los providers P2P (kb-provider de galaxIA-satellite-star, p2p-mcp-host)
 * anuncian `knowledge.query`. Se aceptan las dos: buscar solo `kb.query`
 * dejaba vacía la lista de KBs y nunca se recomendaba ninguna.
 */
export const KB_CAPABILITY_IDS: ReadonlySet<string> = new Set(["knowledge.query", "kb.query"]);

/** Fracción mínima de palabras de la pregunta que deben aparecer en la KB. */
export const KB_MATCH_THRESHOLD = 0.2;

/** Palabras vacías (español e inglés) y verbos de petición que no dicen nada del tema. */
const STOPWORDS = new Set([
  // artículos, preposiciones, conjunciones, pronombres
  "el", "la", "los", "las", "un", "una", "unos", "unas", "lo", "al", "del",
  "de", "en", "con", "por", "para", "sin", "sobre", "entre", "hacia", "hasta", "desde", "segun",
  "y", "e", "o", "u", "ni", "que", "pero", "si", "no", "se", "su", "sus", "mi", "mis", "tu", "tus",
  "me", "te", "le", "les", "nos", "yo", "ella", "ello", "ellos", "ellas", "usted", "este", "esta",
  "estos", "estas", "ese", "esa", "eso", "esos", "esas", "es", "son", "ser", "hay", "como", "cual",
  "cuales", "quien", "quienes", "cuando", "donde", "cuanto", "cuanta", "cuantos", "cuantas", "muy", "mas",
  // verbos de petición
  "dice", "dicen", "decir", "dime", "digame", "explica", "explicame", "explicar", "puedes", "podrias",
  "quiero", "saber", "sabes", "busca", "buscar", "ayuda", "ayudame", "habla", "hablame",
  // inglés
  "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "is", "are", "what", "which", "who",
  "how", "does", "do", "about", "tell", "me", "please",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

/** Palabras con contenido: sin acentos ni palabras vacías; los números se conservan. */
export function contentTokens(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(/\s+/)
      .filter((token) => token.length > 0 && !STOPWORDS.has(token))
      .filter((token) => token.length > 1 || /^\p{N}+$/u.test(token))
  );
}

/** Igualdad o variante por sufijo (plural, género): artículo/artículos, nación/naciones. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short) && long.length - short.length <= 2;
}

/**
 * Qué fracción de las palabras con contenido de la pregunta aparece en el
 * texto de la KB (descripción + etiquetas de tema). 0 si no hay ninguna.
 */
export function kbMatchScore(question: string, kbText: string): number {
  const questionTokens = [...contentTokens(question)];
  if (questionTokens.length === 0) return 0;
  const kbTokens = [...contentTokens(kbText)];
  const matched = questionTokens.filter((token) => kbTokens.some((candidate) => sameWord(token, candidate)));
  return matched.length / questionTokens.length;
}

/** Texto de la KB para comparar: descripción y etiquetas de tema (no los `tool:<nombre>`). */
export function kbMatchText(description: string, tags: string[]): string {
  return [description, ...tags.filter((tag) => !tag.startsWith("tool:"))].join(" ");
}

/**
 * Fragmentos de una respuesta de KB. El kb-provider P2P devuelve el arreglo
 * de fragmentos tal cual; otros providers lo envuelven en `{ chunks }`. Antes
 * solo se aceptaba `{ chunks }`: con el arreglo, `parsed.chunks` era
 * undefined y el texto de la KB nunca llegaba al prompt (E2E-029).
 */
export function kbChunksFrom<T extends { text: string }>(parsed: unknown): T[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { chunks?: unknown }).chunks)
      ? (parsed as { chunks: unknown[] }).chunks
      : [];
  return list.filter((chunk): chunk is T =>
    Boolean(chunk) && typeof chunk === "object" && typeof (chunk as { text?: unknown }).text === "string" && (chunk as { text: string }).text.trim() !== "");
}
