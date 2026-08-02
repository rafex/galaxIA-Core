# helpers/

Scripts y configuración de orquestación que respaldan `Makefile`/`Justfile`.

## Estructura

```
helpers/
├── mk/            # Fragmentos de Makefile (include desde el Makefile raíz)
├── just/          # Fragmentos de Justfile (import desde el Justfile raíz)
├── scripts/       # Utilidades generales de desarrollo (puertos, certs, versión)
│   ├── shell/
│   └── python/
├── shell/         # Scripts de shell para la construcción/publicación de packages
└── python/        # Scripts Python (uv) para la construcción/publicación de packages
```

`helpers/scripts/` son utilidades de desarrollo local de propósito general (generar `.env`, matar procesos por puerto, certificados TLS). `helpers/shell/` y `helpers/python/` son específicos del proceso de **construcción y publicación de packages** (hoy: `@rafex/galaxia-fhs-protocol` a GitHub Packages) — ver `spec-native/pipelines/CD.md` y `spec-native/DECISIONS.md` DEC-0041.

## `helpers/python/` usa `uv`

Los scripts en esta carpeta llevan metadata inline (PEP 723) y se ejecutan con `uv run helpers/python/<script>.py` — `uv` crea un entorno efímero con las dependencias declaradas en el propio script, sin necesitar un `pyproject.toml`/`venv` persistente ni depender del Python del sistema. Instalar `uv`: https://docs.astral.sh/uv/getting-started/installation/.

## No llamar estos scripts directamente — usar `make`

El `Makefile` raíz es la interfaz pensada para humanos y para CI (`make protocol-bump`, `make protocol-verify`, `make protocol-publish` — ver `make help`). Los scripts en `helpers/shell`/`helpers/python` son detalles de implementación: pueden cambiar de nombre, de firma o de lenguaje sin que cambie el target de `make` que los invoca. `.github/workflows/publish-packages.yml` llama a los targets de `make`, nunca a los scripts directamente.
