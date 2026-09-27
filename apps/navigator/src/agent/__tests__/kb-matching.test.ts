import { describe, expect, it } from "vitest";
import { KB_MATCH_THRESHOLD, contentTokens, kbMatchScore, kbMatchText } from "../kb-matching.js";

const CONSTITUCION_CORTA = "Constitución Política de los Estados Unidos Mexicanos";
const CONSTITUCION = `${CONSTITUCION_CORTA}: derechos humanos, educación, soberanía nacional y forma de gobierno (artículos 1, 3, 39 y 40)`;

const recommended = (question: string, description: string, tags: string[] = []) =>
  kbMatchScore(question, kbMatchText(description, tags)) >= KB_MATCH_THRESHOLD;

describe("contentTokens", () => {
  it("quita acentos, signos y palabras vacías, y conserva los números", () => {
    expect([...contentTokens("¿Qué dice el artículo 3 sobre la educación?")]).toEqual(["articulo", "3", "educacion"]);
  });
});

describe("recomendación de KB", () => {
  it("recomienda la Constitución para la pregunta real del laboratorio", () => {
    // Con Jaccard esto daba 0 y el modelo respondió inventando.
    expect(recommended("¿Qué dice el artículo 3 sobre la educación?", CONSTITUCION)).toBe(true);
  });

  it("empata singular y plural, y acentos (artículo ~ artículos, nación ~ naciones)", () => {
    expect(kbMatchScore("articulos", "el artículo")).toBe(1);
    expect(kbMatchScore("naciones", "nación")).toBe(1);
  });

  it("no empata prefijos cortos que son otra palabra", () => {
    // "ley" es prefijo de "leyenda" pero no son la misma palabra.
    expect(kbMatchScore("ley", "leyenda")).toBe(0);
  });

  it("una descripción más rica no baja el puntaje", () => {
    const question = "¿Qué dice la Constitución Política?";
    expect(kbMatchScore(question, CONSTITUCION)).toBe(kbMatchScore(question, CONSTITUCION_CORTA));
  });

  it("no recomienda la Constitución para preguntas de otro tema", () => {
    expect(recommended("que hora es en españa", CONSTITUCION)).toBe(false);
    expect(recommended("dame tres ideas para una demo", CONSTITUCION)).toBe(false);
  });

  it("ignora las etiquetas técnicas tool:<nombre>", () => {
    expect(kbMatchScore("query", kbMatchText("Recetas de cocina", ["tool:kb_query"]))).toBe(0);
    expect(kbMatchScore("recetas", kbMatchText("Base de cocina", ["recetas"]))).toBe(1);
  });

  it("una pregunta sin palabras con contenido no recomienda nada", () => {
    expect(kbMatchScore("¿qué es?", CONSTITUCION)).toBe(0);
  });
});
