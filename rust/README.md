# Servicios de galaxIA-Core en Rust

Sobre el crate `galaxia-fhs` de [galaxIA-SDK](https://github.com/rafex/galaxIA-SDK/tree/main/rust).

## Atlas (`galaxia-atlas`)

Reemplazo de `apps/atlas`: bootstrap puro. Kademlia en modo servidor (guarda
los beacons del DHT), GossipSub suscrito a todos los temas FHS para
reenviarlos, anuncio mDNS `_fhs-atlas._tcp` y API HTTPS con `/health` y
`/status` en el formato del TS (más `knownPeers`). Lee la identidad del
volumen `atlas-data` en el formato de `fhs-node` (`{"key": …}`), así conserva
su PeerId.

Variables: `IDENTITY_KEY_PATH`, `FHS_LISTEN_ADDRS` (default
`/ip4/0.0.0.0/tcp/4001/tls/ws`), `TLS_CERT_PATH` y `TLS_KEY_PATH`
(obligatorias), `NODE_EXTRA_CA_CERTS`, `HOST`, `PORT` (8081), `MDNS_ENABLED`.

```sh
cd rust
cargo clippy --all-targets -- -D warnings && cargo test
podman build -f Containerfile -t galaxia-atlas-rs .
```
