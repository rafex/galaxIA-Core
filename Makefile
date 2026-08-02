# galaxIA — Makefile de construcción
# Responsabilidad: producir artefactos (build, clean, install, typecheck)
# Para orquestación de servicios: usar just (ver Justfile)

include helpers/mk/common.mk
include helpers/mk/node.mk
include helpers/mk/container.mk
include helpers/mk/protocol.mk
include helpers/mk/release.mk

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "$(C_CYAN)$(C_BOLD)galaxIA — Makefile de construcción$(C_RESET)"
	@echo ""
	@echo "$(C_BOLD)Construcción:$(C_RESET)"
	@echo "  make build              Build completo (atlas + navigator + portal)"
	@echo "  make build-atlas        Solo atlas"
	@echo "  make build-agent        Solo navigator"
	@echo "  make build-web          Solo portal (frontend)"
	@echo ""
	@echo "$(C_BOLD)Verificación:$(C_RESET)"
	@echo "  make typecheck          TypeScript typecheck en todos los workspaces"
	@echo "  make lint               Lint en todos los workspaces"
	@echo ""
	@echo "$(C_BOLD)Utilidades:$(C_RESET)"
	@echo "  make install            npm ci"
	@echo "  make clean              Eliminar dist/ en todos los workspaces"
	@echo ""
	@echo "$(C_BOLD)Contenedores:$(C_RESET)"
	@echo "  make container-build    Construir imágenes"
	@echo "  make container-up       Levantar contenedores"
	@echo "  make container-down     Detener contenedores"
	@echo "  make container-logs     Ver logs de contenedores"
	@echo "  make container-restart  Reiniciar contenedores"
	@echo ""
	@echo "$(C_BOLD)Paquetes npm (GitHub Packages):$(C_RESET)"
	@echo "  make atlas-publish        @rafex/galaxia-atlas: bump + verify + npm publish"
	@echo "  make navigator-publish    @rafex/galaxia-navigator: bump + verify + npm publish"
	@echo "  make portal-chat-publish  @rafex/galaxia-portal-chat: bump + verify + npm publish"
	@echo "  (cada uno también tiene -bump-check/-bump/-verify por separado, requiere GH_TOKEN)"
	@echo "  fhs-protocol → ver galaxIA-SDK (migrado 2026-08-02)"
	@echo ""
	@echo "$(C_BOLD)Release (GHCR):$(C_RESET)"
	@echo "  make release-tag        Crea y pushea el siguiente tag vX.Y.Z-alpha.N (dispara publish-containers.yml)"
	@echo ""
	@echo "$(C_BOLD)Orquestación:$(C_RESET) usar $(C_CYAN)just$(C_RESET) (ver Justfile o ejecutar 'just --list')"
