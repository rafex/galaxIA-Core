let bubble: HTMLElement | null = null;
let activeTarget: HTMLElement | null = null;
let bubbleIdCounter = 0;

function ensureBubble(): HTMLElement {
  if (bubble) return bubble;
  bubble = document.createElement("div");
  bubble.className = "tooltip-bubble";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  document.body.appendChild(bubble);
  return bubble;
}

function position(target: HTMLElement, el: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const bubbleRect = el.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - bubbleRect.width / 2;

  // Si no cabe abajo, se muestra arriba del elemento.
  if (top + bubbleRect.height > window.innerHeight - 8) {
    top = rect.top - bubbleRect.height - 8;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - bubbleRect.width - 8));

  el.style.top = `${top + window.scrollY}px`;
  el.style.left = `${left + window.scrollX}px`;
}

function show(target: HTMLElement) {
  const text = target.dataset.tooltip;
  if (!text) return;
  const el = ensureBubble();
  el.textContent = text;
  el.hidden = false;

  if (!target.id) target.id = `tooltip-target-${++bubbleIdCounter}`;
  if (!el.id) el.id = `tooltip-bubble-${bubbleIdCounter}`;
  target.setAttribute("aria-describedby", el.id);

  position(target, el);
  activeTarget = target;
}

/** Si `target` es el que tiene la burbuja abierta ahora, refresca su texto (ej. el tema cambió mientras el botón seguía en hover/foco). */
export function refreshTooltip(target: HTMLElement): void {
  if (bubble && activeTarget === target && !bubble.hidden) {
    show(target);
  }
}

function hide() {
  if (bubble) bubble.hidden = true;
  activeTarget?.removeAttribute("aria-describedby");
  activeTarget = null;
}

/**
 * Tooltips accesibles sobre `[data-tooltip]` — un solo listener delegado
 * para toda la app (sin librería externa, ver spec-native/STACK.md). Hover
 * y foco de teclado en desktop; tap-toggle en touch (hover no existe ahí).
 */
export function initTooltips(root: HTMLElement = document.body): void {
  root.addEventListener("mouseover", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tooltip]");
    if (target) show(target);
  });

  root.addEventListener("mouseout", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tooltip]");
    if (target && target === activeTarget) hide();
  });

  root.addEventListener("focusin", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tooltip]");
    if (target) show(target);
  });

  root.addEventListener("focusout", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tooltip]");
    if (target && target === activeTarget) hide();
  });

  // Touch: sin hover, así que un tap muestra/oculta; tocar afuera cierra.
  root.addEventListener("touchstart", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tooltip]");
    if (target) {
      event.preventDefault();
      if (activeTarget === target) hide();
      else show(target);
    } else if (activeTarget) {
      hide();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeTarget) hide();
  });

  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}
