/**
 * Diagnóstico de red del portal.
 *
 * El navegador es un peer libp2p más: se conecta al bootstrap (Atlas),
 * descubre a Navigator por GossipSub y lo dialea directamente. Cualquiera de
 * esos pasos puede fallar por causas de red (certificado autofirmado no
 * aceptado, puerto cerrado, host inalcanzable, reloj desfasado) y antes esos
 * errores se tragaban o llegaban como "[object Event]". Este módulo los
 * registra por etapa y los convierte en texto accionable.
 *
 * Límite del navegador: por seguridad, JavaScript no recibe el motivo TLS de
 * un WebSocket fallido (solo un Event de error o un CloseEvent 1006). No se
 * puede afirmar "certificado rechazado"; sí se puede decir qué wss://host:puerto
 * falló y ofrecer el enlace para aceptar su certificado.
 */

export type DiagStage =
  | "config"
  | "bootstrap"
  | "advertise"
  | "beacon"
  | "navigator-dial"
  | "stream"
  | "handshake"
  | "session";

export interface DiagEntry {
  at: number;
  stage: DiagStage;
  ok: boolean;
  message: string;
  /** Multiaddr o URL a la que se refiere la entrada. */
  target?: string;
  hint?: string;
  /** Solo para `advertise`: si el anuncio es de un Navigator u otro nodo. */
  kind?: "navigator" | "other";
}

export interface DiagEndpoint {
  target: string;
  stage: DiagStage;
  ok: boolean;
  message: string;
  hint?: string;
  /** Página HTTPS del mismo host:puerto, para aceptar su certificado. */
  acceptUrl?: string;
  loopback: boolean;
}

export interface DescribedError {
  message: string;
  details: string[];
}

export interface DiagnosticsSink {
  record(entry: Omit<DiagEntry, "at"> & { at?: number }): DiagEntry;
}

export const noopDiagnostics: DiagnosticsSink = {
  record: (entry) => ({ at: Date.now(), ...entry }),
};

/** Convierte cualquier valor lanzado en texto legible, sin "[object Event]". */
export function describeError(error: unknown): DescribedError {
  if (isAggregate(error)) {
    const details = error.errors.flatMap((inner) => {
      const described = describeError(inner);
      return [described.message, ...described.details];
    });
    return { message: error.message || "Fallaron todos los intentos", details };
  }

  if (error instanceof Error) {
    const prefix = error.name && error.name !== "Error" ? `${error.name}: ` : "";
    const details: string[] = [];
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
      const described = describeError(cause);
      details.push(described.message, ...described.details);
    }
    return { message: `${prefix}${error.message}`, details };
  }

  if (isEventLike(error)) {
    const url = targetUrl(error);
    const where = url ? ` ${url}` : "";
    if (error.type === "close" && typeof error.code === "number") {
      const reason = typeof error.reason === "string" && error.reason ? ` (${error.reason})` : "";
      const abnormal = error.code === 1006 ? ", cierre anormal" : "";
      return { message: `La conexión${where} se cerró con código ${error.code}${abnormal}${reason}`, details: [] };
    }
    if (error.type === "error") {
      return { message: `No se pudo abrir la conexión${where}`, details: [] };
    }
    return { message: `Evento "${error.type}"${where}`, details: [] };
  }

  if (typeof error === "string") return { message: error, details: [] };

  try {
    return { message: JSON.stringify(error) ?? String(error), details: [] };
  } catch {
    return { message: String(error), details: [] };
  }
}

/** Mensaje de una línea, con los detalles internos a continuación. */
export function errorText(error: unknown): string {
  const { message, details } = describeError(error);
  return details.length > 0 ? `${message} — ${details.join("; ")}` : message;
}

const ADDRESS_PATTERN = /^\/(ip4|ip6|dns4|dns6|dns)\/([^/]+)\/tcp\/(\d+)/;

export function parseTarget(target: string): { host: string; port: number; ipv6: boolean } | undefined {
  const match = ADDRESS_PATTERN.exec(target);
  if (match) return { host: match[2], port: Number(match[3]), ipv6: match[1] === "ip6" };
  try {
    const url = new URL(target);
    const port = Number(url.port || (url.protocol === "wss:" || url.protocol === "https:" ? 443 : 80));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return { host, port, ipv6: host.includes(":") };
  } catch {
    return undefined;
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** `https://host:puerto/` del mismo endpoint, para aceptar su certificado. */
export function certAcceptUrl(target: string): string | undefined {
  const parsed = parseTarget(target);
  if (!parsed) return undefined;
  const host = parsed.ipv6 ? `[${parsed.host}]` : parsed.host;
  return `https://${host}:${parsed.port}/`;
}

/** Pista accionable para una conexión segura que no se pudo abrir. */
export function hintForTarget(target: string, hostname: string): string | undefined {
  const parsed = parseTarget(target);
  if (!parsed) return undefined;
  if (isLoopbackHost(parsed.host) && !isLoopbackHost(hostname)) {
    return "Dirección de loopback anunciada por el peer: no es alcanzable desde otro equipo (esperado).";
  }
  const url = certAcceptUrl(target);
  return `Causa más común: el navegador no aceptó el certificado autofirmado. Abre ${url} y acepta el riesgo. `
    + `Si esa página no carga, el puerto ${parsed.port} está cerrado o ${parsed.host} no es alcanzable desde esta red.`;
}

export class DiagnosticsLog implements DiagnosticsSink {
  private entries: DiagEntry[] = [];
  private attemptStart = 0;
  private readonly listeners = new Set<(entry: DiagEntry) => void>();

  constructor(
    private readonly capacity = 300,
    private readonly consoleSink: Pick<Console, "info" | "warn"> | null = typeof console === "undefined" ? null : console,
  ) {}

  record(entry: Omit<DiagEntry, "at"> & { at?: number }): DiagEntry {
    const complete: DiagEntry = { ...entry, at: entry.at ?? Date.now() };
    this.entries.push(complete);
    if (this.entries.length > this.capacity) {
      const dropped = this.entries.length - this.capacity;
      this.entries.splice(0, dropped);
      this.attemptStart = Math.max(0, this.attemptStart - dropped);
    }
    const line = `[fhs-diag] ${complete.stage} ${complete.ok ? "✓" : "✗"}${complete.target ? ` ${complete.target}` : ""} — ${complete.message}`;
    if (complete.ok) this.consoleSink?.info(line);
    else this.consoleSink?.warn(complete.hint ? `${line}\n  ↳ ${complete.hint}` : line);
    for (const listener of this.listeners) listener(complete);
    return complete;
  }

  /** Marca el inicio de un intento de sesión: summary() y endpoints() miran solo desde aquí. */
  beginAttempt(attempt: number): void {
    this.attemptStart = this.entries.length;
    this.record({ stage: "session", ok: true, message: attempt > 0 ? `Reintento ${attempt}` : "Nueva sesión" });
  }

  list(): readonly DiagEntry[] {
    return this.entries;
  }

  currentAttempt(): readonly DiagEntry[] {
    return this.entries.slice(this.attemptStart);
  }

  subscribe(listener: (entry: DiagEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Último estado conocido de cada endpoint que el navegador intentó abrir. */
  endpoints(hostname = pageHostname()): DiagEndpoint[] {
    const latest = new Map<string, DiagEntry>();
    for (const entry of this.currentAttempt()) {
      if ((entry.stage === "bootstrap" || entry.stage === "navigator-dial") && entry.target) {
        latest.set(transportKey(entry.target), entry);
      }
    }
    return [...latest.values()].map((entry) => {
      const parsed = parseTarget(entry.target ?? "");
      const loopback = parsed ? isLoopbackHost(parsed.host) && !isLoopbackHost(hostname) : false;
      return {
        target: entry.target ?? "",
        stage: entry.stage,
        ok: entry.ok,
        message: entry.message,
        hint: entry.hint,
        acceptUrl: loopback ? undefined : certAcceptUrl(entry.target ?? ""),
        loopback,
      };
    });
  }

  /** Motivo de una línea del intento actual, pensado para la etiqueta de conexión. */
  summary(): string {
    const entries = this.currentAttempt();
    const failed = (stage: DiagStage) => entries.filter((entry) => entry.stage === stage && !entry.ok);
    const succeeded = (stage: DiagStage) => entries.some((entry) => entry.stage === stage && entry.ok);

    const config = failed("config")[0];
    if (config) return config.message;

    if (!succeeded("bootstrap")) {
      const bootstrapFailures = failed("bootstrap");
      if (bootstrapFailures.length > 0) {
        return `Sin conexión con el bootstrap (Atlas): falló ${bootstrapFailures.map((entry) => entry.target).join(", ")}`;
      }
      return entries.length > 1 ? "Esperando conexión con el bootstrap (Atlas)" : "";
    }

    const navigatorAdvertised = entries.some((entry) => entry.stage === "advertise" && entry.ok && entry.kind === "navigator");
    if (!navigatorAdvertised) {
      const rejected = failed("advertise");
      if (rejected.length > 0) {
        return `Llegaron anuncios rechazados: ${unique(rejected.map((entry) => entry.message)).join("; ")}`;
      }
      const others = entries.filter((entry) => entry.stage === "advertise" && entry.kind === "other").length;
      return others > 0
        ? `Conectado al swarm (${others} anuncios de otros nodos), pero ninguno de Navigator`
        : "Conectado al swarm, pero no llegó ningún anuncio de Navigator";
    }

    if (!succeeded("navigator-dial")) {
      const dialFailures = failed("navigator-dial").filter((entry) => {
        const parsed = parseTarget(entry.target ?? "");
        return !(parsed && isLoopbackHost(parsed.host) && !isLoopbackHost(pageHostname()));
      });
      if (dialFailures.length > 0) {
        return `Navigator encontrado, pero falló la conexión a ${dialFailures.map((entry) => entry.target).join(", ")}`;
      }
      return "Navigator encontrado, conectando…";
    }

    const later = entries.filter((entry) => (entry.stage === "stream" || entry.stage === "handshake") && !entry.ok).at(-1);
    return later?.message ?? "";
  }

  /** Reporte en texto plano para copiar y compartir. */
  report(meta: { version?: string; bootstrap?: readonly string[] } = {}): string {
    const lines = [
      "Diagnóstico de red — galaxIA Portal",
      `Fecha: ${new Date().toISOString()}`,
      `Versión: ${meta.version ?? "desconocida"}`,
      `Página: ${typeof location === "undefined" ? "-" : location.origin}`,
      `Navegador: ${typeof navigator === "undefined" ? "-" : navigator.userAgent}`,
      `Bootstrap: ${meta.bootstrap?.length ? meta.bootstrap.join(", ") : "-"}`,
      `Resumen: ${this.summary() || "sin fallos en el intento actual"}`,
      "",
      "Endpoints (intento actual):",
      ...this.endpoints().map((endpoint) => `  ${endpoint.ok ? "✓" : "✗"} [${endpoint.stage}] ${endpoint.target} — ${endpoint.message}`),
      "",
      "Eventos:",
      ...this.entries.map((entry) => {
        const time = new Date(entry.at).toISOString().slice(11, 23);
        return `  ${time} ${entry.ok ? "✓" : "✗"} ${entry.stage}${entry.target ? ` ${entry.target}` : ""} — ${entry.message}${entry.hint ? ` | ${entry.hint}` : ""}`;
      }),
    ];
    return lines.join("\n");
  }
}

/** Registro compartido por la sesión de chat y el panel de diagnóstico. */
export const diagnostics = new DiagnosticsLog();

export function pageHostname(): string {
  return typeof location === "undefined" ? "" : location.hostname;
}

/** Misma dirección de transporte aunque cambie el sufijo /p2p/<id>. */
function transportKey(target: string): string {
  return target.replace(/\/p2p\/[^/]+$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isAggregate(value: unknown): value is { message: string; errors: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { errors?: unknown }).errors)
    && (value instanceof Error || typeof (value as { message?: unknown }).message === "string");
}

interface EventLike {
  type: string;
  target?: unknown;
  code?: unknown;
  reason?: unknown;
}

function isEventLike(value: unknown): value is EventLike {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
    && ("target" in value || "currentTarget" in value);
}

function targetUrl(event: EventLike): string | undefined {
  const target = event.target as { url?: unknown } | null | undefined;
  return typeof target?.url === "string" ? target.url : undefined;
}
