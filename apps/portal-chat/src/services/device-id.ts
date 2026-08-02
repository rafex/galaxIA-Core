const STORAGE_KEY = "fhs:deviceId";

/**
 * DEC-0029 — ID único de dispositivo persistido en localStorage.
 * Se genera la primera vez y se reutiliza en todas las sesiones del
 * mismo perfil de navegador. No es una identidad de persona — es un
 * UUID anónimo que permite deduplicar votos de community tags y rating
 * subjetivo por dispositivo. Ver spec-native/DECISIONS.md DEC-0029.
 */
export function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
