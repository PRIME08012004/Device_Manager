#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 /secure/off-repo/signing-directory" >&2
    exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
output_dir="$(realpath -m -- "$1")"

case "$output_dir/" in
    "$repo_root/"*|/run/media/*|/media/*|/mnt/*|/Volumes/*)
        echo "Refusing to create a private key in the repo or a removable-media location." >&2
        exit 1
        ;;
esac

private_key="$output_dir/issuer_private.pem"
public_key="$output_dir/issuer_public.pem"
if [[ -e "$private_key" || -e "$public_key" ]]; then
    echo "Refusing to overwrite an existing key file in $output_dir." >&2
    exit 1
fi

mkdir -p -- "$output_dir"
umask 077
openssl genrsa -out "$private_key" 3072
openssl rsa -in "$private_key" -pubout -out "$public_key"
chmod 600 "$private_key"

echo "Created a new RSA-3072 issuer key pair in $output_dir."
echo "Keep issuer_private.pem on the trusted signing machine; never copy it into the repo or onto the USB."
echo "The public key is issuer_public.pem; embed that public key in app.py."
