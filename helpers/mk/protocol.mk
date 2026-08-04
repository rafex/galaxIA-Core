# helpers/mk/protocol.mk — automatización de publicación de los 3 paquetes
# distribuibles (@rafex/galaxia-atlas, @rafex/galaxia-navigator,
# @rafex/galaxia-portal-chat) a GitHub Packages.
# Depende de: helpers/mk/common.mk, helpers/mk/node.mk
# Incluir con: include helpers/mk/protocol.mk
#
# NOTA: @rafex/galaxia-fhs-protocol y los paquetes satellite-capabilities*
# migraron a galaxIA-SDK (2026-08-02, DEC-0085). Sus targets se eliminaron de
# este Makefile — ver galaxIA-SDK/Makefile para sus equivalentes.

include helpers/mk/common.mk

.PHONY: atlas-bump-check atlas-bump atlas-verify atlas-publish
atlas-bump-check:
	$(call section,Verificando si hace falta subir la versión de @rafex/galaxia-atlas)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=\$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py apps/atlas --check

atlas-bump:
	$(call section,Subiendo versión de @rafex/galaxia-atlas si ya está publicada)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=\$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py apps/atlas
	$(call ok,Bump de versión completo (o no hacía falta))

atlas-verify:
	$(call section,Verificando contenido del paquete de atlas)
	@npm run build -w packages/fhs-node
	@sh helpers/shell/verify-package.sh apps/atlas
	$(call ok,Paquete verificado)

atlas-publish: atlas-bump atlas-verify
	$(call section,Publicando @rafex/galaxia-atlas a GitHub Packages)
	npm publish -w apps/atlas
	$(call ok,Publicado)

.PHONY: navigator-bump-check navigator-bump navigator-verify navigator-publish
navigator-bump-check:
	$(call section,Verificando si hace falta subir la versión de @rafex/galaxia-navigator)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=\$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py apps/navigator --check

navigator-bump:
	$(call section,Subiendo versión de @rafex/galaxia-navigator si ya está publicada)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=\$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py apps/navigator
	$(call ok,Bump de versión completo (o no hacía falta))

navigator-verify:
	$(call section,Verificando contenido del paquete de navigator)
	@npm run build -w packages/fhs-node
	@sh helpers/shell/verify-package.sh apps/navigator
	$(call ok,Paquete verificado)

navigator-publish: navigator-bump navigator-verify
	$(call section,Publicando @rafex/galaxia-navigator a GitHub Packages)
	npm publish -w apps/navigator
	$(call ok,Publicado)

.PHONY: portal-chat-bump-check portal-chat-bump portal-chat-verify portal-chat-publish
portal-chat-bump-check:
	$(call section,Verificando si hace falta subir la versión de @rafex/galaxia-portal-chat)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=\$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py apps/portal-chat --check

portal-chat-bump:
	$(call section,Subiendo versión de @rafex/galaxia-portal-chat si ya está publicada)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=\$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py apps/portal-chat
	$(call ok,Bump de versión completo (o no hacía falta))

portal-chat-verify:
	$(call section,Verificando contenido del paquete de portal-chat)
	@sh helpers/shell/verify-package.sh apps/portal-chat
	$(call ok,Paquete verificado)

portal-chat-publish: portal-chat-bump portal-chat-verify
	$(call section,Publicando @rafex/galaxia-portal-chat a GitHub Packages)
	npm publish -w apps/portal-chat
	$(call ok,Publicado)
