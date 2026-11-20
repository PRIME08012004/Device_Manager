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
import paho.mqtt.client as mqtt
import threading
import time

app = Flask(__name__)

IST = pytz.timezone('Asia/Kolkata')
CONFIG_DIR = os.path.join(os.path.dirname(__file__), 'configs')
SYSTEMD_DIR = '/etc/systemd/system'
MAX_CONFIGS = 100
add_lock = threading.Lock()

if not os.path.exists(CONFIG_DIR):
    os.makedirs(CONFIG_DIR)


MODBUS_CONFIG = os.path.join(os.path.dirname(__file__), 'modbus_config.json')

MIB_UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'mibs')
if not os.path.exists(MIB_UPLOAD_DIR):
    os.makedirs(MIB_UPLOAD_DIR)


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
    return jsonify({
        'error': 'license_limit',
        'message': f'Configuration limit exceeded. This controller supports up to {MAX_CONFIGS} saved config files; {used} are already saved.'
    }), 403

# Standard SMI tree anchors — most vendor MIBs eventually root their custom
# objects under one of these well-known names (e.g. "enterprises"), even
# when the MIBs that formally define those anchors aren't uploaded.
STANDARD_OID_ANCHORS = {
    'iso': '1', 'org': '1.3', 'dod': '1.3.6', 'internet': '1.3.6.1',
    'directory': '1.3.6.1.1', 'mgmt': '1.3.6.1.2', 'mib-2': '1.3.6.1.2.1',
    'experimental': '1.3.6.1.3', 'private': '1.3.6.1.4', 'enterprises': '1.3.6.1.4.1',
    'security': '1.3.6.1.5', 'snmpV2': '1.3.6.1.6', 'transmission': '1.3.6.1.2.1.10',
    'system': '1.3.6.1.2.1.1', 'interfaces': '1.3.6.1.2.1.2',
}


def parse_mib_oids(mib_text):
    """Lightweight, dependency-free MIB parser.

    Extracts every `NAME <KIND> ... ::= { PARENT SUBID }` assignment
    (OBJECT-TYPE, OBJECT IDENTIFIER, MODULE-IDENTITY, OBJECT-IDENTITY,
    NOTIFICATION-TYPE) and resolves each to a full dotted OID by walking
    up parents until it hits a STANDARD_OID_ANCHORS root. This is not a
    full ASN.1 compiler — it does not follow IMPORTS from other MIB
    files, so an object whose parent chain depends on a MIB that wasn't
    uploaded will be skipped rather than guessed at.

    Some vendor MIBs (often auto-generated per repeated hardware unit,
    e.g. one section per PDU in a stack) reuse the exact same
    intermediate node name across multiple sections instead of giving
    each its own unique name — a copy-paste bug in the MIB itself, but
    a common one. A simple "last definition wins" lookup would corrupt
    every section but the last, so each name is resolved using the
    definition of its parent that appears *nearest before it in the
    file*, not just whichever definition of that name happens to be
    last overall. This matches how these repeated-section MIBs are
    actually laid out.
    """
    text = re.sub(r'--.*', '', mib_text)  # strip MIB comments
    text = re.sub(r'IMPORTS\b.*?;', '', text, flags=re.DOTALL)  # drop IMPORTS clause(s) —
    # these list symbol names like OBJECT-TYPE/MODULE-IDENTITY right before
    # "FROM <module>", which otherwise looks exactly like a real definition
    # and confuses the matcher below.

    pattern = re.compile(
        r'(?P<name>[a-zA-Z][a-zA-Z0-9\-]*)\s+'
        r'(?P<kind>OBJECT-TYPE|OBJECT\s+IDENTIFIER|MODULE-IDENTITY|OBJECT-IDENTITY|NOTIFICATION-TYPE)\b'
        r'.*?::=\s*\{\s*(?P<parent>[a-zA-Z][a-zA-Z0-9\-]*)\s+(?P<subid>\d+)\s*\}',
        re.DOTALL
    )
    syntax_pattern = re.compile(r'SYNTAX\s+([A-Za-z0-9_\-]+)')

    by_name = {}   # name -> list of definitions (in file order), each with its text position
    order = []     # every definition, in file order
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
        # Resolves an entry we already have in hand (its own parent/subid are
        # known directly — no name lookup needed for itself, only for its parent).
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
        # Resolves a *referenced* parent name by finding whichever definition
        # of that name appears nearest before this point in the file.
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

# MQTT live data
live_data = {}

# def on_message(client, userdata, msg):
#     try:
#         payload = json.loads(msg.payload)

#         # Use the device name from payload tags if present
#         device = payload.get("tags", {}).get("name", msg.topic.split('/')[0])

#         # Store fields in live_data
#         if 'fields' in payload:
#             live_data[device] = payload['fields']
#         else:
#             live_data[device] = payload

#     except Exception as e:
#         print("MQTT ERROR:", e)


def get_configured_device_names():
    """Extract 'name' field from all saved .conf files"""
    names = set()
    for f in os.listdir(CONFIG_DIR):
        if f.endswith('.conf'):
            try:
                with open(os.path.join(CONFIG_DIR, f)) as cf:
                    config = toml.load(cf)
                # Check modbus or snmp name
                for proto in ['modbus', 'snmp']:
                    entries = config.get('inputs', {}).get(proto, [])
                    for entry in entries:
                        if 'name' in entry:
                            names.add(entry['name'])
            except:
                pass
    return names

# def on_message(client, userdata, msg):
#     try:
#         payload = json.loads(msg.payload)
#         device = payload.get("tags", {}).get("name", msg.topic.split('/')[0])
        
#         print("MQTT received:", device, payload)  # ← ADD THIS
        

#         # ✅ Only allow configured device names
#         if device not in get_configured_device_names():
#             return

#         if 'fields' in payload:
#             live_data[device] = {
#                 "fields": payload['fields'],
#                 "timestamp": time.time()
#             }
#     except Exception as e:
#         print("MQTT ERROR:", e)



def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload)
        device = payload.get("tags", {}).get("name") or payload.get("name", msg.topic.split('/')[0])
        if 'fields' in payload:
            live_data[device] = {
                "fields": payload['fields'],
                "timestamp": time.time()
            }
    except Exception as e:
        print("MQTT ERROR:", e)



mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
mqtt_client.on_message = on_message
try:
    mqtt_client.connect("127.0.0.1", 1883, 60)
    mqtt_client.subscribe("#")
    threading.Thread(target=mqtt_client.loop_forever, daemon=True).start()
except Exception as err:
    print(f"MQTT failed: {err}")

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
            conf += '  transmission_mode = "TCP"\n'   # ← ADD
            conf += '  busy_retries = 3\n'            # ← ADD

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

          # ← ONLY for modbus
    conf += '\n[[outputs.mqtt]]\n'
    conf += '  servers = ["tcp://127.0.0.1:1883"]\n'
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
            is_existing = os.path.exists(filepath)
            if not is_existing:
                used = count_saved_configs()
                if used + 1 > MAX_CONFIGS:
                    return config_limit_error(used)
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
            used = count_saved_configs()
            if used > MAX_CONFIGS:
                return config_limit_error(used)
            create_systemd_service(name)
            subprocess.run(['systemctl', 'start', service_name], check=True)
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
            used = count_saved_configs()
            with open(original_path, 'r') as f:
                content = f.read()
            if used + 1 > MAX_CONFIGS:
                return config_limit_error(used)
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

        # basic validation
        mapping = data.get("mapping", {})
        used = set()

        for field, cfg in mapping.items():
            reg = cfg["register"]
            length = cfg.get("length", 1)

            if not (1 <= reg <= 100   or 10001 <= reg <= 10100 or 
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
        running = False  # or check actual service if needed

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
        # Example defaults for holding registers
        mapping = {
            "Voltage": {"register": 40001, "length": 1},
            "Current": {"register": 40003, "length": 1},
            "Power Factor": {"register": 40005, "length": 1},
            "Frequency": {"register": 40007, "length": 1}
        }
        return jsonify({"mapping": mapping})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/live/<device>', methods=['GET'])
def get_live_data(device):
    return jsonify(live_data.get(device, {'error': 'No data available'}))

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
    return jsonify(live_data)


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


def snmp_get_batch(host, port, community, oids):
    """Pure Python SNMP v1/v2c GET request implementation over UDP socket."""
    import socket
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
        parts = [int(p) for p in oid_str.strip('.').split('.')]
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

    # Build varbind list for OIDs (append .0 if not scalar/instance OID)
    varbinds_payload = b''
    formatted_oids = []
    for oid in oids:
        target_oid = oid if oid.endswith('.0') else oid + '.0'
        formatted_oids.append((oid, target_oid))
        varbind = encode_tlv(0x30, encode_oid(target_oid) + encode_tlv(0x05, b''))
        varbinds_payload += varbind

    varbind_list = encode_tlv(0x30, varbinds_payload)
    # GetRequest PDU (0xA0), request-id=1, error-status=0, error-index=0
    pdu = encode_tlv(0xA0, encode_integer(1) + encode_integer(0) + encode_integer(0) + varbind_list)
    # SNMP v2c Message: version=1 (SNMPv2c), community, pdu
    snmp_msg = encode_tlv(0x30, encode_integer(1) + encode_octet_string(community) + pdu)

    results = {}
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(5.0)
        sock.sendto(snmp_msg, (host, port))
        resp_data, _ = sock.recvfrom(65535)
        sock.close()

        # Parse SNMP Response BER
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
            val_data = data[pos:pos+length]
            pos += length
            return (tag, val_data), pos

        msg_tlv, _ = decode_ber(resp_data, 0)
        if msg_tlv and msg_tlv[0] == 0x30:
            # Inside Message Sequence: version, community, PDU
            pos = 0
            ver_tlv, pos = decode_ber(msg_tlv[1], pos)
            comm_tlv, pos = decode_ber(msg_tlv[1], pos)
            pdu_tlv, pos = decode_ber(msg_tlv[1], pos)
            if pdu_tlv and (pdu_tlv[0] & 0x1F) == 2:  # GetResponse PDU (0xA2)
                pdu_pos = 0
                req_id, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                err_stat, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                err_idx, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                vbl_tlv, pdu_pos = decode_ber(pdu_tlv[1], pdu_pos)
                if vbl_tlv and vbl_tlv[0] == 0x30:
                    vb_pos = 0
                    vb_index = 0
                    while vb_pos < len(vbl_tlv[1]) and vb_index < len(formatted_oids):
                        vb_item, vb_pos = decode_ber(vbl_tlv[1], vb_pos)
                        if vb_item and vb_item[0] == 0x30:
                            item_pos = 0
                            oid_item, item_pos = decode_ber(vb_item[1], item_pos)
                            val_item, item_pos = decode_ber(vb_item[1], item_pos)
                            orig_oid, target_oid = formatted_oids[vb_index]
                            if val_item:
                                tag, vdata = val_item
                                if tag == 0x02:  # INTEGER
                                    val = int.from_bytes(vdata, byteorder='big', signed=True)
                                elif tag == 0x04:  # OCTET STRING
                                    try:
                                        val = vdata.decode('utf-8')
                                    except:
                                        val = vdata.hex()
                                elif tag in (0x41, 0x42, 0x43, 0x46):  # Counter/Gauge/TimeTicks
                                    val = int.from_bytes(vdata, byteorder='big', signed=False)
                                else:
                                    val = None
                                if val is not None:
                                    results[orig_oid] = val
                                    results[target_oid] = val
                        vb_index += 1
    except Exception as err:
        print(f"SNMP direct query error: {err}")
    return results


@app.route('/api/snmp_live_query', methods=['POST'])
def snmp_live_query():
    try:
        data = request.json or {}
        host = data.get('host', '127.0.0.1')
        port = int(data.get('port', 161))
        community = data.get('community', 'public')
        oids = data.get('oids', [])
        if not oids:
            return jsonify({'values': {}})
        results = snmp_get_batch(host, port, community, oids[:50])
        return jsonify({'values': results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print('Starting Device UI server on http://0.0.0.0:2999/')
    app.run(host='0.0.0.0', port=2999, debug=False)
