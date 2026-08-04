#!/bin/sh
set -eu

config_path=/usr/share/nginx/html/p2p-config.json
bootstrap_addrs=$(printf '%s' "${FHS_NAVIGATOR_BOOTSTRAP_ADDRS:-}" | tr '\n' ',')

# The value is configuration, not an arbitrary document. Reject JSON control
# characters that this small POSIX entrypoint cannot safely escape instead of
# emitting an invalid or surprising runtime config.
case "$bootstrap_addrs" in
  *'"'*|*'\\'*)
    echo "FHS_NAVIGATOR_BOOTSTRAP_ADDRS contiene caracteres JSON no permitidos" >&2
    exit 1
    ;;
esac

printf '{"navigatorBootstrapAddrs":"%s"}\n' "$bootstrap_addrs" > "$config_path"
