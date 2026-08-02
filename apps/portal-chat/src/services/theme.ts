export type Theme = "light" | "dark" | "high-contrast";

const STORAGE_KEY = "galaxia-theme";
const THEME_ORDER: Theme[] = ["light", "dark", "high-contrast"];

const THEME_LABELS: Record<Theme, string> = {
  light: "Claro",
  dark: "Oscuro",
  "high-contrast": "Alto contraste",
};

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "high-contrast";
}

export function getStoredTheme(): Theme | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : null;
}

/** Sin preferencia guardada: usa `prefers-color-scheme` una sola vez como default inicial. */
export function getInitialTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY, theme);
}

export function getCurrentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return isTheme(attr) ? attr : getInitialTheme();
}

export function cycleTheme(): Theme {
  const current = getCurrentTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  applyTheme(next);
  return next;
}

export function themeLabel(theme: Theme): string {
  return THEME_LABELS[theme];
}
