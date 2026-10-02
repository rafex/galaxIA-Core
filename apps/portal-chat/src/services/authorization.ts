/**
 * Autorización explícita por uso (SPEC-AUTH-0001): lógica pura de la tarjeta.
 *
 * Sin DOM ni red: etiquetas legibles, selección con dependencias y decisiones.
 * Los nombres de nodo son autodeclarados y solo se muestran como texto.
 */
import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";

export interface AuthItemView {
  itemId: string;
  capabilityId: string;
  providerDid: string;
  providerName: string;
  trustLevel: string;
  policyVersion: string;
  dataClass: FhsProto.AuthorizationDataClass;
  dataSummary: string;
  destination: FhsProto.AuthorizationDestination;
  retention: FhsProto.AuthorizationRetention;
  dependsOn: string[];
  firstTimeNode: boolean;
  publicNetwork: boolean;
  failover: boolean;
  sideEffects: boolean;
  retry: boolean;
  implicit: boolean;
}

export interface AuthRequestView {
  authorizationId: string;
  conversationId: string;
  turnId: string;
  expiresAt: number;
  batchDigest: Uint8Array;
  items: AuthItemView[];
}

export interface AuthItemStatusView {
  itemId: string;
  outcome: FhsProto.AuthorizationOutcome;
  reason: string;
}

export interface AuthResolvedView {
  authorizationId: string;
  outcome: FhsProto.AuthorizationOutcome;
  items: AuthItemStatusView[];
}

const CAPABILITY_LABELS: Record<string, string> = {
  "document.ocr": "Extraer el texto del archivo (OCR)",
  "ipfs.upload": "Subir el archivo a IPFS",
  "knowledge.query": "Consultar una base de conocimiento",
  "document.index": "Indexar el texto en el RAG de la red",
  "document.query": "Buscar en el documento indexado",
  "math.arithmetic.solve": "Calcular en un nodo",
};

/** Texto del ítem para la persona: qué se hace y con qué clase de dato. */
export function itemLabel(item: Pick<AuthItemView, "capabilityId" | "dataClass">): string {
  if (item.capabilityId === "chat") {
    switch (item.dataClass) {
      case FhsProto.AuthorizationDataClass.USER_MESSAGE:
        return "Enviar tu mensaje al modelo";
      case FhsProto.AuthorizationDataClass.DERIVED_TEXT:
        return "Enviar fragmentos de tus documentos o bases de conocimiento al modelo";
      case FhsProto.AuthorizationDataClass.TOOL_OUTPUT_TO_LLM:
        return "Enviar al modelo el resultado de una herramienta";
      default:
        return "Enviar contenido al modelo";
    }
  }
  return CAPABILITY_LABELS[item.capabilityId] ?? item.capabilityId;
}

export function destinationLabel(destination: FhsProto.AuthorizationDestination): string {
  switch (destination) {
    case FhsProto.AuthorizationDestination.LOCAL:
      return "nodo local";
    case FhsProto.AuthorizationDestination.NETWORK:
      return "red de confianza";
    case FhsProto.AuthorizationDestination.COMMUNITY:
      return "red comunitaria";
    case FhsProto.AuthorizationDestination.EXTERNAL:
      return "nodo externo";
    case FhsProto.AuthorizationDestination.PUBLIC_IPFS:
      return "IPFS público";
    default:
      return "destino sin clasificar";
  }
}

export function retentionLabel(retention: FhsProto.AuthorizationRetention): string {
  switch (retention) {
    case FhsProto.AuthorizationRetention.EPHEMERAL:
      return "efímera";
    case FhsProto.AuthorizationRetention.REUSE:
      return "se conserva para reutilizar";
    case FhsProto.AuthorizationRetention.PERMANENT:
      return "permanente";
    default:
      return "sin definir";
  }
}

/** El nivel lo deriva el Navigator; aquí solo se traduce. */
export function trustLabel(level: string): string {
  if (level === "operator") return "verificado por el operador";
  if (level === "delegated") return "con delegación del operador";
  if (level === "community") return "comunidad, sin verificar";
  return level || "sin verificar";
}

export function shortDid(did: string): string {
  return did.length > 26 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did;
}

/** Avisos de riesgo que la persona debe ver antes de aprobar. */
export function riskNotes(item: AuthItemView): string[] {
  const notes: string[] = [];
  if (item.publicNetwork) {
    notes.push("Red pública: cualquiera con el enlace podrá leerlo y copiarlo; no se puede garantizar el borrado.");
  }
  if (item.firstTimeNode) notes.push("Primera vez que se usa este nodo.");
  if (item.failover) notes.push("Sustituye a un nodo que falló: es otro nodo distinto al anterior.");
  if (item.retry) notes.push("Reintento tras un envío incierto.");
  if (item.sideEffects) notes.push("Esta herramienta puede tener efectos fuera de la red.");
  return notes;
}

/**
 * Marca o desmarca un ítem con sus dependencias: marcar uno marca de qué
 * depende; desmarcar uno desmarca lo que depende de él.
 */
export function toggleItem(
  items: readonly Pick<AuthItemView, "itemId" | "dependsOn">[],
  selected: ReadonlySet<string>,
  itemId: string,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  const byId = new Map(items.map((item) => [item.itemId, item]));
  if (on) {
    const add = (id: string): void => {
      if (next.has(id)) return;
      next.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) add(dependency);
    };
    add(itemId);
  } else {
    const remove = (id: string): void => {
      if (!next.delete(id)) return;
      for (const item of items) if (item.dependsOn.includes(id)) remove(item.itemId);
    };
    remove(itemId);
  }
  return next;
}

export function decisionsFor(
  items: readonly Pick<AuthItemView, "itemId">[],
  selected: ReadonlySet<string>,
): Array<{ itemId: string; allow: boolean }> {
  return items.map((item) => ({ itemId: item.itemId, allow: selected.has(item.itemId) }));
}

export function outcomeLabel(outcome: FhsProto.AuthorizationOutcome): string {
  switch (outcome) {
    case FhsProto.AuthorizationOutcome.ALLOWED:
      return "autorizado";
    case FhsProto.AuthorizationOutcome.DENIED:
      return "no autorizado";
    case FhsProto.AuthorizationOutcome.EXPIRED:
      return "venció sin respuesta; no se envió nada";
    case FhsProto.AuthorizationOutcome.CANCELLED:
      return "cancelado; no se envió nada";
    case FhsProto.AuthorizationOutcome.CONSUMED:
      return "enviando";
    case FhsProto.AuthorizationOutcome.SENT:
      return "enviado";
    case FhsProto.AuthorizationOutcome.FAILED:
      return "falló";
    case FhsProto.AuthorizationOutcome.PARTIAL:
      return "parcial";
    case FhsProto.AuthorizationOutcome.PENDING:
      return "esperando tu decisión";
    default:
      return "desconocido";
  }
}

/** ¿Ya no se espera nada de la persona? */
export function isFinal(outcome: FhsProto.AuthorizationOutcome): boolean {
  return outcome !== FhsProto.AuthorizationOutcome.PENDING && outcome !== FhsProto.AuthorizationOutcome.UNSPECIFIED;
}
