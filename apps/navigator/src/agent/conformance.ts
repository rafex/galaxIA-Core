/**
 * SPEC-AUTHZ-0001 / DEC-0099: este Navigator (TypeScript) NO implementa el
 * portón de salida (Dispatcher + Grant + autorización por uso). El Navigator
 * de referencia es `galaxIA-agent` (Rust). Por eso no declara
 * `authorization.v1` y sus rutas sensibles están desactivadas: solo reenvía el
 * mensaje literal del usuario al Star elegido (consentimiento implícito, P5).
 *
 * Desactivado: OCR, IPFS, RAG de red, KB (recomendada y manual), herramientas
 * pedidas por el LLM y comandos. No existe un modo "inseguro" que lo reactive.
 */
export const AUTHORIZATION_CONFORMANT: boolean = false;

export const NON_CONFORMANT_MESSAGE =
  "Este Navigator es anterior al estándar de autorización por uso (SPEC-AUTHZ-0001): " +
  "solo envía tu mensaje al modelo; OCR, documentos, bases de conocimiento y herramientas están desactivados.";
