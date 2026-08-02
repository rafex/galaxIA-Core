/**
 * Trazabilidad operacional (DEC-0012) — metadata de una Mission/chat, nunca
 * contenido. Siempre se registra, independiente de `privacy.retention` (que
 * solo gobierna contenido). Ver docs/protocolo.md, sección "Trazabilidad
 * operacional".
 */
export interface TraceEntry {
  conversationId: string;
  missionId: string;
  providerId: string;
  capability: string;
  dispatchMs: number | null;
  totalMs: number;
  success: boolean;
  errorCode?: string;
  /** DEC-0029: UUID de dispositivo del browser que inició la conversación. */
  deviceId?: string;
}

export function logTrace(entry: TraceEntry): void {
  console.log(JSON.stringify({ level: "trace", at: new Date().toISOString(), ...entry }));
}
