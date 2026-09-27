// Markdown mínimo para las respuestas del asistente.
//
// El texto viene de un LLM remoto, así que es contenido no confiable: nunca
// se usa innerHTML. El parser produce un árbol y `renderMarkdown` lo convierte
// en nodos DOM con createElement/textContent, así que ningún carácter del
// texto puede volverse HTML. Los enlaces solo aceptan http(s) y mailto.
//
// Cubre lo que devuelven los modelos en la práctica: párrafos, encabezados,
// negritas, cursivas, tachado, código en línea y en bloque, listas, citas,
// separadores, tablas y enlaces. Tolera texto a medias durante el streaming
// (un ``` sin cerrar se muestra como bloque de código).

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "br" };

/** Elemento de lista: su texto y, si lo hay, lo anidado debajo (sublistas). */
export interface ListItem {
  children: InlineNode[];
  blocks: BlockNode[];
}

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: number; children: InlineNode[] }
  | { type: "code"; lang: string; value: string }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "quote"; children: BlockNode[] }
  | { type: "hr" }
  | { type: "table"; header: InlineNode[][]; align: Array<"left" | "center" | "right" | null>; rows: InlineNode[][][] };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): BlockNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // cierre (o fin del texto si el streaming aún no lo trae)
      blocks.push({ type: "code", lang: fence[2], value: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (HR.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", header: header.map(parseInline), align, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ type: "quote", children: parseMarkdown(body.join("\n")) });
      continue;
    }

    const ordered = OL_ITEM.exec(line);
    if (ordered || UL_ITEM.test(line)) {
      const pattern = ordered ? OL_ITEM : UL_ITEM;
      const baseIndent = indentOf(line);
      const raw: Array<{ text: string; nested: string[] }> = [];
      while (i < lines.length) {
        const current = lines[i];
        const match = pattern.exec(current);
        if (match && indentOf(current) <= baseIndent + 1) {
          raw.push({ text: ordered ? match[2] : match[1], nested: [] });
          i++;
          continue;
        }
        // Más indentado que el elemento: le pertenece (sublista o continuación).
        if (raw.length > 0 && current.trim() !== "" && indentOf(current) > baseIndent) {
          raw[raw.length - 1].nested.push(current);
          i++;
          continue;
        }
        break;
      }
      blocks.push({
        type: "list",
        ordered: Boolean(ordered),
        start: ordered ? Number(ordered[1]) : 1,
        items: raw.map(({ text, nested }) => listItem(text, nested)),
      });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !(paragraph.length > 0 && isBlockStart(lines[i]))) {
      paragraph.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].replace(/\t/g, "    ").length;
}

/** Texto del elemento + lo anidado: si hay sublista se parsea como bloques; si no, es continuación del texto. */
function listItem(text: string, nested: string[]): ListItem {
  if (nested.some((line) => UL_ITEM.test(line) || OL_ITEM.test(line))) {
    const indent = Math.min(...nested.map(indentOf));
    return { children: parseInline(text), blocks: parseMarkdown(nested.map((line) => line.slice(indent)).join("\n")) };
  }
  return { children: parseInline([text, ...nested.map((line) => line.trim())].join("\n")), blocks: [] };
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || UL_ITEM.test(line) || OL_ITEM.test(line) || QUOTE.test(line);
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

interface InlineRule {
  pattern: RegExp;
  build(match: RegExpExecArray): InlineNode;
}

// En empate de posición gana la primera regla: el código antes que el
// énfasis (dentro de `**x**` no hay markdown) y ** antes que *.
const INLINE_RULES: InlineRule[] = [
  { pattern: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/, build: (m) => ({ type: "code", value: m[2].trim() || m[2] }) },
  {
    pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    build: (m) => isSafeHref(m[2])
      ? { type: "link", href: m[2], children: parseInline(m[1]) }
      : { type: "text", value: m[0] },
  },
  { pattern: /\*\*(?=\S)([\s\S]*?\S)\*\*/, build: (m) => ({ type: "strong", children: parseInline(m[1]) }) },
  { pattern: /(?<![\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/u, build: (m) => ({ type: "strong", children: parseInline(m[1]) }) },
  { pattern: /~~(?=\S)([\s\S]*?\S)~~/, build: (m) => ({ type: "del", children: parseInline(m[1]) }) },
  { pattern: /\*(?=[^\s*])([^*\n]*?[^\s*])\*/, build: (m) => ({ type: "em", children: parseInline(m[1]) }) },
  // Guion bajo solo en límites de palabra: variable_con_guiones no es cursiva.
  { pattern: /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/u, build: (m) => ({ type: "em", children: parseInline(m[1]) }) },
];

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;
  while (rest.length > 0) {
    let best: { index: number; match: RegExpExecArray; rule: InlineRule } | undefined;
    for (const rule of INLINE_RULES) {
      const match = rule.pattern.exec(rest);
      if (match && (!best || match.index < best.index)) best = { index: match.index, match, rule };
    }
    if (!best) { pushText(nodes, rest); break; }
    if (best.index > 0) pushText(nodes, rest.slice(0, best.index));
    nodes.push(best.rule.build(best.match));
    rest = rest.slice(best.index + best.match[0].length);
  }
  return nodes;
}

/** Texto plano, con los saltos de línea como `br` (así escriben los modelos). */
function pushText(nodes: InlineNode[], value: string): void {
  value.split("\n").forEach((part, index) => {
    if (index > 0) nodes.push({ type: "br" });
    if (!part) return;
    const last = nodes[nodes.length - 1];
    if (last?.type === "text") last.value += part;
    else nodes.push({ type: "text", value: part });
  });
}

export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href);
}

export function renderMarkdown(source: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdown(source)) fragment.append(renderBlock(block, doc));
  return fragment;
}

function renderBlock(block: BlockNode, doc: Document): Node {
  switch (block.type) {
    case "paragraph":
      return withInline(doc.createElement("p"), block.children, doc);
    case "heading":
      // Dentro de una burbuja de chat, h1 como h3: no compite con la página.
      return withInline(doc.createElement(`h${Math.min(block.level + 2, 6)}`), block.children, doc);
    case "code": {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (block.lang) code.dataset.lang = block.lang;
      code.textContent = block.value;
      pre.append(code);
      return pre;
    }
    case "list": {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) (list as HTMLOListElement).start = block.start;
      for (const item of block.items) {
        const li = withInline(doc.createElement("li"), item.children, doc);
        for (const child of item.blocks) li.append(renderBlock(child, doc));
        list.append(li);
      }
      return list;
    }
    case "quote": {
      const quote = doc.createElement("blockquote");
      for (const child of block.children) quote.append(renderBlock(child, doc));
      return quote;
    }
    case "hr":
      return doc.createElement("hr");
    case "table": {
      // Contenedor con scroll propio: una tabla ancha no desborda la burbuja.
      const wrap = doc.createElement("div");
      wrap.className = "md-table";
      const table = doc.createElement("table");
      const headRow = doc.createElement("tr");
      block.header.forEach((cell, index) => headRow.append(cellElement("th", cell, block.align[index], doc)));
      table.append(doc.createElement("thead"), doc.createElement("tbody"));
      table.tHead!.append(headRow);
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        row.forEach((cell, index) => tr.append(cellElement("td", cell, block.align[index], doc)));
        table.tBodies[0].append(tr);
      }
      wrap.append(table);
      return wrap;
    }
  }
}

function cellElement(tag: "th" | "td", children: InlineNode[], align: string | null | undefined, doc: Document): HTMLElement {
  const cell = withInline(doc.createElement(tag), children, doc);
  if (align) cell.style.textAlign = align;
  return cell;
}

function withInline<T extends HTMLElement>(element: T, children: InlineNode[], doc: Document): T {
  for (const child of children) element.append(renderInline(child, doc));
  return element;
}

function renderInline(node: InlineNode, doc: Document): Node {
  switch (node.type) {
    case "text":
      return doc.createTextNode(node.value);
    case "br":
      return doc.createElement("br");
    case "code": {
      const code = doc.createElement("code");
      code.textContent = node.value;
      return code;
    }
    case "strong":
    case "em":
    case "del":
      return withInline(doc.createElement(node.type), node.children, doc);
    case "link": {
      const link = doc.createElement("a");
      link.href = node.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return withInline(link, node.children, doc);
    }
  }
}
