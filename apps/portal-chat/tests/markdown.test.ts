import { describe, expect, it } from "vitest";
import { isSafeHref, parseInline, parseMarkdown, type InlineNode } from "../src/services/markdown.js";

const text = (value: string): InlineNode => ({ type: "text", value });

describe("parseInline", () => {
  it("negritas, cursivas, tachado y código", () => {
    expect(parseInline("a **b** *c* ~~d~~ `e`")).toEqual([
      text("a "),
      { type: "strong", children: [text("b")] },
      text(" "),
      { type: "em", children: [text("c")] },
      text(" "),
      { type: "del", children: [text("d")] },
      text(" "),
      { type: "code", value: "e" },
    ]);
  });

  it("dentro del código no hay markdown", () => {
    expect(parseInline("`**no**`")).toEqual([{ type: "code", value: "**no**" }]);
  });

  it("variable_con_guiones no es cursiva", () => {
    expect(parseInline("usa mi_variable_larga")).toEqual([text("usa mi_variable_larga")]);
  });

  it("un ** sin cerrar (streaming a medias) se queda como texto", () => {
    expect(parseInline("hola **mun")).toEqual([text("hola **mun")]);
  });

  it("saltos de línea como br", () => {
    expect(parseInline("uno\ndos")).toEqual([text("uno"), { type: "br" }, text("dos")]);
  });

  it("solo enlaces http(s) y mailto; javascript: queda como texto", () => {
    expect(parseInline("[sitio](https://galax-ia.rafex.io)")).toEqual([
      { type: "link", href: "https://galax-ia.rafex.io", children: [text("sitio")] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([text("[x](javascript:alert(1))")]);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
  });

  it("el HTML del modelo llega como texto, nunca como etiqueta", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([text("<img src=x onerror=alert(1)>")]);
  });
});

describe("parseMarkdown", () => {
  it("la respuesta real del laboratorio: párrafos con negritas y separador", () => {
    const blocks = parseMarkdown(
      "El documento trata sobre una **plataforma de gestión**.\n\nSin embargo, es un **fragmento**.\n\n---\n\nFin.",
    );
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "hr", "paragraph"]);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [text("El documento trata sobre una "), { type: "strong", children: [text("plataforma de gestión")] }, text(".")],
    });
  });

  it("lista con viñetas * y espacios extra, como las escribe el modelo", () => {
    const [list] = parseMarkdown("*   **Ciclo:** 12 años\n*   **Garantías:** por ley");
    expect(list).toMatchObject({ type: "list", ordered: false });
    expect(list.type === "list" && list.items).toHaveLength(2);
  });

  it("sublista indentada queda dentro del elemento (como en la respuesta real)", () => {
    const [list] = parseMarkdown("1. **Uno:** a\n2. **Tres:**\n   *   **Sub:** b\n   *   c\n3. Cuatro");
    expect(list.type === "list" && list.items.map((item) => item.blocks.length)).toEqual([0, 1, 0]);
    const nested = list.type === "list" ? list.items[1].blocks[0] : undefined;
    expect(nested).toMatchObject({ type: "list", ordered: false });
    expect(nested?.type === "list" && nested.items).toHaveLength(2);
  });

  it("una línea indentada sin viñeta es continuación del elemento", () => {
    const [list] = parseMarkdown("- primera\n  sigue aquí\n- segunda");
    expect(list.type === "list" && list.items[0]).toEqual({
      children: [text("primera"), { type: "br" }, text("sigue aquí")],
      blocks: [],
    });
  });

  it("lista numerada que no empieza en 1", () => {
    expect(parseMarkdown("3. tres\n4. cuatro")[0]).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("bloque de código con lenguaje, sin interpretar su contenido", () => {
    expect(parseMarkdown("```ts\nconst a = **1**;\n```")).toEqual([
      { type: "code", lang: "ts", value: "const a = **1**;" },
    ]);
  });

  it("``` sin cerrar durante el streaming muestra lo que va como código", () => {
    expect(parseMarkdown("```\nlínea 1")).toEqual([{ type: "code", lang: "", value: "línea 1" }]);
  });

  it("encabezados, citas y tablas", () => {
    const blocks = parseMarkdown("## Título\n\n> cita\n\n| A | B |\n|:--|--:|\n| 1 | 2 |");
    expect(blocks[0]).toEqual({ type: "heading", level: 2, children: [text("Título")] });
    expect(blocks[1]).toEqual({ type: "quote", children: [{ type: "paragraph", children: [text("cita")] }] });
    expect(blocks[2]).toEqual({
      type: "table",
      header: [[text("A")], [text("B")]],
      align: ["left", "right"],
      rows: [[[text("1")], [text("2")]]],
    });
  });

  it("una lista justo después de un párrafo abre bloque nuevo", () => {
    expect(parseMarkdown("Opciones:\n- una\n- dos").map((block) => block.type)).toEqual(["paragraph", "list"]);
  });
});
