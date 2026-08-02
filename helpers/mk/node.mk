# helpers/mk/node.mk — targets de build Node.js / npm workspaces
# Depende de: helpers/mk/common.mk
# Incluir con: include helpers/mk/node.mk

include helpers/mk/common.mk

.PHONY: install
install:
	$(call section,Instalando dependencias)
	npm ci
	$(call ok,Dependencias instaladas)

.PHONY: build
build: build-atlas build-agent build-web
	$(call ok,Build completo terminado)

.PHONY: build-atlas
build-atlas:
	$(call info,Compilando atlas)
	npm run build -w $(WS_ATLAS)
	$(call ok,atlas compilado)

.PHONY: build-agent
build-agent:
	$(call info,Compilando navigator)
	npm run build -w $(WS_AGENT)
	$(call ok,navigator compilado)

.PHONY: build-web
build-web:
	$(call info,Compilando portal)
	npm run build -w $(WS_WEB)
	$(call ok,portal compilado)

.PHONY: typecheck
typecheck:
	$(call section,Typecheck)
	npm run typecheck --workspaces
	$(call ok,Typecheck pasado)

.PHONY: lint
lint:
	$(call section,Lint)
	npm run lint --workspaces
	$(call ok,Lint pasado)

.PHONY: clean
clean:
	$(call section,Limpiando artefactos)
	@for ws in $(WS_ALL); do \
		printf "$(C_BLUE)[CLEAN]$(C_RESET) $$ws\n"; \
		rm -rf $$ws/dist $$ws/.tsbuildinfo 2>/dev/null || true; \
	done
	rm -rf node_modules/.cache 2>/dev/null || true
	$(call ok,Artefactos eliminados)
