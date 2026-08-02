# galaxia-parser-catalog

Catálogo comunitario de **perfiles de parseo tolerante** para respuestas de modelos LLM que no llenan de forma confiable el campo estructurado `tool_calls` (u otro formato de salida estructurada), aunque el modelo sí haya decidido correctamente qué hacer.

## Por qué existe este repo

Motivado por un incidente real documentado en [`galaxIA`](https://github.com/rafex/galaxIA) (DEC-0016/DEC-0017): `qwen2.5-coder-3b-instruct`, servido con `llama-server --jinja`, a veces decide invocar una tool pero escribe el JSON de la llamada como texto plano en `content` en vez de llenar `tool_calls`. La mitigación existía como código hardcodeado y anónimo, local a un único Star (`tryParseFallbackToolCall` en `galaxIA-satellite-star/examples/star-example/src/llm-bridge.ts`) — cualquier otro operador que desplegara el mismo modelo tenía que redescubrir el mismo problema desde cero.

Este repo separa ese conocimiento en un catálogo nombrado, versionado y distribuible, para que:

- Un Star nuevo con un modelo ya catalogado pueda reutilizar el perfil sin escribir su propio parser.
- El comportamiento de un modelo/motor de inferencia quede documentado con su incidente de origen, no perdido en un comentario de código.
- Se pueda medir con el tiempo (trazabilidad + eval) qué tan confiable es cada perfil, y mejorarlo sin tocar el código de ningún Star.

## Qué NO es este repo

Este catálogo **no es parte del protocolo FHS**. `galaxIA` (el protocolo) solo transporta una referencia declarativa — `ModelParserProfile { profileId, registryRef? }`, colgada de `ModelInfo.toolCalling.parserProfile` (ver [`SPEC-PARSER-0001`](https://github.com/rafex/galaxIA/blob/main/spec-native/specs/parser-catalog/SPEC.md) y DEC-0050 en `galaxIA`). El protocolo no sabe ni le importa qué hay dentro de un perfil — mismo principio ya usado para `ArtifactRef` (DEC-0046) y `capability.tags` (DEC-0028): el protocolo transporta la referencia, nunca el motor detrás de ella.

Cualquier Star (de [`galaxIA-satellite-star`](https://github.com/rafex/galaxIA-satellite-star) o de cualquier otra implementación, en cualquier lenguaje) puede consumir este catálogo, mantener su propia copia, o ignorarlo por completo.

## Estructura

```
profiles/           ← fuente humana, un archivo JSON por perfil
schema.sql          ← esquema de catalog.sqlite
catalog.sqlite       ← artefacto compilado, formato de distribución
src/build-db.ts      ← compila profiles/*.json → catalog.sqlite
src/match.ts         ← matcher genérico: encuentra perfil aplicable + aplica su regla
tests/fixtures/      ← ejemplos reales de respuestas de modelo, usados para probar cada perfil
```

## Cómo se define un perfil

Un perfil vive como un archivo `profiles/<id>.json`:

```json
{
  "id": "jinja-plain-json-toolcall-fallback-v1",
  "modelPattern": "^qwen2\\.5-coder.*$",
  "strategy": "plain-json-in-content",
  "rule": {
    "stripCodeFences": true,
    "mustStartWith": "{",
    "validateNameAgainst": "requestedTools[].function.name"
  },
  "notes": "...",
  "sourceIncident": "https://github.com/rafex/galaxIA/blob/main/spec-native/DECISIONS.md#dec-0016"
}
```

- `modelPattern`: regex contra el `model.id` declarado por un Star — determina cuándo aplica este perfil.
- `strategy`: nombre de una estrategia de parseo genérica implementada en `src/match.ts` (hoy: `plain-json-in-content`; futuras: `markdown-fenced-json`, `xml-tool-call`, etc.).
- `rule`: parámetros de esa estrategia — nunca código, solo datos.
- `notes`/`sourceIncident`: documentación humana del comportamiento y su origen.

## Cómo se compila y consume

```sh
npm run build-db   # profiles/*.json → catalog.sqlite
```

Un consumidor (ej. un Star) carga `catalog.sqlite`, busca el perfil cuyo `modelPattern` coincide con su propio `model.id`, y usa `matchProfile`/`tryParse` (`src/match.ts`) para interpretar la regla — sin lógica hardcodeada por modelo en el lado del consumidor.

## Trazabilidad y eval (en progreso)

Cada intento de parseo puede registrarse en `parse_attempts` (ver `schema.sql`) con el `profileId` usado, si hubo match, y un **hash** del contenido (nunca el contenido crudo — el contenido de una respuesta de modelo puede derivar de una pregunta de usuario; guardarlo tal cual violaría el mismo cuidado de retención que `galaxIA` ya aplica en todo el protocolo). Esta trazabilidad es la base para medir con el tiempo la tasa de falsos positivos/negativos de cada perfil — el mecanismo de evaluación sistemático todavía no está diseñado.

## Licencia

MIT — ver `LICENSE`.
