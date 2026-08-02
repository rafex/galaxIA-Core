import type { ParserProfile, RequestedTool, ToolCall } from "./types.js";

type Strategy = (
  content: string,
  rule: Record<string, unknown>,
  requestedTools: RequestedTool[]
) => ToolCall | null;

/**
 * Estrategias de parseo genéricas — el dato variable por modelo vive en
 * `rule` (ver profiles/*.json), no aquí. Un perfil nuevo para un modelo
 * distinto normalmente reutiliza una estrategia existente con otra `rule`,
 * no necesita código nuevo.
 */
const strategies: Record<string, Strategy> = {
  "plain-json-in-content": (content, rule, requestedTools) => {
    let trimmed = content.trim();
    if (rule.stripCodeFences) {
      trimmed = trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
    }
    const mustStartWith = typeof rule.mustStartWith === "string" ? rule.mustStartWith : "{";
    if (!trimmed.startsWith(mustStartWith)) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }

    const name = parsed?.name;
    if (typeof name !== "string") return null;

    if (rule.validateNameAgainst === "requestedTools[].function.name") {
      const known = new Set(requestedTools.map((t) => t.function.name));
      if (!known.has(name)) return null;
    }

    const args = parsed.arguments ?? {};
    return {
      id: `fallback_${Date.now()}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
  },
};

/** Encuentra, entre los perfiles cargados, el que aplica a un modelo dado. */
export function matchProfile(modelId: string, catalog: ParserProfile[]): ParserProfile | null {
  return catalog.find((p) => new RegExp(p.modelPattern).test(modelId)) ?? null;
}

/** Aplica la regla de un perfil ya resuelto contra el contenido de una respuesta. */
export function tryParse(
  content: string,
  requestedTools: RequestedTool[],
  profile: ParserProfile
): ToolCall | null {
  const strategyFn = strategies[profile.strategy];
  if (!strategyFn) return null;
  return strategyFn(content, profile.rule, requestedTools);
}
