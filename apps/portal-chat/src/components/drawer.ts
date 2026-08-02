export interface Drawer {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

/**
 * Grupo de paneles off-canvas que comparten un solo scrim (sidebar,
 * actividad, ajustes en mobile) — abrir uno cierra los demás, como
 * cualquier menú off-canvas normal. En desktop (≥1024px) el CSS ignora
 * la clase `.open` y muestra cada panel inline en el grid — este helper
 * solo maneja el toggle, nunca decide qué se ve en cada breakpoint.
 */
export function createDrawerGroup(scrim: HTMLElement) {
  const drawers: Drawer[] = [];

  function closeAll() {
    for (const d of drawers) d.close();
  }

  scrim.addEventListener("click", closeAll);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });

  function register(panel: HTMLElement, trigger: HTMLElement): Drawer {
    function open() {
      closeAll();
      panel.classList.add("open");
      scrim.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    }

    function close() {
      panel.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      if (!drawers.some((d) => d !== drawer && d.isOpen())) {
        scrim.classList.remove("open");
      }
    }

    function isOpen() {
      return panel.classList.contains("open");
    }

    function toggle() {
      if (isOpen()) close();
      else open();
    }

    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", toggle);

    const drawer: Drawer = { open, close, toggle, isOpen };
    drawers.push(drawer);
    return drawer;
  }

  return { register, closeAll };
}
