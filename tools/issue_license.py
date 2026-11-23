#!/usr/bin/env python3
"""Issue a NEU159 license on a trusted signing machine."""

import argparse
import base64
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


def parse_expiry(value: str):
    if value.lower() == 'null':
        return None
    expiry = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return expiry.astimezone(timezone.utc).isoformat()


def atomic_write_json(path: Path, document: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            'w', encoding='utf-8', dir=path.parent,
            prefix=f'.{path.name}.', delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(document, temporary_file, indent=2)
            temporary_file.write('\n')
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-key', required=True, type=Path,
                        help='Issuer RSA-3072 private PEM file; keep it off the repo and USB.')
    parser.add_argument('--machine-id', required=True)
    parser.add_argument('--license-id', default='NEU-2026-0001')
    parser.add_argument('--license-type', default='perpetual')
    parser.add_argument('--max-devices', type=int, default=5)
    parser.add_argument('--expires-at', default='null',
                        help='ISO-8601 timestamp or null (default: null).')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()

    if args.max_devices < 0:
        parser.error('--max-devices must be non-negative.')
    if not args.machine_id.strip():
        parser.error('--machine-id must not be empty.')

    try:
        expires_at = parse_expiry(args.expires_at)
        private_key = serialization.load_pem_private_key(
            args.private_key.read_bytes(), password=None
        )
        if not isinstance(private_key, rsa.RSAPrivateKey) or private_key.key_size != 3072:
            parser.error('The issuer key must be RSA-3072.')

        license_data = {
            'product': 'NEU159',
            'license_id': args.license_id,
            'machine_id': args.machine_id,
            'license_type': args.license_type,
            'issued_at': datetime.now(timezone.utc).isoformat(),
            'expires_at': expires_at,
            'max_devices': args.max_devices,
        }
        payload = json.dumps(license_data, sort_keys=True, separators=(',', ':')).encode('utf-8')
        signature_bytes = private_key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
        signature = base64.b64encode(signature_bytes).decode('ascii')
        if '-----BEGIN' in signature:
            parser.error('Refusing to write PEM key material in the signature field.')
        if len(signature_bytes) != 384 or len(signature) != 512:
            parser.error('Generated RSA-3072 signature has an unexpected length.')

        # Verify the generated value before writing it to the requested destination.
        private_key.public_key().verify(
            signature_bytes, payload, padding.PKCS1v15(), hashes.SHA256()
        )
        document = {'license': license_data, 'signature': signature}
        atomic_write_json(args.out, document)
        print(f'Wrote signed NEU159 license to {args.out}')
        return 0
    except SystemExit:
        raise
    except Exception as exc:
        parser.error(f'Could not issue license: {exc}')
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
