/**
 * Contador de peticiones en vuelo por provider (DEC-0072, backpressure) —
 * la vista local de este Navigator, no un estado global de la red: si dos
 * Agent Servers hablan con el mismo Star, cada uno solo ve las suyas. Por
 * eso el filtro de capacidad en la resolución es best-effort y la última
 * palabra la tiene el provider rechazando con `OVERLOADED`.
 */

const inFlight = new Map<string, number>();

export function acquireInFlight(providerId: string): void {
  inFlight.set(providerId, (inFlight.get(providerId) ?? 0) + 1);
}

export function releaseInFlight(providerId: string): void {
  const current = inFlight.get(providerId) ?? 0;
  if (current <= 1) inFlight.delete(providerId);
  else inFlight.set(providerId, current - 1);
}

export function inFlightCount(providerId: string): number {
  return inFlight.get(providerId) ?? 0;
}

/** true si el provider declara capacidad y este Navigator ya la tiene ocupada. */
export function atDeclaredCapacity(providerId: string, maxConcurrentRequests: number | undefined): boolean {
  if (!maxConcurrentRequests || maxConcurrentRequests <= 0) return false;
  return inFlightCount(providerId) >= maxConcurrentRequests;
}
