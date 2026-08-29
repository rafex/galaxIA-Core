# helpers/mk/container.mk — targets de contenedores Podman/Docker
# Depende de: helpers/mk/common.mk
# Incluir con: include helpers/mk/container.mk

include helpers/mk/common.mk

.PHONY: container-build
container-build:
	$(call section,Construyendo imágenes)
	$(COMPOSE_CMD) -f $(COMPOSE_FILE) build
	$(call ok,Imágenes construidas)

.PHONY: container-up
container-up:
	$(call section,Levantando todos los contenedores)
	$(COMPOSE_CMD) -f $(COMPOSE_FILE) up -d --build
	$(call ok,Contenedores arriba)

.PHONY: container-up-core
container-up-core:
	$(call section,Levantando atlas + navigator + portal-chat)
	$(COMPOSE_CMD) -f $(COMPOSE_FILE) up -d --build atlas navigator portal-chat
	$(call ok,Core arriba)

.PHONY: container-up-atlas
container-up-atlas:
	$(call section,Levantando atlas (Registry))
	$(COMPOSE_CMD) -f $(COMPOSE_FILE) up -d --build atlas
	$(call ok,Atlas arriba)

# Los providers de referencia (star, satellite-ocr, rag-provider,
# kb-provider) ya no viven en este repo — se levantan desde el
# containers/compose.yaml de `galaxIA-satellite-star`.

.PHONY: container-down
container-down:
	$(call section,Deteniendo todos los contenedores)
	$(COMPOSE_CMD) -f $(COMPOSE_FILE) down
	$(call ok,Contenedores detenidos)

.PHONY: container-logs
container-logs:
	$(COMPOSE_CMD) -f $(COMPOSE_FILE) logs -f

.PHONY: container-ps
container-ps:
	$(COMPOSE_CMD) -f $(COMPOSE_FILE) ps

.PHONY: container-restart
container-restart: container-down container-up

# ── Distribución de imágenes ─────────────────────────────────────────────────
# Requiere: GITHUB_TOKEN (push), GH_TOKEN (build con paquetes privados)
# Uso: make images-build [TAG=v0.2.0] [ARCH=linux/amd64,linux/arm64]

IMAGE_TAG  ?= latest
IMAGE_ARCH ?=

.PHONY: images-build
images-build:
	$(call section,Construyendo imágenes (tag=$(IMAGE_TAG)))
	bash containers/build-images.sh --tag $(IMAGE_TAG) $(if $(IMAGE_ARCH),--arch $(IMAGE_ARCH),)
	$(call ok,Build completado)

.PHONY: images-push
images-push:
	$(call section,Build + push a GHCR (tag=$(IMAGE_TAG)))
	bash containers/build-images.sh --tag $(IMAGE_TAG) --push $(if $(IMAGE_ARCH),--arch $(IMAGE_ARCH),)
	$(call ok,Push completado)

.PHONY: images-export
images-export:
	$(call section,Exportando imágenes a dist/images/)
	bash containers/build-images.sh --tag $(IMAGE_TAG) --export
	$(call ok,Archivos tar.gz en dist/images/)

.PHONY: images-load
images-load:
	$(call section,Cargando imágenes en $(HOST))
	@if [ -z "$(HOST)" ]; then echo "Uso: make images-load HOST=raspi4b"; exit 1; fi
	@for f in dist/images/*.tar.gz; do \
	  echo "  → $$f"; \
	  cat "$$f" | ssh $(HOST) "podman load"; \
	done
	$(call ok,Imágenes cargadas en $(HOST))
