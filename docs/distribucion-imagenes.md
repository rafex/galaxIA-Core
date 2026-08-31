# Distribución de imágenes de contenedor

Cada componente de galaxIA se empaqueta como imagen de contenedor Alpine (`node:24-alpine`) para poder instalarse y replicarse en cualquier máquina sin compilar el código localmente.

## Componentes

| Imagen | Base | Puertos | Host recomendado |
|--------|------|---------|-----------------|
| `galaxia-atlas` | node:24-alpine | 8081, 4001 | Bastion |
| `galaxia-navigator` | node:24-alpine | 8090, 4010 | Bastion |
| `galaxia-portal-chat` | nginx:alpine | 443 | Bastion / Laptop |
| `galaxia-log-agent` | node:24-alpine | — | Bastion |
| `galaxia-star` | node:24-alpine | 4002 | Bastion / Raspi4B |
| `galaxia-satellite-ocr` | **node:24-bookworm** | 4003 | Raspi4B |
| `galaxia-kb-provider` | node:24-alpine | 4006 | cualquiera |
| `galaxia-rag-provider` | node:24-alpine | 4005 | cualquiera |

> `satellite-ocr` usa Debian porque Tesseract OCR (`poppler-utils`, `tesseract-ocr-spa`) no tiene paquetes Alpine estables.

Las imágenes de `galaxIA-Core` se gestionan desde este repo. Las de `galaxIA-satellite-star` desde ese repo.

---

## Build local

### galaxIA-Core (atlas, navigator, portal-chat, log-agent)

```bash
cd galaxIA-Core

# Build de todas las imágenes (tag: latest)
bash containers/build-images.sh

# Tag específico
bash containers/build-images.sh --tag v0.2.0
```

Con Make:

```bash
make images-build
make images-build TAG=v0.2.0
```

### galaxIA-satellite-star (star, satellite-ocr, kb-provider, rag-provider)

```bash
cd galaxIA-satellite-star

# GH_TOKEN requerido para kb-provider y rag-provider (paquetes GitHub Packages)
export GH_TOKEN="$(gh auth token)"

bash containers/build-images.sh

# Solo una imagen
bash containers/build-images.sh --only galaxia-star
```

---

## Push a GHCR

Las imágenes se publican en `ghcr.io/rafex/galaxia-<nombre>`.

```bash
# Login una vez
echo "$GITHUB_TOKEN" | podman login ghcr.io -u rafex --password-stdin

# Build + push
export GITHUB_TOKEN="..."
bash containers/build-images.sh --push --tag v0.2.0
```

Con Make:

```bash
make images-push TAG=v0.2.0
```

---

## Correr desde GHCR (sin clonar el repo)

### galaxIA-Core en Bastion

```bash
GALAXIA_VERSION=latest
FHS_BOOTSTRAP_ADDRS=""   # vacio en atlas; para navigator poner la multiaddr de atlas

# Descargar el compose de release
curl -O https://raw.githubusercontent.com/rafex/galaxIA-Core/main/containers/compose.release.yaml

# Levantar
GALAXIA_VERSION=$GALAXIA_VERSION \
  podman-compose -f compose.release.yaml up -d
```

### galaxIA-satellite-star en Bastion / Raspi4B

```bash
curl -O https://raw.githubusercontent.com/rafex/galaxIA-satellite-star/main/containers/compose.release.yaml

export FHS_BOOTSTRAP_ADDRS=/ip4/192.168.3.175/tcp/4001/tls/ws
export CERTS_DIR=/home/rafex/certs

podman-compose -f compose.release.yaml up -d star
# o solo OCR en Raspi4B:
podman-compose -f compose.release.yaml up -d satellite-ocr
```

---

## Exportar a .tar.gz (deploy sin registro)

Útil para Raspi4B sin acceso a internet o GHCR.

```bash
# En la máquina de build
bash containers/build-images.sh --export --tag latest
# → dist/images/galaxia-star-latest.tar.gz, etc.

# Copiar al host destino
scp dist/images/galaxia-star-latest.tar.gz raspi4b:~

# En Raspi4B
podman load < ~/galaxia-star-latest.tar.gz
podman run -d --name fhs-star \
  --network host \
  -v star-data:/data \
  -e FHS_BOOTSTRAP_ADDRS=/ip4/192.168.3.175/tcp/4001/tls/ws \
  -e LLAMA_CPP_URL=http://127.0.0.1:43110/v1 \
  -e TLS_CERT_PATH=/certs/e2e.crt \
  -e TLS_KEY_PATH=/certs/e2e.key \
  -e NODE_EXTRA_CA_CERTS=/certs/e2e.crt \
  -v /home/rafex/certs:/certs:ro \
  ghcr.io/rafex/galaxia-star:latest
```

> `--network host` es obligatorio, no opcional — ver la sección **Redes: hairpin NAT** más abajo.

Con Make (scp + podman load automático):

```bash
make images-export
make images-load HOST=raspi4b
```

---

## Redes: hairpin NAT en podman rootless

Todos los nodos FHS P2P (`atlas`, `navigator`, `star`, `satellite-ocr`,
`kb-provider`, `rag-provider`) corren con **`--network host`** (o
`network_mode: host` en los compose) en vez de publicar puertos con `-p`.

**Por qué:** Atlas siempre anuncia al swarm su IP externa real (la necesitan
los peers de otros hosts para encontrarlo). En podman rootless
(pasta/slirp4netns), un contenedor **no puede** alcanzar a otro contenedor
del **mismo host** marcando esa IP externa publicada — es hairpin NAT, y las
implementaciones de red rootless no lo soportan. El síntoma es
`PublishError.NoPeersSubscribedToTopic` sostenido en los logs de GossipSub
(no un error de TLS, ni de bootstrap: el `podman logs` de Atlas incluso puede
no mostrar nada raro) — se confirma consultando `curl -sk https://<atlas>:8081/status`:
los peers del mismo host que Atlas simplemente no aparecen en la lista,
mientras que los peers de otros hosts sí.

Con `--network host` el contenedor usa la interfaz de red real del host — sin
NAT de por medio — y el problema desaparece sin importar si el peer termina
en el mismo host que Atlas o en otro. Detalle completo: `E2E-023` en
[`historial-incidencias-e2e.md`](historial-incidencias-e2e.md).

---

## Multi-arquitectura (ARM64 para Raspi4B + x86_64)

### Opción A — Build nativo en Raspi4B (recomendado, más simple)

```bash
# En Raspi4B directamente:
git clone https://github.com/rafex/galaxIA-satellite-star.git
cd galaxIA-satellite-star
bash containers/build-images.sh --only galaxia-satellite-ocr
# el build corre nativamente en ARM64
```

### Opción B — Cross-compile desde x86_64 (requiere qemu-user-static)

```bash
# Instalar emulación ARM en el host
sudo apt-get install -y qemu-user-static
podman run --rm --privileged multiarch/qemu-user-static --reset -p yes

# Build multi-arch + push (las dos plataformas en una imagen)
bash containers/build-images.sh \
  --arch linux/amd64,linux/arm64 \
  --push \
  --tag v0.2.0
```

---

## Variables de entorno de referencia

| Variable | Componente | Descripción |
|----------|-----------|-------------|
| `GALAXIA_VERSION` | todos | Tag de la imagen GHCR (`latest` o `v0.x.y`) |
| `FHS_BOOTSTRAP_ADDRS` | star, navigator, ocr, rag, kb | Multiaddr de Atlas: `/ip4/<IP>/tcp/4001/tls/ws` |
| `FHS_ANNOUNCE_ADDRS` | star, navigator, ocr | Multiaddr que anuncia al swarm (importante en pasta) |
| `LLAMA_CPP_URL` | star | URL base de llama-server. Con `--network host`: `http://127.0.0.1:43110/v1` |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | todos | Certificado TLS para libp2p WSS |
| `NODE_EXTRA_CA_CERTS` | todos | CA raíz para que Node confíe en el certificado |
| `CERTS_DIR` | compose | Directorio local con los certificados a montar en `/certs` |
| `GH_TOKEN` | kb-provider, rag-provider | Token para descargar paquetes de GitHub Packages durante el build |
| `GITHUB_TOKEN` | script push | Token para publicar imágenes en GHCR |
