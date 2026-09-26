import { diagnostics as defaultLog, type DiagEntry, type DiagnosticsLog } from "../services/diagnostics.js";

export interface DiagnosticsPanel {
  open(): void;
  close(): void;
}

const MAX_EVENTS_SHOWN = 80;

/**
 * Panel "Diagnóstico de red": qué endpoints intentó abrir el navegador, cuáles
 * fallaron y por qué, con enlace para aceptar el certificado autofirmado de
 * cada uno. Todo el contenido se arma con textContent: multiaddrs y DIDs
 * vienen de anuncios remotos y no deben interpretarse como HTML.
 */
export function createDiagnosticsPanel(
  dialog: HTMLDialogElement,
  options: { version: string; log?: DiagnosticsLog },
): DiagnosticsPanel {
  const log = options.log ?? defaultLog;
  const summaryEl = dialog.querySelector(".diag-summary") as HTMLElement;
  const endpointsEl = dialog.querySelector(".diag-endpoints") as HTMLElement;
  const eventsEl = dialog.querySelector(".diag-events") as HTMLElement;
  const copyBtn = dialog.querySelector(".diag-copy") as HTMLButtonElement;
  const copyStatusEl = dialog.querySelector(".diag-copy-status") as HTMLElement;
  const fallbackEl = dialog.querySelector(".diag-report-fallback") as HTMLTextAreaElement;
  let scheduled = false;

  dialog.querySelector(".diag-close")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    // Clic fuera del contenido (sobre el backdrop) cierra el diálogo.
    if (event.target === dialog) dialog.close();
  });

  copyBtn.addEventListener("click", () => {
    const report = log.report({ version: options.version });
    fallbackEl.hidden = true;
    navigator.clipboard.writeText(report).then(() => {
      copyStatusEl.textContent = "Copiado al portapapeles";
    }).catch((error: unknown) => {
      copyStatusEl.textContent = `No se pudo copiar (${error instanceof Error ? error.message : "sin permiso"}); selecciónalo abajo`;
      fallbackEl.value = report;
      fallbackEl.hidden = false;
      fallbackEl.select();
    });
  });

  log.subscribe(() => {
    if (!dialog.open || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  });

  function render(): void {
    const summary = log.summary();
    summaryEl.textContent = summary || "Sin fallos en el intento actual.";
    summaryEl.dataset.state = summary ? "problem" : "ok";

    const endpoints = log.endpoints();
    endpointsEl.replaceChildren();
    if (endpoints.length === 0) {
      endpointsEl.append(item("li", "diag-empty", "Todavía no se intentó abrir ningún endpoint."));
    }
    for (const endpoint of endpoints) {
      const li = document.createElement("li");
      li.className = "diag-endpoint";
      li.dataset.ok = String(endpoint.ok);
      if (endpoint.loopback) li.dataset.loopback = "true";

      const head = document.createElement("div");
      head.className = "diag-endpoint-head";
      head.append(
        item("span", "diag-mark", endpoint.ok ? "✓" : endpoint.loopback ? "–" : "✗"),
        item("span", "diag-stage", endpoint.stage === "bootstrap" ? "Atlas (bootstrap)" : "Navigator"),
        item("code", "diag-target", endpoint.target),
      );
      li.append(head, item("p", "diag-message", endpoint.message));
      if (!endpoint.ok && endpoint.hint) li.append(item("p", "diag-hint", endpoint.hint));
      if (!endpoint.ok && endpoint.acceptUrl) {
        const link = document.createElement("a");
        link.className = "diag-accept";
        link.href = endpoint.acceptUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `Aceptar certificado de ${endpoint.acceptUrl} ↗`;
        li.append(link);
      }
      endpointsEl.append(li);
    }

    eventsEl.replaceChildren();
    const entries = log.list().slice(-MAX_EVENTS_SHOWN);
    for (const entry of entries) eventsEl.append(eventItem(entry));
    eventsEl.scrollTop = eventsEl.scrollHeight;
  }

  return {
    open() {
      copyStatusEl.textContent = "";
      fallbackEl.hidden = true;
      render();
      if (!dialog.open) dialog.showModal();
    },
    close() {
      dialog.close();
    },
  };
}

function eventItem(entry: DiagEntry): HTMLElement {
  const li = document.createElement("li");
  li.className = "diag-event";
  li.dataset.ok = String(entry.ok);
  li.append(
    item("time", "diag-time", new Date(entry.at).toLocaleTimeString()),
    item("span", "diag-mark", entry.ok ? "✓" : "✗"),
    item("span", "diag-stage", entry.stage),
    item("span", "diag-message", entry.target ? `${entry.message} · ${entry.target}` : entry.message),
  );
  if (entry.hint) li.title = entry.hint;
  return li;
}

function item(tag: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}
