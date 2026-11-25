from flask import Flask, request, jsonify, send_file, render_template
from datetime import datetime
import os
import pytz
import toml
import subprocess
import io
import re
import bisect
import json
import socket
import paho.mqtt.client as mqtt
import threading
import time
import base64
import binascii
import hashlib
import platform
import tempfile
from pathlib import Path
from contextlib import contextmanager

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.exceptions import InvalidSignature

from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_prefix=1)

IST = pytz.timezone('Asia/Kolkata')
CONFIG_DIR = os.path.join(os.path.dirname(__file__), 'configs')
SYSTEMD_DIR = '/etc/systemd/system'
add_lock = threading.Lock()

# Optional MQTT broker credentials (leave empty if Mosquitto allows anonymous local connections)
MQTT_HOST = os.environ.get('MQTT_HOST', '127.0.0.1')
MQTT_PORT = int(os.environ.get('MQTT_PORT', '1883'))
MQTT_USER = os.environ.get('MQTT_USER', 'neutron')
MQTT_PASS = os.environ.get('MQTT_PASS', 'neutron')

if not os.path.exists(CONFIG_DIR):
    os.makedirs(CONFIG_DIR)

MODBUS_CONFIG = os.path.join(os.path.dirname(__file__), 'modbus_config.json')

MIB_UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'mibs')
if not os.path.exists(MIB_UPLOAD_DIR):
    os.makedirs(MIB_UPLOAD_DIR)


# ===== LICENSING =====
PRODUCT = 'NEU159'
LICENSE_PATH = os.environ.get(
    'NEU_LICENSE_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'license.json'),
)
# A valid installed USB license is required before application features are served.
LICENSE_ENFORCEMENT_ENABLED = True
USB_DIR_NAME = 'NEU159_USB'
MAX_LICENSE_BYTES = 100_000
NAME_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
_USB_SCAN_LOCK = threading.Lock()
# The previous public key was retired because its private counterpart was exposed.
PUBLIC_KEY_PEM = '''-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA8LigMfrW/2uGR1H42dWv
JFx4mJ41Bs1GKBnd0QZnAGoMv1PrY2af87XQKIS2s4fGDEhcdLFYyFumYLWcTPYz
Lc3nMCUHFQxAs/rRPmEUWCHomgEYi6phqwHLI2dZFjJsBf2dRK1guu5++4dF4uO6
WIxDSxxRZ/Axy6GkrhFcfwrBu16S2j2zAb2GNx9sAwf1Ebw2eBrbtWqVwSu3Utba
b9NJBZLJDAV30yg2SbDS89PZwqqcTsSQ4n1SxSThjGvkgvFLiP06pcnnytuMQZG7
m2GBU0NMS/L1Ps6KP40H/K4B0QYbPjQsZMXGzrcrq+b3e3PTlG8r2zxsHr9awzLC
uugFq+tYjeDLg02lDtbGyqyyCMSj693H34j+xiCXY0SowwDYbOmEcb91lCt6V46s
hMADXYfyrdnk2QPm+1PXp+/px1cJlQoUNWSiPvW+R0n3hdWeQ4kPvnKV4J+0hjNZ
o4SqWYAQh7K8+wHSeKhmHxiQi8/b3v6rWtDyzDnCEbDnAgMBAAE=
-----END PUBLIC KEY-----'''


def machine_id() -> str:
    """Read the host ID used to bind a license to this controller."""
    for path in ('/etc/machine-id', '/var/lib/dbus/machine-id'):
        try:
            return Path(path).read_text(encoding='utf-8').rstrip('\r\n')
        except OSError:
            continue
    return ''


def machine_id_enforcement_enabled() -> bool:
    """Read machine-ID enforcement at verification time for deployments/tests."""
    return os.environ.get('NEU_ENFORCE_MACHINE_ID', 'false').lower() in ('1', 'true', 'yes')


def verify_doc(doc: dict) -> dict:
    """Verify the signed license document and its controller-specific claims."""
    if not isinstance(doc, dict):
        raise ValueError('License document must be a JSON object.')
    missing = {'license', 'signature'} - set(doc)
    if missing:
        missing_key = sorted(missing)[0]
        raise ValueError(f'License document is missing the {missing_key!r} key.')
    extra = set(doc) - {'license', 'signature'}
    if extra:
        raise ValueError(f'License document has unexpected top-level key(s): {", ".join(sorted(extra))}.')
    if not isinstance(doc['license'], dict):
        raise ValueError('License "license" value must be an object.')
    license_data = doc['license']
    signature = doc.get('signature')
    if not isinstance(signature, str):
        raise ValueError('License "signature" value must be a base64 string.')
    if 'PRIVATE KEY' in signature or '-----BEGIN' in signature:
        raise ValueError('The signature field contains a PEM private key, not a license signature.')
    try:
        public_key = serialization.load_pem_public_key(PUBLIC_KEY_PEM.encode('ascii'))
        if not isinstance(public_key, rsa.RSAPublicKey) or public_key.key_size != 3072:
            raise ValueError('Issuer public key must be RSA-3072.')
        payload = json.dumps(license_data, sort_keys=True, separators=(',', ':')).encode('utf-8')
        try:
            signature_bytes = base64.b64decode(signature, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError('License signature is not valid base64.') from exc
        if len(signature_bytes) != public_key.key_size // 8:
            raise ValueError('License signature has the wrong length for the issuer key.')
        public_key.verify(
            signature_bytes,
            payload,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except InvalidSignature as exc:
        raise ValueError('License signature does not match the license contents.') from exc
    except (TypeError, ValueError) as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError('License signature or public key is malformed.') from exc
    except Exception as exc:
        raise ValueError(f'Unable to verify license: {exc}') from exc

    if license_data.get('product') != PRODUCT:
        raise ValueError(f'License product must be {PRODUCT}.')
    host_id = machine_id()
    if machine_id_enforcement_enabled() and (not host_id or license_data.get('machine_id') != host_id):
        raise ValueError('License is for a different machine.')
    max_devices = license_data.get('max_devices')
    if isinstance(max_devices, bool) or not isinstance(max_devices, int) or max_devices < 0:
        raise ValueError('License max_devices must be a non-negative integer.')
    expires_at = license_data.get('expires_at')
    if expires_at:
        try:
            expiry = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=pytz.UTC)
            if datetime.now(pytz.UTC) >= expiry.astimezone(pytz.UTC):
                raise ValueError('License has expired.')
        except (AttributeError, TypeError) as exc:
            raise ValueError('License expiry must be an ISO-8601 timestamp.') from exc
        except ValueError as exc:
            if str(exc) == 'License has expired.':
                raise
            raise ValueError('License expiry must be an ISO-8601 timestamp.') from exc
    return license_data


def get_license() -> dict:
    """Read and verify the installed license without raising errors."""
    try:
        license_file = Path(LICENSE_PATH)
        if license_file.stat().st_size > MAX_LICENSE_BYTES:
            raise ValueError('Installed license exceeds the size limit.')
        return {'valid': True, **verify_doc(json.loads(license_file.read_text(encoding='utf-8')))}
    except Exception as exc:
        return {'valid': False, 'reason': str(exc), 'max_devices': 0}


def install_license(doc: dict) -> None:
    """Verify and atomically install a license at LICENSE_PATH."""
    verify_doc(doc)
    license_path = Path(LICENSE_PATH)
    license_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=license_path.parent,
                                         prefix=f'.{license_path.name}.', delete=False) as temp_file:
            temporary_path = Path(temp_file.name)
            json.dump(doc, temp_file, separators=(',', ':'))
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temporary_path, license_path)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def device_names() -> list:
    """Return saved device config names, excluding temporary test configs."""
    return [path.stem for path in Path(CONFIG_DIR).glob('*.conf')
            if path.is_file() and not path.name.startswith('temp_test_')]


def count_devices() -> int:
    """Count configured Telegraf inputs, treating each config as at least one."""
    total = 0
    for name in device_names():
        config_path = Path(CONFIG_DIR) / f'{name}.conf'
        try:
            inputs = toml.load(str(config_path)).get('inputs', {})
            total += max(1, sum(len(value) if isinstance(value, list) else 1
                                for value in inputs.values()))
        except Exception:
            total += 1
    return total


def get_max_devices() -> int:
    """Return the active license's device limit, or zero if unlicensed."""
    license_data = get_license()
    return license_data['max_devices'] if license_data['valid'] else 0


def can_add(name: str) -> tuple:
    """Check a proposed config name and whether another device fits the license."""
    if not NAME_RE.fullmatch(name or ''):
        return False, 'Invalid device name.'
    if name in device_names():
        return True, ''
    license_data = get_license()
    if not license_data['valid'] and not LICENSE_ENFORCEMENT_ENABLED:
        return True, ''
    if not license_data['valid']:
        return False, 'A valid NEU159 license is required to add devices.'
    used = count_devices()
    maximum = license_data['max_devices']
    if used >= maximum:
        return False, f'Device limit reached ({used}/{maximum}).'
    return True, ''


class USBStatusError(Exception):
    def __init__(self, state: str, message: str, diagnostics: dict = None):
        super().__init__(message)
        self.state = state
        self.diagnostics = diagnostics


def _lsblk_devices() -> list:
    result = subprocess.run(
        ['lsblk', '-J', '-o', 'PATH,RM,HOTPLUG,TYPE,FSTYPE,MOUNTPOINT,TRAN'],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode:
        raise USBStatusError('mount_failed', result.stderr.strip() or 'lsblk could not inspect storage devices.')
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise USBStatusError('mount_failed', 'lsblk returned invalid device information.') from exc

    devices = []

    def truthy(value):
        return value is True or str(value).lower() in ('1', 'true', 'yes')

    def visit(node, parent_removable=False, parent_transport=''):
        transport = str(node.get('tran') or parent_transport).lower()
        removable = (parent_removable or truthy(node.get('rm')) or
                     truthy(node.get('hotplug')) or transport == 'usb')
        device_type = node.get('type')
        filesystem = node.get('fstype')
        device_path = node.get('path')
        if removable and device_type in ('part', 'disk') and filesystem and device_path:
            mountpoints = node.get('mountpoints') or node.get('mountpoint') or []
            if isinstance(mountpoints, str):
                mountpoints = [mountpoints]
            devices.append({
                'path': device_path,
                'type': device_type,
                'mountpoints': [mount for mount in mountpoints if mount],
            })
        for child in node.get('children') or []:
            visit(child, removable, transport)

    for device in data.get('blockdevices') or []:
        visit(device)
    devices.sort(key=lambda item: (item['type'] != 'part', item['path']))
    return devices


def _neu_usb_folder(mountpoint: str):
    if not mountpoint or os.path.islink(mountpoint) or not os.path.isdir(mountpoint):
        return None
    if os.path.basename(os.path.normpath(mountpoint)).casefold() == USB_DIR_NAME.casefold():
        return mountpoint
    try:
        with os.scandir(mountpoint) as entries:
            for entry in entries:
                if entry.name.casefold() == USB_DIR_NAME.casefold() and entry.is_dir(follow_symlinks=False):
                    return entry.path
    except OSError:
        return None
    return None


@contextmanager
def _usb_license_folder(writable: bool = False):
    """Find NEU159_USB on removable storage and temporarily mount if required."""
    try:
        devices = _lsblk_devices()
    except FileNotFoundError as exc:
        raise USBStatusError('mount_failed', 'lsblk is unavailable on this controller.') from exc
    if not devices:
        raise USBStatusError('no_device', 'No removable USB storage with a filesystem was found.')

    saw_mounted_device = False
    mount_errors = []
    for device in devices:
        for mountpoint in device['mountpoints']:
            saw_mounted_device = True
            folder = _neu_usb_folder(mountpoint)
            if folder:
                yield folder
                return

    for device in devices:
        if device['mountpoints']:
            continue
        mountpoint = tempfile.mkdtemp(prefix='neu159-usb-')
        mounted_ok = False
        try:
            options = 'rw,nosuid,nodev,noexec' if writable else 'ro,nosuid,nodev,noexec'
            mounted = subprocess.run(
                ['mount', '-o', options, device['path'], mountpoint],
                capture_output=True, text=True, timeout=15
            )
            if mounted.returncode:
                mount_errors.append(mounted.stderr.strip() or f"Could not mount {device['path']}.")
                continue
            mounted_ok = True
            saw_mounted_device = True
            folder = _neu_usb_folder(mountpoint)
            if folder:
                yield folder
                return
        finally:
            if mounted_ok:
                if writable:
                    subprocess.run(['sync'], capture_output=True, text=True, timeout=10)
                subprocess.run(['umount', mountpoint], capture_output=True, text=True, timeout=15)
            try:
                os.rmdir(mountpoint)
            except OSError:
                pass

    if mount_errors:
        raise USBStatusError('mount_failed', '; '.join(mount_errors))
    if saw_mounted_device:
        raise USBStatusError('no_folder', f'No {USB_DIR_NAME} folder was found at a removable drive root.')
    raise USBStatusError('no_device', 'No mounted or mountable removable USB storage was found.')


@contextmanager
def usb_license_folder(writable: bool = False):
    """Serialize USB scans and mount each unmounted device at a private path."""
    with _USB_SCAN_LOCK:
        with _usb_license_folder(writable=writable) as folder:
            yield folder


def _license_arch() -> str:
    machine = platform.machine().lower()
    return {'x86_64': 'amd64', 'amd64': 'amd64',
            'aarch64': 'arm64', 'arm64': 'arm64',
            'armv7l': 'armhf'}.get(machine, machine)


def _parse_license_json(raw: str) -> dict:
    """Accept JSON licenses whose base64 signature was line-wrapped by a tool."""
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as original_error:
        signature_pattern = r'("signature"\s*:\s*")([^"]*)(")'
        normalized, replacements = re.subn(
            signature_pattern,
            lambda match: match.group(1) + re.sub(r'[\s\\]+', '', match.group(2)) + match.group(3),
            raw,
            count=1,
            flags=re.DOTALL,
        )
        if not replacements:
            raise original_error
        document = json.loads(normalized)
    if isinstance(document, dict) and isinstance(document.get('signature'), str):
        document['signature'] = re.sub(r'[\s\\]+', '', document['signature'])
    return document


def _license_diagnostics(document: dict) -> dict:
    """Return license payload/signature metadata without exposing signature bytes."""
    if not isinstance(document, dict):
        return {'document_type': type(document).__name__}
    license_data = document.get('license')
    diagnostics = {
        'top_level_keys': sorted(str(key) for key in document),
        'license': license_data if isinstance(license_data, dict) else None,
    }
    signature = document.get('signature')
    if isinstance(license_data, dict):
        canonical_payload = json.dumps(
            license_data, sort_keys=True, separators=(',', ':')
        ).encode('utf-8')
        diagnostics['canonical_payload_sha256'] = hashlib.sha256(canonical_payload).hexdigest()
    try:
        issuer_public_key = serialization.load_pem_public_key(PUBLIC_KEY_PEM.encode('ascii'))
        issuer_public_der = issuer_public_key.public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        diagnostics['issuer_public_key_sha256'] = hashlib.sha256(issuer_public_der).hexdigest()
    except Exception:
        diagnostics['issuer_public_key_sha256'] = None
    if not isinstance(signature, str):
        diagnostics['signature'] = {'present': False, 'type': type(signature).__name__}
        return diagnostics

    normalized_signature = re.sub(r'[\s\\]+', '', signature)
    signature_info = {
        'present': True,
        'format': 'pem_key' if 'PRIVATE KEY' in signature or '-----BEGIN' in signature else 'unknown',
        'characters': len(normalized_signature),
    }
    if signature_info['format'] != 'pem_key':
        try:
            decoded = base64.b64decode(normalized_signature, validate=True)
            signature_info['format'] = 'base64'
            signature_info['decoded_bytes'] = len(decoded)
        except (binascii.Error, ValueError):
            signature_info['format'] = 'invalid_base64'
    diagnostics['signature'] = signature_info
    return diagnostics


def _read_usb_license(folder: str) -> dict:
    licenses_dir = os.path.join(folder, 'licenses')
    if os.path.islink(licenses_dir) or not os.path.isdir(licenses_dir):
        raise USBStatusError('no_license', 'The USB has no valid licenses folder.')
    arch = _license_arch()
    arch_path = os.path.join(licenses_dir, arch)
    candidates = []
    controller_id = machine_id()
    if os.path.isfile(arch_path):
        candidates.append(arch_path)
    elif os.path.isdir(arch_path) and not os.path.islink(arch_path):
        if re.fullmatch(r'[A-Za-z0-9_-]{1,64}', controller_id):
            candidates.append(os.path.join(arch_path, f'{controller_id}.json'))
        candidates.extend([
            os.path.join(arch_path, 'license.json'),
            os.path.join(arch_path, 'license.lic'),
        ])
    candidates.append(os.path.join(licenses_dir, f'{arch}.json'))

    for candidate in candidates:
        if os.path.islink(candidate) or not os.path.isfile(candidate):
            continue
        document = None
        try:
            if os.path.getsize(candidate) > MAX_LICENSE_BYTES:
                raise USBStatusError('no_license', 'The USB license file exceeds the allowed size.')
            with open(candidate, 'r', encoding='utf-8') as license_file:
                document = _parse_license_json(license_file.read())
            verify_doc(document)
            return document
        except USBStatusError:
            raise
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            message = f'USB license was rejected: {exc}'
            if isinstance(document, dict) and isinstance(document.get('license'), dict):
                if machine_id_enforcement_enabled() and document['license'].get('machine_id') != machine_id():
                    message += ' Its machine ID does not match this controller.'
            diagnostics = _license_diagnostics(document) if isinstance(document, dict) else None
            raise USBStatusError('no_license', message, diagnostics) from exc
    raise USBStatusError('no_license', f'No license for {_license_arch()} and this controller was found on the USB.')


def is_valid_device_name(name: str) -> bool:
    return isinstance(name, str) and bool(re.fullmatch(r'[A-Za-z0-9_-]{1,40}', name))


def count_saved_configs() -> int:
    """Count saved config files, excluding temporary Telegraf test files."""
    total = 0
    for filename in os.listdir(CONFIG_DIR):
        if not filename.endswith('.conf') or filename.startswith('temp_test_'):
            continue
        filepath = os.path.join(CONFIG_DIR, filename)
        if os.path.isfile(filepath):
            total += 1
    return total


def config_limit_error(used: int):
    maximum = get_max_devices()
    return jsonify({
        'error': 'license_limit',
        'code': 'device_limit',
        'message': f'Device limit reached ({used}/{maximum}).'
    }), 403


STANDARD_OID_ANCHORS = {
    'iso': '1', 'org': '1.3', 'dod': '1.3.6', 'internet': '1.3.6.1',
    'directory': '1.3.6.1.1', 'mgmt': '1.3.6.1.2', 'mib-2': '1.3.6.1.2.1',
    'experimental': '1.3.6.1.3', 'private': '1.3.6.1.4', 'enterprises': '1.3.6.1.4.1',
    'security': '1.3.6.1.5', 'snmpV2': '1.3.6.1.6', 'transmission': '1.3.6.1.2.1.10',
    'system': '1.3.6.1.2.1.1', 'interfaces': '1.3.6.1.2.1.2',
}


def parse_mib_oids(mib_text):
    """Lightweight, dependency-free MIB parser."""
    text = re.sub(r'--.*', '', mib_text)
    text = re.sub(r'IMPORTS\b.*?;', '', text, flags=re.DOTALL)

    pattern = re.compile(
        r'(?P<name>[a-zA-Z][a-zA-Z0-9\-]*)\s+'
        r'(?P<kind>OBJECT-TYPE|OBJECT\s+IDENTIFIER|MODULE-IDENTITY|OBJECT-IDENTITY|NOTIFICATION-TYPE)\b'
        r'.*?::=\s*\{\s*(?P<parent>[a-zA-Z][a-zA-Z0-9\-]*)\s+(?P<subid>\d+)\s*\}',
        re.DOTALL
    )
    syntax_pattern = re.compile(r'SYNTAX\s+([A-Za-z0-9_\-]+)')

    by_name = {}
    order = []
    for m in pattern.finditer(text):
        block = m.group(0)
        syn_m = syntax_pattern.search(block)
        entry = {
            'pos': m.start(),
            'name': m.group('name'),
            'parent': m.group('parent'),
            'subid': m.group('subid'),
            'kind': re.sub(r'\s+', ' ', m.group('kind')),
            'syntax': syn_m.group(1) if syn_m else ''
        }
        by_name.setdefault(entry['name'], []).append(entry)
        order.append(entry)

    def find_nearest(name, before_pos):
        occurrences = by_name.get(name)
        if not occurrences:
            return None
        idx = bisect.bisect_left([o['pos'] for o in occurrences], before_pos) - 1
        return occurrences[idx] if idx >= 0 else occurrences[0]

    resolved_cache = {}

    def resolve_entry(entry, seen=None):
        key = (entry['name'], entry['pos'])
        if key in resolved_cache:
            return resolved_cache[key]
        seen = seen or set()
        if key in seen:
            return None
        seen.add(key)
        parent_oid = resolve_parent(entry['parent'], entry['pos'], seen)
        if parent_oid is None:
            return None
        oid = f"{parent_oid}.{entry['subid']}"
        resolved_cache[key] = oid
        return oid

    def resolve_parent(name, before_pos, seen):
        if name in STANDARD_OID_ANCHORS:
            return STANDARD_OID_ANCHORS[name]
        entry = find_nearest(name, before_pos)
        if entry is None:
            return None
        return resolve_entry(entry, seen)

    results = []
    for entry in order:
        oid = resolve_entry(entry)
        if oid:
            results.append({'name': entry['name'], 'oid': oid, 'type': entry['kind'], 'syntax': entry['syntax']})
    results.sort(key=lambda r: [int(p) for p in r['oid'].split('.')])
    return results


# MQTT live data store
live_data = {}
live_data_lock = threading.Lock()


def get_configured_device_names():
    """Extract 'name' field from all saved .conf files."""
    names = set()
    for f in os.listdir(CONFIG_DIR):
        if f.endswith('.conf'):
            try:
                with open(os.path.join(CONFIG_DIR, f)) as cf:
                    config = toml.load(cf)
                for proto in ['modbus', 'snmp']:
                    entries = config.get('inputs', {}).get(proto, [])
                    for entry in entries:
                        if 'name' in entry:
                            names.add(entry['name'])
            except Exception:
                pass
    return names


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0:
        print("MQTT connected, subscribing to #")
        client.subscribe("#")
    else:
        print(f"MQTT connection failed with reason code: {reason_code}")


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode('utf-8', errors='ignore'))
        if not isinstance(payload, dict):
            return
        tags = payload.get("tags") if isinstance(payload.get("tags"), dict) else {}
        device = tags.get("name") or payload.get("name") or msg.topic.split('/')[0]
        if 'fields' in payload and isinstance(payload['fields'], dict):
            with live_data_lock:
                existing = live_data.get(device, {}).get("fields", {})
                merged = {**existing, **payload['fields']}
                live_data[device] = {
                    "fields": merged,
                    "timestamp": time.time()
                }
    except Exception as e:
        print("MQTT ERROR:", e)


mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
if MQTT_USER:
    mqtt_client.username_pw_set(MQTT_USER, MQTT_PASS)
mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message
mqtt_client.reconnect_delay_set(min_delay=1, max_delay=30)
try:
    mqtt_client.connect_async(MQTT_HOST, MQTT_PORT, 60)
    mqtt_client.loop_start()
except Exception as err:
    print(f"MQTT init failed: {err}")


def get_current_time():
    return datetime.now(IST).strftime('%Y-%m-%d %H:%M:%S')


def validate_addresses(addresses_str):
    errors = []
    try:
        address_list = [a.strip() for a in addresses_str.split(',')]
        if not all(address_list):
            errors.append("Address list contains empty entries or trailing commas")
            return errors, []
        addresses = []
        for addr in address_list:
            if not re.match(r'^\d+$', addr):
                errors.append(f"Invalid address: {addr}. Must be a non-negative integer")
            else:
                addresses.append(int(addr))
        return errors, addresses
    except Exception as e:
        errors.append(f"Invalid address format: {str(e)}")
        return errors, []


def generate_telegraf_conf(data):
    conf = f'# Generated by Device UI on {get_current_time()}\n'

    interval = data.get('interval', '10s')
    conf += f'[agent]\n  interval = "{interval}"\n\n'
    if data['protocol'] == 'snmp':
        conf += '[[inputs.snmp]]\n'
        conf += f'  name = "{data["name"]}"\n'
        conf += f'  agents = ["udp://{data["host"]}:{data["port"]}"]\n'
        conf += f'  timeout = "{data["timeout"]}"\n'
        conf += f'  version = {data["version"]}\n'
        if int(data["version"]) == 3:
            conf += f'  sec_name = "{data["sec_name"]}"\n'
            conf += f'  sec_level = "{data["sec_level"]}"\n'
            if data.get("auth_protocol"):
                conf += f'  auth_protocol = "{data["auth_protocol"]}"\n'
                conf += f'  auth_password = "{data["auth_password"]}"\n'
            if data.get("priv_protocol"):
                conf += f'  priv_protocol = "{data["priv_protocol"]}"\n'
                conf += f'  priv_password = "{data["priv_password"]}"\n'
        else:
            conf += f'  community = "{data["community"]}"\n'
        for field in data.get('fields', []):
            conf += '  [[inputs.snmp.field]]\n'
            conf += f'    name = "{field["name"]}"\n'
            conf += f'    oid = "{field["oid"]}"\n'
            conf += f'    is_tag = {str(field["is_tag"]).lower()}\n'
    else:
        conf += '[[inputs.modbus]]\n'
        conf += f'  name = "{data["name"]}"\n'
        conf += f'  slave_id = {data["slave_id"]}\n'
        conf += f'  timeout = "{data["timeout"]}"\n'
        conf += '  configuration_type = "register"\n'
        if data['protocol'] == 'tcp':
            conf += f'  controller = "tcp://{data["host"]}:{data["port"]}"\n'
            conf += '  transmission_mode = "TCP"\n'
            conf += '  busy_retries = 3\n'
        else:
            conf += f'  controller = "{data["controller"]}"\n'
            conf += f'  baud_rate = {data["baud_rate"]}\n'
            conf += f'  data_bits = {data["data_bits"]}\n'
            conf += f'  parity = "{data["parity"]}"\n'
            conf += f'  stop_bits = {data["stop_bits"]}\n'
        for r_type_key in ['discrete_inputs', 'coils', 'holding_registers', 'input_registers']:
            regs = [r for r in data.get('registers', []) if r['type'] == r_type_key]
            if regs:
                conf += f'  {r_type_key} = [\n'
                for reg in regs:
                    errors, addresses = validate_addresses(reg["address"])
                    if errors:
                        raise ValueError(f"Register {reg['name']}: {'; '.join(errors)}")
                    if r_type_key in ['discrete_inputs', 'coils']:
                        conf += f'    {{ name = "{reg["name"]}", address = [{", ".join(map(str, addresses))}] }},\n'
                    else:
                        conf += f'    {{ name = "{reg["name"]}", '
                        if reg.get('data_type') != 'STRING':
                            conf += f'byte_order = "{reg["byte_order"]}", '
                        conf += f'data_type = "{reg["data_type"]}", scale = {reg["scale"]:.1f}, address = [{", ".join(map(str, addresses))}] }},\n'
                conf += '  ]\n'
    tags = data.get('tags', [])
    if tags:
        section = 'inputs.snmp' if data['protocol'] == 'snmp' else 'inputs.modbus'
        conf += f'  [{section}.tags]\n'
        for tag in tags:
            conf += f'    {tag["label"]} = "{tag["value"]}"\n'
    for db in data.get('influxdb', []):
        conf += '\n[[outputs.influxdb_v2]]\n'
        urls_list = ', '.join(f'"{url}"' for url in db.get("urls", []))
        conf += f'  urls = [{urls_list}]\n'
        conf += f'  token = "{db.get("token", "")}"\n'
        conf += f'  organization = "{db.get("organization", "")}"\n'
        conf += f'  bucket = "{db.get("bucket", "")}"\n'

    conf += '\n[[outputs.mqtt]]\n'
    conf += f'  servers = ["tcp://{MQTT_HOST}:{MQTT_PORT}"]\n'
    if MQTT_USER:
        conf += f'  username = "{MQTT_USER}"\n'
        conf += f'  password = "{MQTT_PASS}"\n'
    topic = "neutron/snmp/data" if data['protocol'] == 'snmp' else "neutron/modbus/data"
    conf += f'  topic = "{topic}"\n'
    conf += '  data_format = "json"\n'

    return conf


def create_systemd_service(name):
    service_name = f'telegraf-{name}.service'
    service_path = os.path.join(SYSTEMD_DIR, service_name)
    service_content = f"""[Unit]
Description=Telegraf service for {name} configuration
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/telegraf --config {CONFIG_DIR}/{name}.conf
Restart=always
User=root

[Install]
WantedBy=multi-user.target
"""
    try:
        with open(service_path, 'w') as f:
            f.write(service_content)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
    except Exception as e:
        raise Exception(f"Failed to create systemd service {service_name}: {str(e)}")


@app.route('/')
def index():
    return render_template('dashboard.html')


@app.route('/configuration')
def config():
    return render_template('config.html')


@app.route('/license')
def license_activation():
    return render_template('dashboard.html')


@app.route('/dashboard')
def dashboard():
    return render_template('dashboard.html')


@app.route('/configs', methods=['GET'])
def list_configs():
    try:
        configs = [f for f in os.listdir(CONFIG_DIR) if f.endswith('.conf')]
        return jsonify(configs)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/config/<name>', methods=['GET'])
def get_config(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        filepath = os.path.join(CONFIG_DIR, f'{name}.conf')
        if not os.path.exists(filepath):
            return jsonify({'error': 'Config not found'}), 404
        with open(filepath, 'r') as f:
            config_data = toml.load(f)
        influx_list = []
        if 'outputs' in config_data and 'influxdb_v2' in config_data['outputs']:
            for entry in config_data['outputs']['influxdb_v2']:
                influx_list.append({
                    'urls': entry.get('urls', []),
                    'token': entry.get('token', ''),
                    'organization': entry.get('organization', entry.get('org', '')),
                    'bucket': entry.get('bucket', '')
                })
        if 'snmp' in config_data.get('inputs', {}):
            snmp = config_data['inputs']['snmp'][0]
            host_port = snmp['agents'][0].replace('udp://', '').split(':')
            res = {
                'name': snmp['name'], 'protocol': 'snmp', 'timeout': snmp.get('timeout', '1s'),
                'host': host_port[0], 'port': int(host_port[1]), 'version': snmp['version'],
                'community': snmp.get('community', ''),
                'sec_name': snmp.get('sec_name', ''), 'sec_level': snmp.get('sec_level', 'noAuthNoPriv'),
                'auth_protocol': snmp.get('auth_protocol', ''), 'auth_password': snmp.get('auth_password', ''),
                'priv_protocol': snmp.get('priv_protocol', ''), 'priv_password': snmp.get('priv_password', ''),
                'fields': [{'name': f['name'], 'oid': f['oid'], 'is_tag': f.get('is_tag', False)} for f in snmp.get('field', [])],
                'tags': [{'label': k, 'value': v} for k, v in snmp.get('tags', {}).items()]
            }
        else:
            modbus = config_data['inputs']['modbus'][0]
            protocol = 'tcp' if modbus['controller'].startswith('tcp://') else 'rtu'
            host, port = '', ''
            if protocol == 'tcp':
                hp = modbus['controller'].replace('tcp://', '').split(':')
                host, port = hp[0], int(hp[1])
            registers = []
            for r_type in ['discrete_inputs', 'coils', 'holding_registers', 'input_registers']:
                for r in modbus.get(r_type, []):
                    entry = {'type': r_type, 'name': r['name'], 'address': ','.join(map(str, r['address']))}
                    if r_type not in ['discrete_inputs', 'coils']:
                        entry.update({'byte_order': r.get('byte_order', ''), 'data_type': r.get('data_type', 'BIT'), 'scale': float(r.get('scale', 1.0))})
                    registers.append(entry)
            res = {
                'name': modbus['name'], 'protocol': protocol, 'timeout': modbus.get('timeout', '1s'),
                'host': host, 'port': port, 'controller': modbus.get('controller', ''), 'slave_id': modbus['slave_id'],
                'baud_rate': modbus.get('baud_rate', ''), 'data_bits': modbus.get('data_bits', ''),
                'parity': modbus.get('parity', ''), 'stop_bits': modbus.get('stop_bits', ''),
                'registers': registers, 'tags': [{'label': k, 'value': v} for k, v in modbus.get('tags', {}).items()]
            }
        res['influxdb'] = influx_list
        agent = config_data.get('agent', {})
        res['interval'] = agent.get('interval', '10s')
        return jsonify(res)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/config/<name>', methods=['POST'])
def save_config(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        data = request.json
        if not isinstance(data, dict) or not is_valid_device_name(data.get('name')) or data['name'] != name:
            return jsonify({'error': 'Invalid or mismatched device name'}), 400
        conf_str = generate_telegraf_conf(data)
        filepath = os.path.join(CONFIG_DIR, f'{name}.conf')
        with add_lock:
            allowed, message = can_add(name)
            if not allowed:
                return jsonify({'error': 'license_limit', 'code': 'device_limit', 'message': message}), 403
            is_existing = os.path.exists(filepath)
            warning = 'Configuration file already exists and has been overwritten' if is_existing else None
            with open(filepath, 'w') as f:
                f.write(conf_str)
            create_systemd_service(name)
        return jsonify({'message': 'Config saved successfully', 'warning': warning})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/config/<name>', methods=['DELETE'])
def delete_config(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        filepath = os.path.join(CONFIG_DIR, f'{name}.conf')
        with add_lock:
            if not os.path.exists(filepath):
                return jsonify({'error': 'Config not found'}), 404
            os.remove(filepath)
        return jsonify({'message': 'Config deleted'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/service/<name>', methods=['DELETE'])
def delete_service(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        service_name = f'telegraf-{name}.service'
        service_path = os.path.join(SYSTEMD_DIR, service_name)
        if os.path.exists(service_path):
            os.remove(service_path)
            subprocess.run(['systemctl', 'daemon-reload'], check=True)
        return jsonify({'message': f'Service {service_name} deleted'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/start_service/<name>', methods=['POST'])
def start_service(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        service_name = f'telegraf-{name}'
        filepath = os.path.join(CONFIG_DIR, f'{name}.conf')
        if not os.path.exists(filepath):
            return jsonify({'error': 'Configuration file not found'}), 404
        with add_lock:
            used = count_devices()
            maximum = get_max_devices()
            license_valid = get_license()['valid']
            if ((LICENSE_ENFORCEMENT_ENABLED and not license_valid) or
                    (license_valid and used > maximum)):
                return config_limit_error(used)
            create_systemd_service(name)
            subprocess.run(['systemctl', 'restart', service_name], check=True)
        return jsonify({'message': f'Service {service_name} started'})
    except subprocess.CalledProcessError as e:
        return jsonify({'error': f'Failed to start service: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/stop_service/<name>', methods=['POST'])
def stop_service(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        service_name = f'telegraf-{name}'
        result = subprocess.run(['systemctl', 'is-active', service_name], capture_output=True, text=True)
        if result.returncode == 0:
            subprocess.run(['systemctl', 'stop', service_name], check=True)
        return jsonify({'message': f'Service {service_name} stopped'})
    except subprocess.CalledProcessError as e:
        return jsonify({'error': f'Failed to stop service: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/service_status/<name>', methods=['GET'])
def service_status(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        service_name = f'telegraf-{name}'
        result = subprocess.run(['systemctl', 'status', service_name], capture_output=True, text=True)
        if 'Active: active (running)' in result.stdout:
            status = 'active'
        elif 'Active: failed' in result.stdout:
            status = 'failed'
        else:
            status = 'inactive'
        return jsonify({'status': status})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/test_config/<name>', methods=['GET'])
def test_config(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        filepath = os.path.join(CONFIG_DIR, f'{name}.conf')
        if not os.path.exists(filepath):
            return jsonify({'error': 'Config not found'}), 404
        result = subprocess.run(['telegraf', '--config', filepath, '-test'], capture_output=True, text=True, timeout=25)
        status = 'success' if result.returncode == 0 else 'error'
        return jsonify({'output': result.stdout + result.stderr, 'status': status})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Telegraf test timed out'}), 500
    except Exception as e:
        return jsonify({'error': f'Telegraf test failed: {str(e)}'}), 500


@app.route('/test_config_from_data', methods=['POST'])
def test_config_from_data():
    try:
        data = request.json
        if not isinstance(data, dict) or not is_valid_device_name(data.get('name')):
            return jsonify({'error': 'Invalid device name'}), 400
        conf_str = generate_telegraf_conf(data)
        temp_filepath = os.path.join(CONFIG_DIR, f'temp_test_{data["name"]}.conf')
        with open(temp_filepath, 'w') as f:
            f.write(conf_str)
        try:
            result = subprocess.run(['telegraf', '--config', temp_filepath, '-test'], capture_output=True, text=True, timeout=10)
            status = 'success' if result.returncode == 0 else 'error'
            warning = None
            if status == 'error' and 'timeout' in result.stderr.lower():
                warning = 'Connection timed out. Check the device address and network connectivity.'
            return jsonify({'output': result.stdout + result.stderr, 'status': status, 'warning': warning})
        finally:
            if os.path.exists(temp_filepath):
                os.remove(temp_filepath)
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Telegraf test timed out'}), 500
    except Exception as e:
        return jsonify({'error': f'Telegraf test failed: {str(e)}'}), 500


@app.route('/download/<name>', methods=['GET'])
def download_config(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        filepath = os.path.join(CONFIG_DIR, f'{name}.conf')
        if not os.path.exists(filepath):
            return jsonify({'error': 'Config not found'}), 404
        return send_file(filepath, as_attachment=True, download_name=f'{name}.conf')
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/generate_conf', methods=['POST'])
def generate_conf():
    try:
        data = request.json
        if not isinstance(data, dict) or not is_valid_device_name(data.get('name')):
            return jsonify({'error': 'Invalid device name'}), 400
        conf_str = generate_telegraf_conf(data)
        return send_file(
            io.BytesIO(conf_str.encode('utf-8')),
            as_attachment=True,
            download_name=f"{data['name']}.conf",
            mimetype='text/plain'
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/duplicate_config/<name>', methods=['POST'])
def duplicate_config(name):
    try:
        if not is_valid_device_name(name):
            return jsonify({'error': 'Invalid device name'}), 400
        data = request.json
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400
        new_name = data.get('new_name')
        if not is_valid_device_name(new_name):
            return jsonify({'error': 'Invalid new configuration name'}), 400
        original_path = os.path.join(CONFIG_DIR, f'{name}.conf')
        new_path = os.path.join(CONFIG_DIR, f'{new_name}.conf')
        with add_lock:
            if not os.path.exists(original_path):
                return jsonify({'error': f'Original config {name} not found'}), 404
            if os.path.exists(new_path):
                return jsonify({'error': f'Configuration {new_name} already exists'}), 400
            allowed, message = can_add(new_name)
            if not allowed:
                return jsonify({'error': 'license_limit', 'code': 'device_limit', 'message': message}), 403
            with open(original_path, 'r') as f:
                content = f.read()
            with open(new_path, 'w') as f:
                f.write(content)
            create_systemd_service(new_name)
        return jsonify({'message': f'Configuration duplicated as {new_name}'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/dashboard/stats', methods=['GET'])
def dashboard_stats():
    try:
        configs = [f[:-5] for f in os.listdir(CONFIG_DIR) if f.endswith('.conf')]
        total = len(configs)
        active = inactive = 0
        for name in configs:
            result = subprocess.run(['systemctl', 'is-active', f'telegraf-{name}'], capture_output=True, text=True)
            if result.stdout.strip() == 'active':
                active += 1
            else:
                inactive += 1
        return jsonify({"total": total, "active": active, "inactive": inactive})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/modbus_config', methods=['POST'])
def save_modbus_config():
    try:
        data = request.json
        mapping = data.get("mapping", {})
        used = set()

        for field, cfg in mapping.items():
            reg = cfg["register"]
            length = cfg.get("length", 1)

            if not (1 <= reg <= 100 or 10001 <= reg <= 10100 or
                    30001 <= reg <= 30100 or 40001 <= reg <= 40100):
                return {"error": f"Invalid register {reg}"}, 400

            for i in range(length):
                if (reg + i) in used:
                    return {"error": "Register overlap detected"}, 400
                used.add(reg + i)

        with open(MODBUS_CONFIG, "w") as f:
            json.dump(data, f, indent=2)

        return {"message": "Modbus config saved"}
    except Exception as e:
        return {"error": str(e)}, 500


@app.route('/api/modbus_config', methods=['GET'])
def get_modbus_config():
    try:
        if not os.path.exists(MODBUS_CONFIG):
            return {}
        with open(MODBUS_CONFIG) as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)}, 500


@app.route('/modbus/status', methods=['GET'])
def modbus_status():
    try:
        running = False
        mapping = {}
        if os.path.exists(MODBUS_CONFIG):
            with open(MODBUS_CONFIG) as f:
                mapping = json.load(f).get("mapping", {})
        return jsonify({
            "running": running,
            "mapping": mapping
        })
    except Exception as e:
        return {"error": str(e)}, 500


@app.route('/api/modbus/expose_defaults/<name>', methods=['GET'])
def modbus_expose_defaults(name):
    try:
        mapping = {
            "Voltage": {"register": 40001, "length": 1},
            "Current": {"register": 40003, "length": 1},
            "Power Factor": {"register": 40005, "length": 1},
            "Frequency": {"register": 40007, "length": 1}
        }
        return jsonify({"mapping": mapping})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def snmp_get_batch(host, port, community, oids, version=2):
    """Pure Python SNMP v1/v2c GET request implementation over UDP socket."""
    if not oids:
        return {}

    def encode_tlv(tag, payload):
        if len(payload) < 128:
            length_bytes = bytes([len(payload)])
        else:
            lb = []
            l = len(payload)
            while l > 0:
                lb.insert(0, l & 0xff)
                l >>= 8
            length_bytes = bytes([0x80 | len(lb)] + lb)
        return bytes([tag]) + length_bytes + payload

    def encode_integer(val):
        if val == 0:
            return encode_tlv(0x02, b'\x00')
        b = []
        neg = val < 0
        if neg:
            val = (1 << (val.bit_length() + 8)) + val
        while val > 0:
            b.insert(0, val & 0xff)
            val >>= 8
        if not neg and b[0] & 0x80:
            b.insert(0, 0)
        return encode_tlv(0x02, bytes(b))

    def encode_octet_string(s):
        if isinstance(s, str):
            s = s.encode('utf-8')
        return encode_tlv(0x04, s)

    def encode_oid(oid_str):
        parts = [int(p) for p in oid_str.strip('.').split('.') if p != '']
        if len(parts) < 2:
            return b''
        first_byte = parts[0] * 40 + parts[1]
        encoded = [first_byte]
        for subid in parts[2:]:
            sub_bytes = []
            while subid > 0:
                sub_bytes.insert(0, (subid & 0x7f) | (0x80 if sub_bytes else 0))
                subid >>= 7
            if not sub_bytes:
                sub_bytes = [0]
            encoded.extend(sub_bytes)
        return encode_tlv(0x06, bytes(encoded))

    varbinds_payload = b''
    formatted_oids = []
    for oid in oids:
        clean_oid = oid.lstrip('.')
        target_oid = clean_oid if clean_oid.endswith('.0') else clean_oid + '.0'
        formatted_oids.append((oid, clean_oid, target_oid))
        varbind = encode_tlv(0x30, encode_oid(target_oid) + encode_tlv(0x05, b''))
        varbinds_payload += varbind

    varbind_list = encode_tlv(0x30, varbinds_payload)
    pdu = encode_tlv(0xA0, encode_integer(1) + encode_integer(0) + encode_integer(0) + varbind_list)
    snmp_ver = 0 if int(version) == 1 else 1
    snmp_msg = encode_tlv(0x30, encode_integer(snmp_ver) + encode_octet_string(community) + pdu)

    results = {}
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(3.0)
        sock.sendto(snmp_msg, (host, port))
        resp_data, _ = sock.recvfrom(65535)
        sock.close()

        def decode_ber(data, pos=0):
            if pos >= len(data):
                return None, pos
            tag = data[pos]
            pos += 1
            length = data[pos]
            pos += 1
            if length & 0x80:
                num_bytes = length & 0x7f
                length = 0
                for _ in range(num_bytes):
                    length = (length << 8) | data[pos]
                    pos += 1
            val_data = data[pos:pos + length]
            pos += length
            return (tag, val_data), pos

        msg_tlv, _ = decode_ber(resp_data, 0)
        if msg_tlv and msg_tlv[0] == 0x30:
            pos = 0
            _, pos = decode_ber(msg_tlv[1], pos)
            _, pos = decode_ber(msg_tlv[1], pos)
            pdu_tlv, pos = decode_ber(msg_tlv[1], pos)
            if pdu_tlv and (pdu_tlv[0] & 0x1F) == 2:
                pdu_pos = 0
                _, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                _, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                _, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                vbl_tlv, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                if vbl_tlv and vbl_tlv[0] == 0x30:
                    vb_pos = 0
                    vb_index = 0
                    while vb_pos < len(vbl_tlv[1]) and vb_index < len(formatted_oids):
                        vb_item, vb_pos = decode_ber(vbl_tlv[1], vb_pos)
                        if vb_item and vb_item[0] == 0x30:
                            item_pos = 0
                            _, item_pos = decode_ber(vb_item[1], item_pos)
                            val_item, item_pos = decode_ber(vb_item[1], item_pos)
                            orig_oid, clean_oid, target_oid = formatted_oids[vb_index]
                            if val_item:
                                tag, vdata = val_item
                                if tag == 0x02:
                                    val = int.from_bytes(vdata, byteorder='big', signed=True)
                                elif tag == 0x04:
                                    try:
                                        val = vdata.decode('utf-8')
                                    except Exception:
                                        val = vdata.hex()
                                elif tag in (0x41, 0x42, 0x43, 0x46):
                                    val = int.from_bytes(vdata, byteorder='big', signed=False)
                                else:
                                    val = None
                                if val is not None:
                                    for k in {orig_oid, clean_oid, '.' + clean_oid, target_oid, '.' + target_oid}:
                                        results[k] = val
                        vb_index += 1
    except Exception as err:
        print(f"SNMP direct query error ({host}:{port}): {err}")
    return results


def poll_device_snmp_fallback(device):
    """If MQTT has no cached reading yet, query the saved SNMP config directly."""
    if not is_valid_device_name(device):
        return None
    filepath = os.path.join(CONFIG_DIR, f'{device}.conf')
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r') as f:
            config_data = toml.load(f)
        snmp_list = config_data.get('inputs', {}).get('snmp', [])
        if not snmp_list:
            return None
        snmp = snmp_list[0]
        host_port = snmp['agents'][0].replace('udp://', '').split(':')
        host = host_port[0]
        port = int(host_port[1])
        community = snmp.get('community', 'public')
        version = int(snmp.get('version', 2))
        fields = snmp.get('field', [])
        oids = [fld['oid'] for fld in fields if 'oid' in fld]
        oid_values = snmp_get_batch(host, port, community, oids, version=version)
        if not oid_values:
            return None
        mapped_fields = {}
        for fld in fields:
            oid = fld.get('oid', '')
            if oid in oid_values:
                mapped_fields[fld['name']] = oid_values[oid]
            elif oid.lstrip('.') in oid_values:
                mapped_fields[fld['name']] = oid_values[oid.lstrip('.')]
        if mapped_fields:
            entry = {"fields": mapped_fields, "timestamp": time.time()}
            with live_data_lock:
                live_data[device] = entry
            return entry
    except Exception as err:
        print(f"SNMP fallback poll error for {device}: {err}")
    return None


@app.route('/api/live/<device>', methods=['GET'])
def get_live_data(device):
    with live_data_lock:
        cached = live_data.get(device)
    if cached and (time.time() - cached.get('timestamp', 0)) < 30:
        return jsonify(cached)
    fallback = poll_device_snmp_fallback(device)
    if fallback:
        return jsonify(fallback)
    if cached:
        return jsonify(cached)
    return jsonify({'error': 'No data available'})


@app.route('/api/export', methods=['POST'])
def export_to_third_party():
    data = request.json
    print("=" * 50)
    print("EXPORTED DATA:")
    print(json.dumps(data, indent=2))
    print("=" * 50)
    return jsonify({'message': 'Exported successfully', 'data': data})


@app.route('/api/live_all')
def live_all():
    with live_data_lock:
        return jsonify(dict(live_data))


@app.route('/upload_mib', methods=['POST'])
def upload_mib():
    try:
        f = request.files.get('mib_file')
        if not f or not f.filename:
            return jsonify({'error': 'No file uploaded'}), 400
        safe_name = re.sub(r'[^A-Za-z0-9_.\-]', '_', f.filename)
        f.save(os.path.join(MIB_UPLOAD_DIR, safe_name))
        return jsonify({'filename': safe_name})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/walk_mib/<filename>', methods=['GET'])
def walk_mib(filename):
    try:
        safe_name = re.sub(r'[^A-Za-z0-9_.\-]', '_', filename)
        path = os.path.join(MIB_UPLOAD_DIR, safe_name)
        if not os.path.isfile(path):
            return jsonify({'error': 'MIB file not found'}), 404
        with open(path, 'r', errors='ignore') as fh:
            text = fh.read()
        entries = parse_mib_oids(text)
        return jsonify({'count': len(entries), 'entries': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/mibs', methods=['GET'])
def list_mibs():
    try:
        files = []
        for filename in os.listdir(MIB_UPLOAD_DIR):
            filepath = os.path.join(MIB_UPLOAD_DIR, filename)
            if os.path.isfile(filepath):
                stat = os.stat(filepath)
                files.append({
                    'filename': filename,
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
        files.sort(key=lambda x: x['modified'], reverse=True)
        return jsonify(files)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/mibs/<filename>', methods=['DELETE'])
def delete_mib(filename):
    try:
        safe_name = re.sub(r'[^A-Za-z0-9_.\-]', '_', filename)
        filepath = os.path.join(MIB_UPLOAD_DIR, safe_name)
        if os.path.exists(filepath):
            os.remove(filepath)
            return jsonify({'message': f'MIB file {safe_name} deleted successfully'})
        return jsonify({'error': 'MIB file not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/snmp_live_query', methods=['POST'])
def snmp_live_query():
    try:
        data = request.json or {}
        host = data.get('host', '127.0.0.1')
        port = int(data.get('port', 161))
        community = data.get('community', 'public')
        version = int(data.get('version', 2))
        oids = data.get('oids', [])
        if not oids:
            return jsonify({'values': {}})
        results = snmp_get_batch(host, port, community, oids[:50], version=version)
        return jsonify({'values': results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/license', methods=['GET'])
def api_license():
    license_data = get_license()
    return jsonify({
        'valid': license_data['valid'],
        'reason': license_data.get('reason'),
        'license_id': license_data.get('license_id'),
        'type': license_data.get('license_type'),
        'max': license_data.get('max_devices', 0),
        'used': count_devices(),
        'machine_id': machine_id(),
    })


@app.route('/api/usb/status', methods=['GET'])
def api_usb_status():
    try:
        with usb_license_folder() as folder:
            document = _read_usb_license(folder)
        return jsonify({
            'state': 'ready',
            'message': f"Valid license {document['license'].get('license_id', '')} found on USB.",
            'diagnostics': _license_diagnostics(document),
        })
    except USBStatusError as exc:
        result = {'state': exc.state, 'message': str(exc)}
        if exc.diagnostics:
            result['diagnostics'] = exc.diagnostics
        return jsonify(result)
    except Exception as exc:
        app.logger.exception('USB license status check failed')
        return jsonify({'state': 'mount_failed', 'message': str(exc)}), 500


@app.route('/api/usb/install_license', methods=['POST'])
def api_usb_install_license():
    try:
        with usb_license_folder() as folder:
            document = _read_usb_license(folder)
        install_license(document)
        license_data = get_license()
        if not license_data['valid']:
            return jsonify({'error': license_data['reason']}), 500
        return jsonify({
            'message': 'License installed successfully. The USB can now be removed.',
            'saved_to': str(Path(LICENSE_PATH).resolve()),
            'diagnostics': _license_diagnostics(document),
            'license': {
                'license_id': license_data.get('license_id'),
                'license_type': license_data.get('license_type'),
                'max_devices': license_data['max_devices'],
            },
        })
    except USBStatusError as exc:
        result = {'error': str(exc), 'state': exc.state}
        if exc.diagnostics:
            result['diagnostics'] = exc.diagnostics
        return jsonify(result), 400
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        app.logger.exception('USB license installation failed')
        return jsonify({'error': str(exc)}), 500


@app.before_request
def require_license_for_application():
    allowed_endpoints = {
        'static', 'index', 'dashboard', 'config', 'license_activation',
        'api_license', 'api_usb_status', 'api_usb_install_license',
    }
    if request.endpoint in allowed_endpoints:
        return None
    if not LICENSE_ENFORCEMENT_ENABLED:
        return None
    if get_license()['valid']:
        return None
    if request.path.startswith('/api/'):
        return jsonify({
            'error': 'license_required',
            'message': 'Activate a valid NEU159 license to use this feature.',
        }), 402
    if request.method == 'GET':
        return render_template('dashboard.html')
    return jsonify({
        'error': 'license_required',
        'message': 'Activate a valid NEU159 license to use this feature.',
    }), 402


if __name__ == '__main__':
    print('Starting Device UI server on http://0.0.0.0:2999/')
    app.run(host='0.0.0.0', port=2999, debug=False)
