import { describe, expect, it } from "vitest";
import {
  applyCommands,
  HELP_COMMAND,
  suggest,
  suggestionLabel,
  usageFor,
  type CommandsView,
} from "../src/services/commands.js";

const calc = { name: "calc", usage: "/calc <expression...>", summary: "Calcula una expresión aritmética", nodesCount: 1, conflict: false };
const sumar = { name: "sumar", usage: "/sumar <x> <y>", summary: "Suma", nodesCount: 2, conflict: false };
const roto = { name: "roto", usage: "", summary: "", nodesCount: 2, conflict: true };
const view = (revision: number, commands = [calc]): CommandsView => ({ revision, commands });

describe("comandos autodescubiertos en el Portal", () => {
  it("aplica una lista solo si su revisión es mayor dentro de la sesión", () => {
    const first = applyCommands(null, view(1));
    expect(first.revision).toBe(1);
    expect(applyCommands(first, view(1, [sumar]))).toBe(first);
    expect(applyCommands(first, view(0, [sumar]))).toBe(first);
    expect(applyCommands(first, view(2, [sumar])).commands).toEqual([sumar]);
  });

  it("tras reconectar reemplaza la lista aunque la revisión sea menor", () => {
    const old = view(7, [calc]);
    expect(applyCommands(old, view(1, [sumar]), true).commands).toEqual([sumar]);
  });

  it("sugiere por prefijo, incluye /ayuda y no sugiere el escape ni lo que ya lleva argumentos", () => {
    const all = [calc, sumar, roto];
    expect(suggest(all, "/").map((c) => c.name)).toEqual(["ayuda", "calc", "roto", "sumar"]);
    expect(suggest(all, "/ca").map((c) => c.name)).toEqual(["calc"]);
    expect(suggest(all, "/CA").map((c) => c.name)).toEqual(["calc"]);
    expect(suggest(all, "/leer")).toEqual([]);
    expect(suggest(all, "//ca")).toEqual([]);
    expect(suggest(all, "hola")).toEqual([]);
    expect(suggest(all, "/calc 2+2")).toEqual([]);
    expect(suggest([], "/a")).toEqual([HELP_COMMAND]);
  });

  it("muestra el uso del comando ya escrito y nunca el de un conflicto", () => {
    expect(usageFor([calc, roto], "/calc 2+2")?.usage).toBe("/calc <expression...>");
    expect(usageFor([calc, roto], "/roto x")).toBeUndefined();
    expect(usageFor([calc], "/leer x")).toBeUndefined();
    expect(usageFor([calc], "/calc")).toBeUndefined();
  });

  it("describe cada sugerencia sin texto de nodo cuando hay conflicto", () => {
    expect(suggestionLabel(calc)).toBe("/calc <expression...> — Calcula una expresión aritmética (1 nodo)");
    expect(suggestionLabel(sumar)).toContain("2 nodos");
    expect(suggestionLabel(roto)).toBe("/roto · conflicto (2 nodos)");
    expect(suggestionLabel(HELP_COMMAND)).toBe("/ayuda — Lista los comandos disponibles");
  });
});
