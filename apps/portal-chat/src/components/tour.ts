export interface TourStep {
  selector: string;
  title: string;
  body: string;
  /** Se llama antes de resaltar el paso — abre el drawer que lo contenga en mobile. */
  beforeShow?: () => void;
}

const STORAGE_KEY = "galaxia-tour-completed";

export interface Tour {
  start(): void;
}

export function createTour(steps: TourStep[]): Tour {
  let overlay: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let highlighted: HTMLElement | null = null;
  let index = 0;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "tour-overlay";

    card = document.createElement("div");
    card.className = "tour-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Tour guiado");

    document.body.appendChild(overlay);
    document.body.appendChild(card);
  }

  function clearHighlight() {
    highlighted?.classList.remove("tour-highlight");
    highlighted = null;
  }

  function renderStep() {
    const step = steps[index];
    if (!step || !card) return;

    step.beforeShow?.();
    clearHighlight();

    const target = document.querySelector<HTMLElement>(step.selector);

    card.innerHTML = `
      <p class="tour-step-count">${index + 1} / ${steps.length}</p>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      <div class="tour-actions">
        <button type="button" class="tour-skip">Saltar</button>
        <div class="tour-nav">
          ${index > 0 ? '<button type="button" class="tour-prev">Anterior</button>' : ""}
          <button type="button" class="tour-next">${index === steps.length - 1 ? "Terminar" : "Siguiente"}</button>
        </div>
      </div>
    `;

    card.querySelector(".tour-skip")?.addEventListener("click", finish);
    card.querySelector(".tour-prev")?.addEventListener("click", () => {
      index = Math.max(0, index - 1);
      renderStep();
    });
    card.querySelector(".tour-next")?.addEventListener("click", () => {
      if (index === steps.length - 1) finish();
      else {
        index += 1;
        renderStep();
      }
    });

    if (!target) {
      // El elemento del paso no existe en este momento (ej. breakpoint
      // distinto) — centra la tarjeta en vez de fallar.
      card.style.top = "50%";
      card.style.left = "50%";
      card.style.transform = "translate(-50%, -50%)";
      return;
    }

    target.classList.add("tour-highlight");
    highlighted = target;
    target.scrollIntoView({ block: "center", behavior: "smooth" });

    // Reposicionar tras el scroll para que la tarjeta apunte al lugar real.
    requestAnimationFrame(() => positionCard(target));
  }

  function positionCard(target: HTMLElement) {
    if (!card) return;
    card.style.transform = "";
    const rect = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();

    let top = rect.bottom + 12;
    if (top + cardRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - cardRect.height - 12);
    }
    let left = rect.left + rect.width / 2 - cardRect.width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - cardRect.width - 12));

    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function finish() {
    clearHighlight();
    overlay?.remove();
    card?.remove();
    overlay = null;
    card = null;
    localStorage.setItem(STORAGE_KEY, "1");
  }

  function start() {
    if (steps.length === 0) return;
    index = 0;
    ensureDom();
    renderStep();
  }

  return { start };
}

export function hasTourRun(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}
