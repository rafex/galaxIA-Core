//! Atlas FHS en Rust — bootstrap puro (`apps/atlas`, DEC-0088).
//!
//! Un nodo al que todos se conectan primero: Kademlia en modo servidor (guarda
//! los beacons del DHT), GossipSub suscrito a todos los temas FHS para
//! reenviarlos entre nodos que no están conectados entre sí, anuncio mDNS en
//! la LAN y una API HTTPS mínima (`/health`, `/status`) con el formato del TS.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{extract::State, routing::get, Json, Router};
use galaxia_fhs::p2p::{
    identity::NodeIdentity,
    node::{self, NodeConfig, NodeHandle, Role},
    tls,
};
use libp2p::Multiaddr;
use serde_json::{json, Value};

const FHS_VERSION: &str = "0.1";

struct Config {
    identity_path: PathBuf,
    listen: Vec<Multiaddr>,
    bootstrap: Vec<Multiaddr>,
    tls_cert: PathBuf,
    tls_key: PathBuf,
    extra_ca: Vec<PathBuf>,
    host: String,
    port: u16,
    mdns: bool,
    commit: String,
    build_date: String,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn multiaddrs(name: &str, default: &[&str]) -> Result<Vec<Multiaddr>, String> {
    let items: Vec<String> = match var(name) {
        Some(value) => value
            .split([',', '\n'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        None => default.iter().map(|s| s.to_string()).collect(),
    };
    items
        .into_iter()
        .map(|item| item.parse().map_err(|e| format!("{name}: {item}: {e}")))
        .collect()
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let (Some(tls_cert), Some(tls_key)) = (var("TLS_CERT_PATH"), var("TLS_KEY_PATH")) else {
            return Err(
                "Atlas requiere TLS_CERT_PATH y TLS_KEY_PATH; la API de observabilidad no admite HTTP"
                    .into(),
            );
        };
        let tls_cert = PathBuf::from(tls_cert);
        let mut extra_ca: Vec<PathBuf> = var("NODE_EXTRA_CA_CERTS")
            .map(PathBuf::from)
            .into_iter()
            .collect();
        if !extra_ca.contains(&tls_cert) {
            extra_ca.push(tls_cert.clone());
        }
        Ok(Self {
            identity_path: PathBuf::from(
                var("IDENTITY_KEY_PATH").unwrap_or_else(|| "./.fhs-identity-atlas.json".into()),
            ),
            listen: multiaddrs("FHS_LISTEN_ADDRS", &["/ip4/0.0.0.0/tcp/4001/tls/ws"])?,
            bootstrap: multiaddrs("FHS_BOOTSTRAP_ADDRS", &[])?,
            tls_cert,
            tls_key: PathBuf::from(tls_key),
            extra_ca,
            host: var("HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: match var("PORT") {
                Some(port) => port
                    .parse()
                    .map_err(|_| format!("PORT: {port} no es un puerto"))?,
                None => 8081,
            },
            mdns: var("MDNS_ENABLED").as_deref() != Some("false"),
            commit: var("COMMIT_HASH")
                .unwrap_or_else(|| option_env!("GALAXIA_COMMIT").unwrap_or("dev").into()),
            build_date: var("BUILD_DATE").unwrap_or_default(),
        })
    }
}

#[derive(Clone)]
struct AppState {
    node: NodeHandle,
    commit: Arc<str>,
    build_date: Arc<str>,
}

#[tokio::main]
async fn main() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    if let Err(error) = run().await {
        tracing::error!("[atlas] {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = Config::from_env()?;
    let identity =
        NodeIdentity::load_or_create(&config.identity_path).map_err(|e| e.to_string())?;
    tracing::info!(
        "Atlas P2P · DID: {} · PeerId: {}",
        identity.did,
        identity.peer_id
    );
    let trust: Vec<&Path> = config.extra_ca.iter().map(|p| p.as_path()).collect();
    let tls = tls::websocket_config(Some(&config.tls_cert), Some(&config.tls_key), &trust)
        .map_err(|e| e.to_string())?;
    let node = node::start(NodeConfig {
        role: Role::Bootstrap,
        agent_version: format!("galaxia-atlas/{}", env!("CARGO_PKG_VERSION")),
        identity: identity.clone(),
        listen: config.listen.clone(),
        announce: vec![],
        bootstrap: config.bootstrap.clone(),
        tls,
        advertise: None,
        dht_beacon: None,
    })
    .map_err(|e| e.to_string())?;

    let _mdns = if config.mdns {
        // Las direcciones de escucha tardan un momento en aparecer.
        tokio::time::sleep(Duration::from_secs(1)).await;
        match announce_mdns(&identity.did, &node.own_addrs(), port_of(&config.listen)) {
            Ok(daemon) => {
                tracing::info!("anunciando Atlas por mDNS (_fhs-atlas._tcp)");
                Some(daemon)
            }
            Err(error) => {
                tracing::warn!("sin anuncio mDNS: {error}");
                None
            }
        }
    } else {
        None
    };

    let state = AppState {
        node,
        commit: config.commit.into(),
        build_date: config.build_date.into(),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .with_state(state);
    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .map_err(|e| format!("HOST/PORT: {e}"))?;
    let rustls_config =
        axum_server::tls_rustls::RustlsConfig::from_pem_file(&config.tls_cert, &config.tls_key)
            .await
            .map_err(|e| format!("certificado de la API: {e}"))?;
    let handle = axum_server::Handle::new();
    tokio::spawn({
        let handle = handle.clone();
        async move {
            shutdown_signal().await;
            tracing::info!("apagando Atlas");
            handle.graceful_shutdown(Some(Duration::from_secs(5)));
        }
    });
    tracing::info!("API de observabilidad HTTPS en https://{addr}");
    axum_server::bind_rustls(addr, rustls_config)
        .handle(handle)
        .serve(app.into_make_service())
        .await
        .map_err(|e| e.to_string())
}

/// Mismo formato que `/health` del Atlas TS.
async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "fhsVersion": FHS_VERSION,
        "version": &*state.commit,
        "buildDate": &*state.build_date,
        "did": state.node.identity.did,
        "multiaddrs": state.node.own_addrs(),
        "runtime": "galaxia-atlas",
    }))
}

/// `/status` del Atlas TS (`peers` y `peerCount` los leen `doctor.sh` y los
/// scripts de verificación), más `knownPeers`: los anuncios que reenvía.
async fn status(State(state): State<AppState>) -> Json<Value> {
    let Some(status) = state.node.status().await else {
        return Json(json!({ "error": "el nodo libp2p se detuvo" }));
    };
    let peers: BTreeSet<&str> = status.connections.iter().map(|c| c.peer.as_str()).collect();
    Json(json!({
        "peers": peers,
        "peerCount": status.peer_count,
        "did": state.node.identity.did,
        "peerId": status.peer_id,
        "connections": status.connections,
        "pubsub": status.pubsub,
        "knownPeers": state.node.peers.known_peers(),
    }))
}

fn port_of(listen: &[Multiaddr]) -> u16 {
    listen
        .iter()
        .find_map(|addr| {
            addr.iter().find_map(|p| match p {
                libp2p::multiaddr::Protocol::Tcp(port) if port != 0 => Some(port),
                _ => None,
            })
        })
        .unwrap_or(4001)
}

/// `_fhs-atlas._tcp` con `did` y `addrs` en el TXT (SPEC-P2P-0001), como el
/// `bonjour-service` del TS. La autenticación real es Noise, no el TXT.
fn announce_mdns(did: &str, addrs: &[String], port: u16) -> Result<mdns_sd::ServiceDaemon, String> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    let host = format!(
        "{}.local.",
        var("HOSTNAME").unwrap_or_else(|| "fhs-atlas".into())
    );
    let joined = addrs.join(",");
    let properties = [
        ("fhsVersion", "p2p-alpha"),
        ("did", did),
        ("addrs", joined.as_str()),
    ];
    let info = mdns_sd::ServiceInfo::new(
        "_fhs-atlas._tcp.local.",
        "fhs-atlas",
        &host,
        "",
        port,
        &properties[..],
    )
    .map_err(|e| e.to_string())?
    .enable_addr_auto();
    daemon.register(info).map_err(|e| e.to_string())?;
    Ok(daemon)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mdns_port_comes_from_the_listen_address() {
        let listen: Vec<Multiaddr> = vec!["/ip4/0.0.0.0/tcp/4001/tls/ws".parse().unwrap()];
        assert_eq!(port_of(&listen), 4001);
        assert_eq!(port_of(&[]), 4001);
    }
}
