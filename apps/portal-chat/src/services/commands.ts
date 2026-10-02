/**
 * Comandos de chat autodescubiertos (SPEC-CMD-0001): lo que el Navigator
 * informa en `commands.available`. El Portal no conoce ningún comando: solo
 * muestra la lista vigente para autocompletar y recordar el uso.
 *
 * Todo texto que viene de un nodo (resumen, uso) se pinta como texto plano.
 */

export interface CommandView {
  name: string;
  usage: string;
  summary: string;
  nodesCount: number;
  /** Varios nodos lo ofrecen con contratos distintos: deshabilitado. */
  conflict: boolean;
}

export interface CommandsView {
  /** Monótono dentro de la sesión del Navigator. */
  revision: number;
  commands: CommandView[];
}

/** `/ayuda` lo atiende el propio Navigator, sin red: siempre disponible. */
export const HELP_COMMAND: CommandView = {
  name: "ayuda",
  usage: "/ayuda",
  summary: "Lista los comandos disponibles",
  nodesCount: 0,
  conflict: false,
};

/**
 * Aplica una lista recibida. Dentro de una sesión solo avanza con una
 * `revision` mayor; tras reconectar (`replace`) la lista se reemplaza sin
 * comparar con revisiones de la sesión anterior.
 */
export function applyCommands(current: CommandsView | null, incoming: CommandsView, replace = false): CommandsView {
  if (replace || current === null || incoming.revision > current.revision) return incoming;
  return current;
}

/** Sugerencias para lo que se está escribiendo: `/` + prefijo, sin espacios todavía. */
export function suggest(commands: readonly CommandView[], input: string): CommandView[] {
  if (!input.startsWith("/") || input.startsWith("//") || /\s/.test(input)) return [];
  const prefix = input.slice(1).toLowerCase();
  const all = [...commands, ...(commands.some((c) => c.name === HELP_COMMAND.name) ? [] : [HELP_COMMAND])];
  return all
    .filter((command) => command.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Uso del comando que ya se escribió completo (`/calc ` con espacio), si existe y está activo. */
export function usageFor(commands: readonly CommandView[], input: string): CommandView | undefined {
  const match = /^\/([^\s/][^\s]*)\s/.exec(input);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return commands.find((command) => command.name === name && !command.conflict);
}

/** Línea para una sugerencia; nunca incluye texto de conflicto declarado por nodos. */
export function suggestionLabel(command: CommandView): string {
  if (command.conflict) return `/${command.name} · conflicto (${command.nodesCount} nodos)`;
  const nodes = command.nodesCount === 1 ? "1 nodo" : command.nodesCount > 1 ? `${command.nodesCount} nodos` : "";
  const detail = command.summary ? ` — ${command.summary}` : "";
  return `${command.usage}${detail}${nodes ? ` (${nodes})` : ""}`;
}
