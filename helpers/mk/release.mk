# helpers/mk/release.mk — corte de release (tag alpha incremental)
# Depende de: helpers/mk/common.mk
# Incluir con: include helpers/mk/release.mk
#
# El tag vX.Y.Z-alpha.N es lo que dispara .github/workflows/publish-containers.yml
# (push de tag v*, ver DEC-0063) — cortar un release es crear y pushear este
# tag, nada más; los workflows ya existentes hacen el resto (build multi-arch
# + push a GHCR).

include helpers/mk/common.mk

.PHONY: release-tag
release-tag:
	$(call section,Creando el siguiente tag de release)
	@if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then \
		echo "✗ ERROR: hay cambios sin commitear — commitea o descarta antes de tagear." >&2; \
		exit 1; \
	fi
	@TAG=$$(sh helpers/shell/next-release-tag.sh) && \
	echo "→ Siguiente tag: $$TAG" && \
	git tag -a "$$TAG" -m "Release $$TAG" && \
	git push origin "$$TAG"
	$(call ok,Tag creado y pusheado — ver Actions para publish-containers.yml)
