document.addEventListener('DOMContentLoaded', () => {

    let activeDevice = null;

    const configList = document.getElementById('configList');
    const testOutput = document.getElementById('testOutput');
    const themeToggle = document.getElementById('themeToggle');

    let existingConfigNames = [];
    let lastKnownStatuses = {};

    function showConfigLimitPopup(error) {
        const response = error.response?.data;
        if (response?.error !== 'license_limit') return false;
        alert(response.message || 'Configuration limit exceeded. Remove a saved config before adding another.');
        return true;
    }

    // =========================================================
    // CONFIG LIST
    // =========================================================
    function renderConfigs() {
        if (typeof axios === 'undefined') {
            testOutput.textContent = 'Axios not loaded';
            return;
        }
        axios.get('/configs').then(res => {
            configList.innerHTML = '';
            existingConfigNames = res.data.map(f => f.replace('.conf', ''));
            const promises = res.data.map(filename => {
                const name = filename.replace('.conf', '');
                return axios.get(`/service_status/${name}`)
                    .then(statusRes => ({ filename, name, status: statusRes.data.status }))
                    .catch(() => ({ filename, name, status: 'unknown' }));
            });
            Promise.all(promises).then(configs => {
                configs.forEach(({ filename, name, status }) => {
                    lastKnownStatuses[name] = status;
                    const row = document.createElement('tr');
                    row.dataset.configName = name;
                    row.innerHTML = `
                        <td class="config-name p-3 cursor-pointer">${filename}</td>
                        <td class="config-status ${status} p-3">${status.charAt(0).toUpperCase() + status.slice(1)}</td>
                        <td class="config-actions p-1 flex space-x-1">
    <button class="bg-green-500 text-white px-1 py-0.5 text-xs rounded hover:bg-green-600">Run</button>
    <button class="bg-red-500 text-white px-1 py-0.5 text-xs rounded hover:bg-red-600">Stop</button>
    <button class="bg-yellow-500 text-white px-1 py-0.5 text-xs rounded hover:bg-yellow-600">Edit</button>
    <button class="bg-red-600 text-white px-1 py-0.5 text-xs rounded hover:bg-red-700">Delete</button>
    <button class="bg-blue-500 text-white px-1 py-0.5 text-xs rounded hover:bg-blue-600">Test</button>
    <button class="bg-green-600 text-white px-1 py-0.5 text-xs rounded hover:bg-green-700">Save</button>
    <button class="bg-purple-600 text-white px-1 py-0.5 text-xs rounded hover:bg-purple-700">Copy</button>
</td>
                    `;
                    const cells = row.querySelectorAll('td');
                    const actions = row.querySelectorAll('button');

                    cells[0].addEventListener('click', () => loadConfig(name));
                    actions[0].addEventListener('click', () => startService(name));
                    actions[1].addEventListener('click', () => stopService(name));
                    actions[2].addEventListener('click', () => editConfig(name));
                    actions[3].addEventListener('click', () => deleteConfig(name));
                    actions[4].addEventListener('click', () => testConfig(name));
                    actions[5].addEventListener('click', () => {
    downloadConfig(name);
    editConfig(name);
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="overview"]').classList.add('active');
    document.getElementById('tab-overview').classList.add('active');
});
                    actions[6].addEventListener('click', () => duplicateConfig(name));

                    configList.appendChild(row);
                });
            });
        }).catch(err => {
            testOutput.textContent = `Error loading configurations: ${err.message}`;
        });
    }

    function updateStatuses() {
        const names = existingConfigNames;
        const promises = names.map(name =>
            axios.get(`/service_status/${name}`)
                .then(res => ({ name, status: res.data.status }))
                .catch(() => ({ name, status: 'unknown' }))
        );
        Promise.all(promises).then(statuses => {
            statuses.forEach(({ name, status }) => {
                if (lastKnownStatuses[name] !== status) {
                    lastKnownStatuses[name] = status;
                    const row = configList.querySelector(`tr[data-config-name="${name}"]`);
                    if (row) {
                        const cell = row.querySelector('.config-status');
                        cell.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                        cell.className = `config-status ${status} p-3`;
                    }
                }
            });
        });
    }

    function startStatusPolling() {
        setInterval(updateStatuses, 20000);
    }

    // window.startService = name => {
    //     axios.post(`/start_service/${name}`)
    //         .then(() => { testOutput.textContent = `Started ${name}`; updateStatuses(); })
    //         .catch(err => { testOutput.textContent = `Error starting ${name}: ${err.message}`; updateStatuses(); });
    // };


    window.startService = name => {
    axios.post(`/start_service/${name}`)
        .then(() => {
            testOutput.textContent = `Started ${name}`;
            updateStatuses();
            editConfig(name);  // ← loads overview for selected device
        })
        .catch(err => {
            if (showConfigLimitPopup(err)) {
                testOutput.textContent = err.response.data.message;
            } else {
                testOutput.textContent = `Error starting ${name}: ${err.message}`;
            }
            updateStatuses();
        });
};

    // window.stopService = name => {
    //     axios.post(`/stop_service/${name}`)
    //         .then(() => { testOutput.textContent = `Stopped ${name}`; updateStatuses(); })
    //         .catch(err => { testOutput.textContent = `Error stopping ${name}: ${err.message}`; updateStatuses(); });
    // };


    window.stopService = name => {
    axios.post(`/stop_service/${name}`)
        .then(() => {
            testOutput.textContent = `Stopped ${name}`;
            updateStatuses();
            if (activeDevice === name) {
                activeDevice = null;
                if (pollTimer) clearInterval(pollTimer);
                ['ov-protocol','ov-host','ov-port','ov-slave','ov-timeout']
                    .forEach(id => document.getElementById(id).textContent = '—');
                document.getElementById('ov-registers').innerHTML = '';
                document.getElementById('ov-tags').innerHTML = '';
                document.getElementById('ov-integrations').innerHTML = '';
                document.getElementById('modbusSection').style.display = 'none';
                if (typeof renderLiveMetricsBody === 'function') renderLiveMetricsBody(null);
                configForm.reset();
                currentRegisters = []; currentFields = []; currentTags = []; currentInflux = [];
                renderRegisters(); renderFields(); renderTags(); renderInflux();
                document.getElementById('hdr-name').textContent = 'Select a device';
                document.getElementById('hdr-status').style.display = 'none';
                document.getElementById('hdr-info').textContent = 'Configure or create a new device below';
                cancelEditBtn.style.display = 'none';
                deviceNameInput.disabled = false;
            }
        })
        .catch(err => { testOutput.textContent = `Error stopping ${name}: ${err.message}`; updateStatuses(); });
};

    // function loadConfig(name) {
    //     axios.get(`/config/${name}`).then(() => {
    //         testOutput.textContent = `Loaded configuration: ${name}.conf`;
    //     }).catch(err => {
    //         testOutput.textContent = `Error loading ${name}: ${err.message}`;
    //     });
    // }
    function loadConfig(name) {
    editConfig(name);
}


    window.editConfig = function(name) {
        currentRegisters = [];
        currentFields = [];
        currentTags = [];
        currentInflux = [];
        editingRegisterIndexInput.value = '-1';
        editingFieldIndexInput.value = '-1';
        editingTagIndexInput.value = '-1';
        editingInfluxIndex = -1;



        // ← ADD HERE
    if (typeof renderLiveMetricsBody === 'function') renderLiveMetricsBody(null);

    

        addRegisterBtn.textContent = 'Add Field';
        addRegisterBtn.onclick = addRegister;
        addFieldBtn.textContent = 'Add Field';
        addFieldBtn.onclick = addField;
        addTagBtn.textContent = 'Add Tag';
        addTagBtn.onclick = addTag;
        addInfluxBtn.textContent = 'Add InfluxDB';
        addInfluxBtn.onclick = addInflux;

        axios.get(`/config/${name}`).then(res => {
            const data = res.data;

            editingConfigNameInput.value = name;
            deviceNameInput.value = data.name || '';
            configForm.timeout.value = data.timeout || '1s';
            configForm.interval.value = data.interval || '10s';
            configForm.protocol.value = data.protocol || 'tcp';
            toggleProtocolFields(configForm.protocol.value);

            if (data.protocol === 'tcp') {
                document.querySelector('#tcpFields input[name="host"]').value = data.host || '';
                document.querySelector('#tcpFields input[name="port"]').value = data.port || '';
                configForm.slave_id.value = data.slave_id || '';
            } else if (data.protocol === 'rtu') {
                configForm.controller.value = data.controller || '';
                configForm.baud_rate.value = data.baud_rate || '';
                configForm.data_bits.value = data.data_bits || '';
                configForm.parity.value = data.parity || '';
                configForm.stop_bits.value = data.stop_bits || '';
                configForm.slave_id.value = data.slave_id || '';
            } else if (data.protocol === 'snmp') {
                document.querySelector('#snmpFields input[name="host"]').value = data.host || '';
                document.querySelector('#snmpFields input[name="port"]').value = data.port || '';
                configForm.version.value = data.version || '2';
                configForm.community.value = data.community || '';
                configForm.sec_name.value = data.sec_name || '';
                configForm.sec_level.value = data.sec_level || 'noAuthNoPriv';
                configForm.auth_protocol.value = data.auth_protocol || '';
                configForm.auth_password.value = data.auth_password || '';
                configForm.priv_protocol.value = data.priv_protocol || '';
                configForm.priv_password.value = data.priv_password || '';
                toggleSnmpV3Fields();
            }

            if (data.registers && Array.isArray(data.registers)) {
                currentRegisters = data.registers.map(reg => ({
                    type: reg.type,
                    name: reg.name,
                    address: Array.isArray(reg.address) ? reg.address.join(',') : reg.address,
                    byte_order: reg.byte_order || 'AB',
                    data_type: reg.data_type || 'BIT',
                    scale: reg.scale || 1.0
                }));
            }
            renderRegisters();

            if (data.fields && Array.isArray(data.fields)) {
                currentFields = data.fields.map(f => ({
                    name: f.name,
                    oid: f.oid,
                    is_tag: f.is_tag || false
                }));
            }
            renderFields();

            currentTags = Array.isArray(data.tags)
                ? data.tags
                : Object.entries(data.tags || {}).map(([key, val]) => ({ label: key, value: val }));
            renderTags();

            const influxData = Array.isArray(data.influxdb) ? data.influxdb : [data.influxdb];
            influxData.forEach(db => {
                currentInflux.push({
                    url: Array.isArray(db.urls) ? db.urls[0] : db.urls,
                    token: db.token || '',
                    org: db.organization || db.org || '',
                    bucket: db.bucket || ''
                });
            });
            renderInflux();

            // ── Populate Overview Tab ──
document.getElementById('ov-protocol').textContent = data.protocol || '—';
document.getElementById('ov-host').textContent = data.host || '—';
document.getElementById('ov-port').textContent = data.port || '—';
document.getElementById('ov-slave').textContent = data.slave_id || '—';
document.getElementById('ov-timeout').textContent = data.timeout || '—';



// Populate registers overview
// const ovRegs = document.getElementById('ov-registers');
// if (ovRegs) {
//     ovRegs.innerHTML = currentRegisters.map(r =>
//         `<tr><td>${r.name}</td><td>${r.type}</td><td>${r.address}</td></tr>`
//     ).join('');
// }
const ovRegs = document.getElementById('ov-registers');
if (ovRegs) {
    if (currentRegisters.length > 0) {
        ovRegs.innerHTML = currentRegisters.map(r =>
            `<tr><td>${r.name}</td><td>${r.type}</td><td>${r.address}</td></tr>`
        ).join('');
    } else {
        // show SNMP fields instead
        ovRegs.innerHTML = currentFields.map(f =>
            `<tr><td>${f.name}</td><td>snmp</td><td>${f.oid}</td></tr>`
        ).join('');
    }
}
// Populate tags overview  
const ovTags = document.getElementById('ov-tags');
if (ovTags) {
    ovTags.innerHTML = currentTags.map(t =>
        `<tr><td>${t.label||t}</td><td>${t.value||''}</td></tr>`
    ).join('');
}


// Populate integrations overview
const ovInteg = document.getElementById('ov-integrations');
if (ovInteg) {
    ovInteg.innerHTML = currentInflux.map(db =>
        `<tr><td>${db.url}</td><td>${db.org}</td><td>${db.bucket}</td></tr>`
    ).join('');
}

            cancelEditBtn.style.display = 'inline-block';
            deviceNameInput.disabled = true;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            testOutput.textContent = `Loaded all fields for: ${name}.conf`;
            activeDevice = name;          // REQUIRED
            window.activeProtocol = data.protocol;  // ← ADD THIS
startLiveDataPolling();
            axios.get('/api/modbus_config').then(res => {
    mbMapping = res.data.mapping || {};
    document.getElementById('modbusSection').style.display = 'block';
    renderMbRegisterPick();
}).catch(() => {});

        }).catch(err => {
            alert(`Error loading config: ${err.response?.data?.error || err.message}`);
        });
    }

    window.deleteConfig = function(name)  {
        if (!confirm(`Delete ${name}.conf?`)) return;
        axios.delete(`/config/${name}`).then(() => {
            testOutput.textContent = `Deleted ${name}.conf`;
            renderConfigs();
        }).catch(err => { testOutput.textContent = `Error deleting ${name}: ${err.message}`; });
    }

    function analyzeTestOutput(output) {
        const issues = [];
        const text = output || '';

        // Device disconnected / unreachable
        if (/connection refused|no route to host|network is unreachable|i\/o timeout|timed out|request timeout|no response|exception '?11'?|gateway target device/i.test(text)) {
            issues.push('Device disconnected or not responding (check host, port, slave ID, cable/network)');
        }
        // Modbus register errors
        if (/illegal data address|exception '?2'?/i.test(text)) {
            issues.push('Register error: illegal data address (wrong address or register type, e.g. input vs holding)');
        }
        if (/illegal data value|exception '?3'?/i.test(text)) {
            issues.push('Register error: illegal data value (check data type / address count)');
        }
        if (/slave device failure|exception '?4'?/i.test(text)) {
            issues.push('Device reported an internal failure (slave device failure)');
        }
        if (/illegal function|exception '?1'?/i.test(text)) {
            issues.push('Register error: illegal function (device does not support this register type)');
        }
        // SNMP
        if (/authentication failure|unknown user name|wrong digest|unsupported security level/i.test(text)) {
            issues.push('SNMP authentication error (check community / SNMPv3 credentials)');
        }
        if (/no such object|no such instance|nosuchname/i.test(text)) {
            issues.push('SNMP error: OID not found on device');
        }
        // Any other Telegraf error lines
        const errLines = text.split('\n').filter(l => /\bE!|\bError\b|panic|fatal/i.test(l));
        if (errLines.length && issues.length === 0) {
            issues.push('Errors reported:\n   ' + errLines.slice(0, 5).join('\n   '));
        }
        // Empty output = nothing was collected
        if (!text.trim()) {
            issues.push('No output received from device');
        }
        return issues;
    }

    window.testConfig = function (name) {
        testOutput.textContent = `Testing ${name}...`;
        testOutput.style.color = '';

        axios.get(`/test_config/${name}`, { validateStatus: () => true })
            .then(res => {
                const data = res.data || {};
                const output = typeof data === 'string'
                    ? data
                    : (data.output || data.error || data.message || '');
                const failedStatus = res.status >= 400 || /error|fail/i.test(String(data.status || ''));
                const issues = analyzeTestOutput(output);

                if (failedStatus || issues.length > 0) {
                    testOutput.style.color = '#ef4444';
                    testOutput.textContent =
                        `Test FAILED for ${name}\n\n` +
                        (issues.length ? issues.join('\n') + '\n\n' : '') +
                        `--- Raw output ---\n${output || '(empty)'}`;
                } else {
                    testOutput.style.color = '#16a34a';
                    testOutput.textContent = `Test passed for ${name}\n\n${output}`;
                }
            })
            .catch(err => {
                testOutput.style.color = '#ef4444';
                testOutput.textContent = `Could not reach the server: ${err.message}`;
            });
    };

    function downloadConfig(name) {
        window.location.href = `/download/${name}`;
    }

    window.duplicateConfig = function(name) {
        const newName = prompt(`Enter new name for duplicate of ${name}:`);
        if (!newName || existingConfigNames.includes(newName)) {
            testOutput.textContent = 'Invalid or duplicate name';
            return;
        }
        axios.post(`/duplicate_config/${name}`, { new_name: newName })
            .then(res => { testOutput.textContent = `${res.data.message}`; renderConfigs(); })
            .catch(err => {
                if (showConfigLimitPopup(err)) {
                    testOutput.textContent = err.response.data.message;
                } else {
                    testOutput.textContent = `Error duplicating: ${err.message}`;
                }
            });
    }

    // Dark mode
    if (localStorage.getItem('darkMode') === 'false') {
        document.body.classList.remove('dark');
    }
    themeToggle.addEventListener('click', () => {
        document.body.classList.toggle('dark');
        localStorage.setItem('darkMode', document.body.classList.contains('dark'));
    });

    // Search
    const searchInput = document.getElementById('configSearch');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            const filter = this.value.toLowerCase();
            document.querySelectorAll('#configList tr').forEach(row => {
                const nameCell = row.querySelector('td');
                if (!nameCell) return;
                row.style.display = nameCell.textContent.toLowerCase().includes(filter) ? '' : 'none';
            });
        });
    }

    renderConfigs();
    startStatusPolling();

    // =========================================================
    // FORM ELEMENTS
    // =========================================================
    const configForm = document.getElementById('configForm');
    const registersTable = document.getElementById('registersTable');
    const fieldsTable = document.getElementById('fieldsTable');
    const tagsTable = document.getElementById('tagsTable');
    const byteOrderLabel = document.getElementById('byteOrderLabel');
    const byteOrderWarning = document.getElementById('byteOrderWarning');
    const regAddress = document.getElementById('regAddress');
    const editingConfigNameInput = document.getElementById('editingConfigName');
    const deviceNameInput = document.getElementById('name');
    const addRegisterBtn = document.getElementById('addRegisterBtn');
    const addFieldBtn = document.getElementById('addFieldBtn');
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    const editingRegisterIndexInput = document.getElementById('editingRegisterIndex');
    const editingFieldIndexInput = document.getElementById('editingFieldIndex');
    const registerTypeSelect = document.getElementById('registerType');
    const byteOrderGroup = document.getElementById('byteOrderGroup');
    const dataTypeGroup = document.getElementById('dataTypeGroup');
    const scaleGroup = document.getElementById('scaleGroup');
    const addTagBtn = document.getElementById('addTagBtn');
    const editingTagIndexInput = document.getElementById('editingTagIndex');
    const influxUrls = document.getElementById('influxUrls');
    const influxToken = document.getElementById('influxToken');
    const influxOrg = document.getElementById('influxOrg');
    const influxBucket = document.getElementById('influxBucket');
    const modbusRegistersSection = document.getElementById('modbusRegistersSection');
    const snmpFieldsSection = document.getElementById('snmpFieldsSection');

    if (!configForm || !registersTable || !fieldsTable || !tagsTable || !byteOrderLabel || !byteOrderWarning || !regAddress || !editingConfigNameInput || !deviceNameInput || !addRegisterBtn || !addFieldBtn || !cancelEditBtn || !editingRegisterIndexInput || !editingFieldIndexInput || !registerTypeSelect || !byteOrderGroup || !dataTypeGroup || !scaleGroup || !addTagBtn || !editingTagIndexInput || !influxUrls || !influxToken || !influxOrg || !influxBucket || !modbusRegistersSection || !snmpFieldsSection) {
        console.error('Required DOM elements are missing');
        return;
    }

    // ── SNMPv3: show sec_name/sec_level/auth/priv fields instead of Community
    // whenever Version = 3 is selected ──────────────────────────────────────
    function toggleSnmpV3Fields() {
        const isV3 = parseInt(configForm.version.value) === 3;
        const communityField = document.getElementById('communityField');
        const v3Fields = document.getElementById('snmpV3Fields');
        if (communityField) communityField.style.display = isV3 ? 'none' : '';
        if (v3Fields) v3Fields.style.display = isV3 ? 'block' : 'none';
    }
    configForm.version?.addEventListener('change', toggleSnmpV3Fields);

    let currentRegisters = [];
    let currentFields = [];
    let currentTags = [];
    let currentInflux = [];

    // =========================================================
    // REGISTER FIELD VISIBILITY
    // =========================================================
    function toggleRegisterFields() {
        const registerType = registerTypeSelect.value;
        const isBinaryType = ['discrete_inputs', 'coils'].includes(registerType);
        byteOrderGroup.style.display = isBinaryType ? 'none' : 'block';
        dataTypeGroup.style.display = isBinaryType ? 'none' : 'block';
        scaleGroup.style.display = isBinaryType ? 'none' : 'block';
        if (isBinaryType) {
            byteOrderWarning.textContent = '';
            regAddress.placeholder = 'e.g., 0';
        } else {
            updateByteOrderWarning();
        }
    }

    function updateByteOrderWarning() {
        const dataTypeSelect = document.getElementById('dataType');
        const byteOrderSelect = document.getElementById('byteOrder');
        if (!dataTypeSelect || !byteOrderSelect) return;
        const dataType = dataTypeSelect.value;
        const byteOrder = byteOrderSelect.value;
        const recommendedOptions = {
            'BIT': ['AB', 'BA'], 'INT8L': ['AB', 'BA'], 'INT8H': ['AB', 'BA'], 'UINT8L': ['AB', 'BA'], 'UINT8H': ['AB', 'BA'],
            'INT16': ['AB', 'BA'], 'UINT16': ['AB', 'BA'], 'FIXED': ['AB', 'BA'], 'UFIXED': ['AB', 'BA'], 'FLOAT16-IEEE': ['AB', 'BA'],
            'INT32': ['ABCD', 'DCBA', 'BADC', 'CDAB'], 'UINT32': ['ABCD', 'DCBA', 'BADC', 'CDAB'], 'FLOAT32-IEEE': ['ABCD', 'DCBA', 'BADC', 'CDAB'],
            'INT64': ['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'], 'UINT64': ['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'], 'FLOAT64-IEEE': ['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'],
            'STRING': []
        };
        if (dataType === 'STRING') {
            byteOrderWarning.textContent = 'STRING does not require a byte order';
            byteOrderLabel.style.display = 'none';
        } else {
            byteOrderLabel.style.display = 'block';
            if (!recommendedOptions[dataType].includes(byteOrder)) {
                byteOrderWarning.textContent = `${byteOrder} is not recommended for ${dataType}. Recommended: ${recommendedOptions[dataType].join(', ')}`;
            } else {
                byteOrderWarning.textContent = '';
            }
        }
        const addressCounts = {
            'BIT': 'e.g., 0', 'INT8L': 'e.g., 0', 'INT8H': 'e.g., 0', 'UINT8L': 'e.g., 0', 'UINT8H': 'e.g., 0',
            'INT16': 'e.g., 0', 'UINT16': 'e.g., 0', 'FIXED': 'e.g., 0', 'UFIXED': 'e.g., 0', 'FLOAT16-IEEE': 'e.g., 0',
            'INT32': 'e.g., 0,1', 'UINT32': 'e.g., 0,1', 'FLOAT32-IEEE': 'e.g., 0,1',
            'INT64': 'e.g., 0,1,2,3', 'UINT64': 'e.g., 0,1,2,3', 'FLOAT64-IEEE': 'e.g., 0,1,2,3',
            'STRING': 'e.g., 0,1,2'
        };
        regAddress.placeholder = addressCounts[dataType];
    }

    // =========================================================
    // VALIDATION
    // =========================================================
    function validateRegister(reg) {
        const errors = [];
        if (!reg.name) errors.push('Field name is required');
        const addresses = reg.address.split(',').map(a => a.trim());
        const registerType = reg.type;
        try {
            addresses.forEach(a => { if (isNaN(a) || parseInt(a) < 0) throw new Error('Invalid address'); });
            const addressCounts = {
                'discrete_inputs': 1, 'coils': 1,
                'BIT': 1, 'INT8L': 1, 'INT8H': 1, 'UINT8L': 1, 'UINT8H': 1,
                'INT16': 1, 'UINT16': 1, 'FIXED': 1, 'UFIXED': 1, 'FLOAT16-IEEE': 1,
                'INT32': 2, 'UINT32': 2, 'FLOAT32-IEEE': 2,
                'INT64': 4, 'UINT64': 4, 'FLOAT64-IEEE': 4,
                'STRING': addresses.length >= 1
            };
            if (['discrete_inputs', 'coils'].includes(registerType)) {
                if (addresses.length !== 1) errors.push('Discrete Inputs and Coils require exactly 1 address');
            } else {
                const dataType = reg.data_type;
                if (dataType !== 'STRING' && addresses.length !== addressCounts[dataType]) {
                    errors.push(`${dataType} requires ${addressCounts[dataType]} address(es)`);
                } else if (dataType === 'STRING' && addresses.length < 1) {
                    errors.push('STRING requires at least one address');
                }
            }
            return errors;
        } catch (e) {
            errors.push('Invalid address format');
            return errors;
        }
    }

    function validateField(field, index) {
        const errors = [];
        if (!field.name) errors.push('Field name is required');
        if (!field.oid) errors.push('OID is required');
        if (currentFields.findIndex((f, i) => f.name === field.name && i !== index) !== -1) errors.push('Field name must be unique');
        return errors;
    }

    function validateTag(tag, index) {
        const errors = [];
        if (!tag.label) errors.push('Tag label is required');
        if (!tag.value) errors.push('Tag value is required');
        if (currentTags.findIndex((t, i) => t.label === tag.label && i !== index) !== -1) errors.push('Tag label must be unique');
        return errors;
    }

    function validateInfluxDB() {
        const errors = [];
        if (currentInflux.length === 0) {
            errors.push('At least one InfluxDB entry is required');
        } else {
            currentInflux.forEach((db, index) => {
                if (!db.url) errors.push(`InfluxDB entry ${index + 1}: URL is required`);
                if (!db.token) errors.push(`InfluxDB entry ${index + 1}: Token is required`);
                if (!db.org) errors.push(`InfluxDB entry ${index + 1}: Organization is required`);
                if (!db.bucket) errors.push(`InfluxDB entry ${index + 1}: Bucket is required`);
            });
        }
        return errors;
    }

    function validateForm() {
        const errors = [];
        const protocol = configForm.protocol.value;
        const timeout = configForm.timeout.value;
        if (!configForm.name.value) errors.push('Device name is required');
        if (!timeout.match(/^\d+(ms|s)$/)) errors.push('Timeout must be in the format "5s" or "500ms"');

        if (protocol === 'tcp') {
            const hostField = document.getElementById('host');
            const portField = document.querySelector('#tcpFields input[name="port"]');
            if (!hostField.value) errors.push('Host is required for Modbus TCP');
            const portValue = portField.value.trim();
            if (!portValue) { errors.push('Port is required for Modbus TCP'); }
            else { const port = parseInt(portValue); if (isNaN(port) || port <= 0 || port > 65535) errors.push('Port must be a valid number between 1 and 65535 for Modbus TCP'); }
        } else if (protocol === 'rtu') {
            if (!configForm.controller.value.trim()) errors.push('Controller is required for Modbus RTU');
        } else if (protocol === 'snmp') {
            const hostField = document.querySelector('#snmpFields input[name="host"]');
            const portField = document.querySelector('#snmpFields input[name="port"]');
            if (!hostField.value) errors.push('Host is required for SNMP');
            const portValue = portField.value.trim();
            if (!portValue) { errors.push('Port is required for SNMP'); }
            else { const port = parseInt(portValue); if (isNaN(port) || port <= 0 || port > 65535) errors.push('Port must be a valid number between 1 and 65535 for SNMP'); }
            if (![1, 2, 3].includes(parseInt(configForm.version.value))) errors.push('SNMP version must be 1, 2, or 3');
            const snmpVersion = parseInt(configForm.version.value);
            if (snmpVersion === 3) {
                if (!configForm.sec_name.value.trim()) errors.push('Security Name is required for SNMPv3');
                const secLevel = configForm.sec_level.value;
                if ((secLevel === 'authNoPriv' || secLevel === 'authPriv') && (!configForm.auth_protocol.value || !configForm.auth_password.value)) {
                    errors.push('Auth protocol and password are required for the selected SNMPv3 security level');
                }
                if (secLevel === 'authPriv' && (!configForm.priv_protocol.value || !configForm.priv_password.value)) {
                    errors.push('Privacy protocol and password are required for authPriv security level');
                }
            } else if (!configForm.community.value) {
                errors.push('SNMP community string is required');
            }
        }
        return errors.concat(validateInfluxDB());
    }

    // =========================================================
    // RENDER FUNCTIONS
    // =========================================================
    function renderRegisters() {
        registersTable.innerHTML = '';
        currentRegisters.forEach((reg, index) => {
            const isBinaryType = ['discrete_inputs', 'coils'].includes(reg.type);
            const row = document.createElement('tr');
            row.innerHTML = `
    <td class="p-3 text-center"><input type="checkbox" checked class="reg-enable" data-index="${index}"></td>
    <td class="p-3">${reg.type}</td>
    <td class="p-3"><input type="text" value="${reg.name}" class="reg-name border p-1 text-xs w-full" data-index="${index}"></td>
    <td class="p-3"><input type="text" value="${reg.address}" class="reg-address border p-1 text-xs w-full" data-index="${index}"></td>
    <td class="p-3">${isBinaryType ? '-' : (reg.data_type === 'STRING' ? '-' : `<input type="text" value="${reg.byte_order}" class="reg-order border p-1 text-xs w-full" data-index="${index}">`)}</td>
    <td class="p-3">${isBinaryType ? '-' : `<input type="text" value="${reg.data_type}" class="reg-datatype border p-1 text-xs w-full" data-index="${index}">`}</td>
    <td class="p-3">${isBinaryType ? '-' : `<input type="number" value="${reg.scale}" class="reg-scale border p-1 text-xs w-full" data-index="${index}">`}</td>
    <td class="p-3 flex space-x-2">
        <button type="button" onclick="editRegister(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md hover:bg-yellow-600"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
        <button type="button" onclick="deleteRegister(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md hover:bg-red-600"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
    </td>`;
            registersTable.appendChild(row);
        });
    }

    function renderFields() {
        fieldsTable.innerHTML = '';
        currentFields.forEach((field, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
    <td class="p-3 text-center"><input type="checkbox" checked class="field-enable" data-index="${index}"></td>
    <td class="p-3"><input type="text" value="${field.name}" class="field-name border p-1 text-xs w-full" data-index="${index}"></td>
    <td class="p-3"><input type="text" value="${field.oid}" class="field-oid border p-1 text-xs w-full" data-index="${index}"></td>
    <td class="p-3">${field.is_tag ? 'Yes' : 'No'}</td>
    <td class="p-3 flex space-x-2">
        <button type="button" onclick="editField(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md hover:bg-yellow-600"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
        <button type="button" onclick="deleteField(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md hover:bg-red-600"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
    </td>`;
            fieldsTable.appendChild(row);
        });
    }

    function renderTags() {
        tagsTable.innerHTML = '';
        currentTags.forEach((tag, index) => {
            const label = typeof tag === 'object' ? tag.label : tag;
            const value = typeof tag === 'object' ? tag.value : '';
            const row = document.createElement('tr');
            row.innerHTML = `
    <td class="p-3 text-center"><input type="checkbox" checked class="tag-enable" data-index="${index}"></td>
    <td class="p-3"><input type="text" value="${label || ''}" class="tag-label border p-1 text-xs w-full" data-index="${index}"></td>
    <td class="p-3"><input type="text" value="${value || ''}" class="tag-value border p-1 text-xs w-full" data-index="${index}"></td>
    <td class="p-3 flex space-x-2">
        <button type="button" onclick="editTag(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
        <button type="button" onclick="deleteTag(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
    </td>`;
            tagsTable.appendChild(row);
        });
    }

    // =========================================================
    // REGISTER CRUD
    // =========================================================
    window.addRegister = () => {
        const registerType = document.getElementById('registerType');
        const regName = document.getElementById('regName');
        const regAddress = document.getElementById('regAddress');
        const byteOrder = document.getElementById('byteOrder');
        const dataType = document.getElementById('dataType');
        const regScale = document.getElementById('regScale');
        if (!registerType || !regName || !regAddress || !byteOrder || !dataType || !regScale) { alert('Error: Field form elements not found'); return; }
        const isBinaryType = ['discrete_inputs', 'coils'].includes(registerType.value);
        const reg = { type: registerType.value, name: regName.value, address: regAddress.value };
        if (!isBinaryType) { reg.byte_order = byteOrder.value; reg.data_type = dataType.value; reg.scale = parseFloat(regScale.value) || 1.0; }
        const errors = validateRegister(reg);
        if (errors.length > 0) { alert(`${errors.join('; ')}`); return; }
        currentRegisters.push(reg);
        renderRegisters();
        alert('Field added');
        resetRegisterForm();
    };

    window.updateRegister = () => {
        const registerType = document.getElementById('registerType');
        const regName = document.getElementById('regName');
        const regAddress = document.getElementById('regAddress');
        const byteOrder = document.getElementById('byteOrder');
        const dataType = document.getElementById('dataType');
        const regScale = document.getElementById('regScale');
        const editingIndex = parseInt(editingRegisterIndexInput.value);
        const isBinaryType = ['discrete_inputs', 'coils'].includes(registerType.value);
        const reg = { type: registerType.value, name: regName.value, address: regAddress.value };
        if (!isBinaryType) { reg.byte_order = byteOrder.value; reg.data_type = dataType.value; reg.scale = parseFloat(regScale.value) || 1.0; }
        const errors = validateRegister(reg);
        if (errors.length > 0) { alert(`${errors.join('; ')}`); return; }
        currentRegisters[editingIndex] = reg;
        renderRegisters();
        alert('Field updated');
        resetRegisterForm();
    };

    function resetRegisterForm() {
        document.getElementById('registerType').value = 'discrete_inputs';
        document.getElementById('regName').value = '';
        document.getElementById('regAddress').value = '';
        document.getElementById('byteOrder').value = 'AB';
        document.getElementById('dataType').value = 'BIT';
        document.getElementById('regScale').value = '1.0';
        editingRegisterIndexInput.value = '-1';
        addRegisterBtn.textContent = 'Add Field';
        addRegisterBtn.onclick = addRegister;
        toggleRegisterFields();
    }

    window.deleteRegister = (index) => { currentRegisters.splice(index, 1); renderRegisters(); alert('Field deleted'); };
    window.editRegister = (index) => {
        const reg = currentRegisters[index];
        document.getElementById('registerType').value = reg.type;
        document.getElementById('regName').value = reg.name;
        document.getElementById('regAddress').value = reg.address;
        if (!['discrete_inputs', 'coils'].includes(reg.type)) {
            document.getElementById('byteOrder').value = reg.byte_order;
            document.getElementById('dataType').value = reg.data_type;
            document.getElementById('regScale').value = reg.scale;
        }
        toggleRegisterFields();
        editingRegisterIndexInput.value = index;
        addRegisterBtn.textContent = 'Update Field';
        addRegisterBtn.onclick = updateRegister;
    };

    // =========================================================
    // FIELD CRUD
    // =========================================================
    window.addField = () => {
        const field = { name: document.getElementById('fieldName').value, oid: document.getElementById('fieldOid').value, is_tag: document.getElementById('fieldIsTag').checked };
        const errors = validateField(field, -1);
        if (errors.length > 0) { alert(`${errors.join('; ')}`); return; }
        currentFields.push(field);
        renderFields();
        alert('Field added');
        resetFieldForm();
    };
    window.updateField = () => {
        const editingIndex = parseInt(editingFieldIndexInput.value);
        const field = { name: document.getElementById('fieldName').value, oid: document.getElementById('fieldOid').value, is_tag: document.getElementById('fieldIsTag').checked };
        const errors = validateField(field, editingIndex);
        if (errors.length > 0) { alert(`${errors.join('; ')}`); return; }
        currentFields[editingIndex] = field;
        renderFields();
        alert('Field updated');
        resetFieldForm();
    };
    function resetFieldForm() {
        document.getElementById('fieldName').value = '';
        document.getElementById('fieldOid').value = '';
        document.getElementById('fieldIsTag').checked = false;
        editingFieldIndexInput.value = '-1';
        addFieldBtn.textContent = 'Add Field';
        addFieldBtn.onclick = addField;
    }
    window.deleteField = (index) => { currentFields.splice(index, 1); renderFields(); alert('Field deleted'); };
    window.editField = (index) => {
        const field = currentFields[index];
        document.getElementById('fieldName').value = field.name;
        document.getElementById('fieldOid').value = field.oid;
        document.getElementById('fieldIsTag').checked = field.is_tag;
        editingFieldIndexInput.value = index;
        addFieldBtn.textContent = 'Update Field';
        addFieldBtn.onclick = updateField;
    };

    // =========================================================
    // TAG CRUD
    // =========================================================
    window.addTag = () => {
        const tag = { label: document.getElementById('tagLabel').value, value: document.getElementById('tagValue').value };
        const errors = validateTag(tag, -1);
        if (errors.length > 0) { alert(`${errors.join('; ')}`); return; }
        currentTags.push(tag);
        renderTags();
        alert('Tag added');
        resetTagForm();
    };
    window.updateTag = () => {
        const editingIndex = parseInt(editingTagIndexInput.value);
        const tag = { label: document.getElementById('tagLabel').value, value: document.getElementById('tagValue').value };
        const errors = validateTag(tag, editingIndex);
        if (errors.length > 0) { alert(`${errors.join('; ')}`); return; }
        currentTags[editingIndex] = tag;
        renderTags();
        alert('Tag updated');
        resetTagForm();
    };
    function resetTagForm() {
        document.getElementById('tagLabel').value = '';
        document.getElementById('tagValue').value = '';
        editingTagIndexInput.value = '-1';
        addTagBtn.textContent = 'Add Tag';
        addTagBtn.onclick = addTag;
    }
    window.deleteTag = (index) => { currentTags.splice(index, 1); renderTags(); alert('Tag deleted'); };
    window.editTag = (index) => {
        const tag = currentTags[index];
        document.getElementById('tagLabel').value = tag.label;
        document.getElementById('tagValue').value = tag.value;
        editingTagIndexInput.value = index;
        addTagBtn.textContent = 'Update Tag';
        addTagBtn.onclick = updateTag;
    };

    // =========================================================
    // INFLUX CRUD
    // =========================================================
    let editingInfluxIndex = -1;

    function resetInfluxForm() {
        influxUrls.value = '';
        influxToken.value = '';
        influxOrg.value = '';
        influxBucket.value = '';
        addInfluxBtn.textContent = 'Add InfluxDB';
        editingInfluxIndex = -1;
        addInfluxBtn.onclick = addInflux;
    }

    function renderInflux() {
        const influxTable = document.getElementById('influxTable');
        if (!influxTable) return;
        influxTable.innerHTML = '';
        currentInflux.forEach((db, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
            <td class="p-3">${db.url}</td>
            <td class="p-3">${db.token}</td>
            <td class="p-3">${db.org}</td>
            <td class="p-3">${db.bucket}</td>
            <td class="p-3 flex space-x-2">
                <button type="button" onclick="editInflux(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md hover:bg-yellow-600"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                <button type="button" onclick="deleteInflux(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md hover:bg-red-600"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
            </td>`;
            influxTable.appendChild(row);
        });
    }

    function addInflux() {
        const url = influxUrls.value.trim(), token = influxToken.value.trim(), org = influxOrg.value.trim(), bucket = influxBucket.value.trim();
        if (!url || !token || !org || !bucket) { alert('All fields are required'); return; }
        currentInflux.push({ url, token, org, bucket });
        renderInflux();
        resetInfluxForm();
    }

    function updateInflux() {
        const url = influxUrls.value.trim(), token = influxToken.value.trim(), org = influxOrg.value.trim(), bucket = influxBucket.value.trim();
        if (!url || !token || !org || !bucket) { alert('All fields are required'); return; }
        currentInflux[editingInfluxIndex] = { url, token, org, bucket };
        renderInflux();
        resetInfluxForm();
    }

    window.editInflux = (index) => {
        const db = currentInflux[index];
        influxUrls.value = db.url;
        influxToken.value = db.token;
        influxOrg.value = db.org;
        influxBucket.value = db.bucket;
        editingInfluxIndex = index;
        addInfluxBtn.textContent = 'Update InfluxDB';
        addInfluxBtn.onclick = updateInflux;
    };
    window.deleteInflux = (index) => { currentInflux.splice(index, 1); renderInflux(); };

    const addInfluxBtn = document.getElementById('addInfluxBtn');
    if (addInfluxBtn) addInfluxBtn.onclick = addInflux;

    // =========================================================
    // CANCEL EDIT
    // =========================================================
    window.cancelEdit = () => {
        configForm.reset();
        currentRegisters = []; currentFields = []; currentTags = []; currentInflux = [];
        renderRegisters(); renderFields(); renderTags(); renderInflux();
        editingConfigNameInput.value = '';
        cancelEditBtn.style.display = 'none';
        deviceNameInput.disabled = false;
        toggleProtocolFields(configForm.protocol.value);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // =========================================================
    // SAVE CONFIG
    // =========================================================
    document.getElementById('saveConfigBtn').addEventListener('click', () => {
        const errors = validateForm();
        if (errors.length > 0) { alert(`${errors.join('; ')}`); return; }
        const editingConfigName = editingConfigNameInput.value;
        const name = editingConfigName || configForm.name.value;
        if (!editingConfigName && existingConfigNames.includes(name)) { alert('Configuration name already exists'); return; }
        const data = {
            name, timeout: configForm.timeout.value, protocol: configForm.protocol.value,
            registers: currentRegisters, fields: currentFields, tags: currentTags,
            interval: configForm.interval.value,
            influxdb: currentInflux.map(db => ({ urls: [db.url], token: db.token, organization: db.org, bucket: db.bucket }))
        };
        if (data.protocol === 'tcp') {
            data.host = document.querySelector('#tcpFields input[name="host"]').value;
            data.port = parseInt(document.querySelector('#tcpFields input[name="port"]').value);
            data.slave_id = parseInt(configForm.slave_id.value);
        } else if (data.protocol === 'rtu') {
            data.controller = configForm.controller.value;
            data.baud_rate = parseInt(configForm.baud_rate.value);
            data.data_bits = parseInt(configForm.data_bits.value);
            data.parity = configForm.parity.value;
            data.stop_bits = parseInt(configForm.stop_bits.value);
            data.slave_id = parseInt(configForm.slave_id.value);
        } else if (data.protocol === 'snmp') {
            data.host = document.querySelector('#snmpFields input[name="host"]').value;
            data.port = parseInt(document.querySelector('#snmpFields input[name="port"]').value);
            data.version = parseInt(configForm.version.value);
            if (data.version === 3) {
                data.sec_name = configForm.sec_name.value;
                data.sec_level = configForm.sec_level.value;
                data.auth_protocol = configForm.auth_protocol.value;
                data.auth_password = configForm.auth_password.value;
                data.priv_protocol = configForm.priv_protocol.value;
                data.priv_password = configForm.priv_password.value;
            } else {
                data.community = configForm.community.value;
            }
        }
        axios.post(`/config/${name}`, data).then(res => {
            alert(`Configuration saved: ${res.data.message}`);
            renderConfigs();

//             const expose = confirm("Do you want to expose this configuration as Modbus?");
//             // In saveConfigBtn click, after alert('Configuration saved'):
// activeDevice = name;  // ← add this line
// // Also clear UI immediately:
// document.getElementById('live-voltage').textContent = '--';
// document.getElementById('live-current').textContent = '--';
// document.getElementById('live-pf').textContent = '--';
// document.getElementById('live-freq').textContent = '--';
//     if (expose) {
//         document.getElementById('modbusSection').style.display = 'block';
//         return;
//     }
activeDevice = name;
startLiveDataPolling();
// Clear live metrics
if (typeof renderLiveMetricsBody === 'function') renderLiveMetricsBody(null);

// Populate overview fields
document.getElementById('ov-protocol').textContent = data.protocol || '—';
document.getElementById('ov-host').textContent = data.host || '—';
document.getElementById('ov-port').textContent = data.port || '—';
document.getElementById('ov-slave').textContent = data.slave_id || '—';
document.getElementById('ov-timeout').textContent = data.timeout || '—';

document.getElementById('ov-registers').innerHTML = currentRegisters.map(r =>
    `<tr><td>${r.name}</td><td>${r.type}</td><td>${r.address}</td></tr>`
).join('');

document.getElementById('ov-tags').innerHTML = currentTags.map(t =>
    `<tr><td>${t.label||t}</td><td>${t.value||''}</td></tr>`
).join('');

document.getElementById('ov-integrations').innerHTML = currentInflux.map(db =>
    `<tr><td>${db.url}</td><td>${db.org}</td><td>${db.bucket}</td></tr>`
).join('');

// Switch to Overview tab
document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
document.querySelector('[data-tab="overview"]').classList.add('active');
document.getElementById('tab-overview').classList.add('active');

// Update header
document.getElementById('hdr-name').textContent = name;
document.getElementById('hdr-status').style.display = 'inline-block';
document.getElementById('hdr-info').textContent = 'Configuration saved';

// Show modbus prompt in overview
document.getElementById('modbusSection').style.display = 'block';

//             if (!editingConfigName) {
//                 configForm.reset();
//                 currentRegisters = []; currentFields = []; currentTags = [];
//                 renderRegisters(); renderFields(); renderTags();
//                 toggleProtocolFields(configForm.protocol.value);

//                 document.getElementById('ov-protocol').textContent = data.protocol || '—';
// document.getElementById('ov-host').textContent = data.host || '—';
// document.getElementById('ov-port').textContent = data.port || '—';
// document.getElementById('ov-slave').textContent = data.slave_id || '—';
// document.getElementById('ov-timeout').textContent = data.timeout || '—';
//             }
//             editingConfigNameInput.value = '';
//             cancelEditBtn.style.display = 'none';
//             deviceNameInput.disabled = false;
//         }).catch(err => { alert(`Error saving: ${err.response?.data?.error || err.message}`); });

        // Populate overview
document.getElementById('ov-protocol').textContent = data.protocol || '—';
document.getElementById('ov-host').textContent = data.host || '—';
document.getElementById('ov-port').textContent = data.port || '—';
document.getElementById('ov-slave').textContent = data.slave_id || '—';
document.getElementById('ov-timeout').textContent = data.timeout || '—';

document.getElementById('ov-registers').innerHTML = currentRegisters.map(r =>
    `<tr><td>${r.name}</td><td>${r.type}</td><td>${r.address}</td></tr>`
).join('');
document.getElementById('ov-tags').innerHTML = currentTags.map(t =>
    `<tr><td>${t.label || t}</td><td>${t.value || ''}</td></tr>`
).join('');
document.getElementById('ov-integrations').innerHTML = currentInflux.map(db =>
    `<tr><td>${db.url}</td><td>${db.org}</td><td>${db.bucket}</td></tr>`
).join('');

// Switch to Overview tab
document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
document.querySelector('[data-tab="overview"]').classList.add('active');
document.getElementById('tab-overview').classList.add('active');

// Update header
document.getElementById('hdr-name').textContent = name;
document.getElementById('hdr-status').style.display = 'inline-block';
document.getElementById('hdr-info').textContent = 'Configuration saved';

// Show modbus section (keep currentRegisters intact — don't clear yet)
document.getElementById('modbusSection').style.display = 'block';
document.getElementById('modbusStep2').style.display = 'none';

editingConfigNameInput.value = name;
cancelEditBtn.style.display = 'none';
deviceNameInput.disabled = false;

}).catch(err => {
    if (showConfigLimitPopup(err)) return;
    alert(`Error saving: ${err.response?.data?.error || err.message}`);
});
    });

    // =========================================================
    // PROTOCOL TOGGLE
    // =========================================================
    window.toggleProtocolFields = (protocol) => {
        const tcpFields = document.getElementById('tcpFields');
        const rtuFields = document.getElementById('rtuFields');
        const snmpFields = document.getElementById('snmpFields');
        const modbusRegistersSection = document.getElementById('modbusRegistersSection');
        const snmpFieldsSection = document.getElementById('snmpFieldsSection');
        const slaveIdField = document.getElementById('slave_id')?.parentElement;
	const uploadMibBtn = document.getElementById('uploadMibBtn');
        const browseMibsBtn = document.getElementById('browseMibsBtn');

	[tcpFields, rtuFields, snmpFields, modbusRegistersSection, snmpFieldsSection, uploadMibBtn, browseMibsBtn].forEach(el => {
            if (el) el.style.setProperty('display', 'none', 'important');
        });

        if (protocol === 'tcp') {
            if (tcpFields) tcpFields.style.setProperty('display', 'block', 'important');
            if (modbusRegistersSection) modbusRegistersSection.style.setProperty('display', 'block', 'important');
            if (slaveIdField) slaveIdField.style.setProperty('display', 'block', 'important');
        } else if (protocol === 'rtu') {
            if (rtuFields) rtuFields.style.setProperty('display', 'block', 'important');
            if (modbusRegistersSection) modbusRegistersSection.style.setProperty('display', 'block', 'important');
            if (slaveIdField) slaveIdField.style.setProperty('display', 'block', 'important');
        } else if (protocol === 'snmp') {
            if (snmpFields) snmpFields.style.setProperty('display', 'block', 'important');
            if (snmpFieldsSection) snmpFieldsSection.style.setProperty('display', 'block', 'important');
            if (slaveIdField) slaveIdField.style.setProperty('display', 'none', 'important');
            if (uploadMibBtn) uploadMibBtn.style.setProperty('display', 'inline-block', 'important');
            if (browseMibsBtn) browseMibsBtn.style.setProperty('display', 'inline-block', 'important');
        }
    };

    registerTypeSelect.addEventListener('change', toggleRegisterFields);
    document.getElementById('dataType').addEventListener('change', updateByteOrderWarning);
    document.getElementById('byteOrder').addEventListener('change', updateByteOrderWarning);
    toggleRegisterFields();
    toggleProtocolFields(document.getElementById('protocol').value);


    // mbMapping: { registerName: modbusAddress }
    let mbMapping = {};

    // Render the register pick table from currentRegisters
    // function renderMbRegisterPick() {
    //     const tbody = document.getElementById('mbRegisterPickBody');
    //     if (!tbody) return;
    //     tbody.innerHTML = '';

    //     if (currentRegisters.length === 0) {
    //         tbody.innerHTML = `<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;">No registers in form yet. Add registers first, then come back here.</td></tr>`;
    //         return;
    //     }

    //     currentRegisters.forEach((reg, idx) => {
    //         const isMapped = mbMapping[reg.name] !== undefined;
    //         const currentMbAddr = isMapped ? mbMapping[reg.name] : reg.address;
    //         const tr = document.createElement('tr');
    //         tr.style.borderBottom = '1px solid #e0e7ff';
    //         tr.innerHTML = `
    //             <td style="padding:8px;text-align:center;">
    //                 <input type="checkbox" class="mb-reg-check" data-index="${idx}" ${isMapped ? 'checked' : ''}>
    //             </td>
    //             <td style="padding:8px;font-weight:500;">${reg.name}</td>
    //             <td style="padding:8px;color:#64748b;font-family:monospace;">${reg.address}</td>
    //             <td style="padding:8px;">
    //                 <input type="number" class="mb-addr-final" data-name="${reg.name}" value="${currentMbAddr}"
    //                     min="0" max="65535"
    //                     style="border:1px solid #c7d2fe;border-radius:5px;padding:3px 8px;width:90px;font-size:13px;
    //                            ${isMapped ? '' : 'opacity:0.4;pointer-events:none;'}">
    //             </td>
    //         `;
    //         tbody.appendChild(tr);

    //         // Checkbox click → popup
    //         const checkbox = tr.querySelector('.mb-reg-check');
    //         const addrInput = tr.querySelector('.mb-addr-final');

    //         checkbox.addEventListener('change', () => {
    //             if (checkbox.checked) {
    //                 // Ask user if they want to change the address
    //                 const wantChange = confirm(
    //                     `Register: "${reg.name}"\nOriginal address: ${reg.address}\n\nDo you want to assign a different Modbus address for the third-party system?`
    //                 );
    //                 if (wantChange) {
    //                     const newAddr = prompt(`Enter new Modbus address for "${reg.name}" (0–65535):`, reg.address);
    //                     if (newAddr === null) {
    //                         // cancelled → uncheck
    //                         checkbox.checked = false;
    //                         return;
    //                     }
    //                     const parsed = parseInt(newAddr);
    //                     if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
    //                         alert('Invalid address. Must be 0–65535.');
    //                         checkbox.checked = false;
    //                         return;
    //                     }
    //                     addrInput.value = parsed;
    //                 }
    //                 // Enable the address input
    //                 addrInput.style.opacity = '1';
    //                 addrInput.style.pointerEvents = 'auto';
    //                 mbMapping[reg.name] = parseInt(addrInput.value);
    //             } else {
    //                 // Unchecked → remove from mapping, grey out input
    //                 delete mbMapping[reg.name];
    //                 addrInput.value = reg.address;
    //                 addrInput.style.opacity = '0.4';
    //                 addrInput.style.pointerEvents = 'none';
    //             }
    //         });
    //     });
    // }


    function renderMbRegisterPick() {
    const tbody = document.getElementById('mbRegisterPickBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // if (currentRegisters.length === 0) {
    //     tbody.innerHTML = `<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;">No registers in form yet. Add registers first, then come back here.</td></tr>`;
    //     return;
    // }


    const items = currentRegisters.length > 0 ? currentRegisters :
    currentFields.map(f => ({ name: f.name, type: 'holding_registers', address: f.oid }));

if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;">No fields found.</td></tr>`;
    return;
}

    const rangeMap = {
        "holding_registers": { min: 40001, max:  40100  },
        "input_registers":   { min: 30001, max:   30100 },
        "coils":             { min: 1,     max: 100  },
        "discrete_inputs":   { min: 10001, max: 10100}
    };

    // currentRegisters.forEach((reg, idx) => {
        items.forEach((reg, idx) => {
        const range = rangeMap[reg.type] || { min: 40001, max: 40100 };
        const isMapped = mbMapping[reg.name] !== undefined;
        const currentMbAddr = isMapped ? mbMapping[reg.name] : range.min;
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #e0e7ff';
        tr.innerHTML = `
            <td style="padding:8px;text-align:center;">
                <input type="checkbox" class="mb-reg-check" data-index="${idx}" ${isMapped ? 'checked' : ''}>
            </td>
            <td style="padding:8px;font-weight:500;">${reg.name}</td>
            <td style="padding:8px;color:#64748b;font-family:monospace;">${reg.address}</td>
            <td style="padding:8px;">
                <input type="number" class="mb-addr-final" data-name="${reg.name}" value="${currentMbAddr}"
                    min="${range.min}" max="${range.max}"
                    style="border:1px solid #c7d2fe;border-radius:5px;padding:3px 8px;width:90px;font-size:13px;
                           ${isMapped ? '' : 'opacity:0.4;pointer-events:none;'}">
                <span style="font-size:10px;color:#94a3b8;">${range.min}–${range.max}</span>
            </td>
        `;
        tbody.appendChild(tr);

        const checkbox = tr.querySelector('.mb-reg-check');
        const addrInput = tr.querySelector('.mb-addr-final');

        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                const wantChange = confirm(
                    `Register: "${reg.name}"\nAllowed range: ${range.min}–${range.max}\n\nDo you want to assign a different Modbus address?`
                );
                if (wantChange) {
                    const newAddr = prompt(`Enter address for "${reg.name}" (${range.min}–${range.max}):`, range.min);
                    if (newAddr === null) { checkbox.checked = false; return; }
                    const parsed = parseInt(newAddr);
                    if (isNaN(parsed) || parsed < range.min || parsed > range.max) {
                        alert(`Invalid. Must be ${range.min}–${range.max}`);
                        checkbox.checked = false;
                        return;
                    }
                    addrInput.value = parsed;
                }
                addrInput.style.opacity = '1';
                addrInput.style.pointerEvents = 'auto';
                mbMapping[reg.name] = parseInt(addrInput.value);
            } else {
                delete mbMapping[reg.name];
                addrInput.value = range.min;
                addrInput.style.opacity = '0.4';
                addrInput.style.pointerEvents = 'none';
            }
        });
    });
}


    function refreshModbusStatus() {
        axios.get('/modbus/status').then(res => {
            const badge = document.getElementById('modbusStatusBadge');
            if (res.data.running) {
                badge.style.background = '#dcfce7';
                badge.style.color = '#166534';
                badge.textContent = 'Running (port 502)';
            } else {
                badge.style.background = '#e2e8f0';
                badge.style.color = '#475569';
                badge.textContent = 'Stopped';
            }
            mbMapping = res.data.mapping || {};
        }).catch(() => {});
    }

  

    // =========================================================
    // ORIGINAL EXPORT BUTTON
    // =========================================================
    


    // Live Data Panel
//     function startLiveDataPolling() {
//     setInterval(() => {
//         // We use live_all to see exactly what the backend is sending
//         fetch('/api/live_all')
//             .then(r => r.json())
//             .then(allData => {
//                 // LOG THIS: Open your browser console (F12) and click the arrow 
//                 // to see the EXACT names of the keys.
//                 console.log("Current Data Keys:", allData);

//                 // Based on your logs, the device key is 'pro3em_energy'
//                 const data = Object.values(allData)[0]?.fields;

//                 if (data) {
//                     // We must match your Telegraf names EXACTLY
//                     // Using Optional Chaining (?.) to prevent crashes if a key is missing
//                     const v = data["Phase C Voltage"];
//                     const c = data["Phase C Current"];
//                     const pf = data["Phase C Power Factor"];
//                     const f = data["Phase C Frequency"];

//                     if (v !== undefined) document.getElementById('live-voltage').textContent = v.toFixed(2);
//                     if (c !== undefined) document.getElementById('live-current').textContent = c.toFixed(3);
//                     if (pf !== undefined) document.getElementById('live-pf').textContent = pf.toFixed(2);
//                     if (f !== undefined) document.getElementById('live-freq').textContent = f.toFixed(2);
//                 }
//             })
//             .catch(err => console.error("Polling fetch failed:", err));
//     }, 2000);
// }


// function startLiveDataPolling() {
//     setInterval(() => {
//         if (!activeDevice) return;  // ← don't poll if nothing saved yet

//         fetch(`/api/live/${activeDevice}`)
//             .then(r => r.json())
//             .then(data => {
//                 if (data.error) {
//                     // device offline or not found → clear UI
//                     document.getElementById('live-voltage').textContent = '--';
//                     document.getElementById('live-current').textContent = '--';
//                     document.getElementById('live-pf').textContent = '--';
//                     document.getElementById('live-freq').textContent = '--';
//                     return;
//                 }
//                 const fields = data.fields || data;
//                 const v  = fields["Phase C Voltage"];
//                 const c  = fields["Phase C Current"];
//                 const pf = fields["Phase C Power Factor"];
//                 const f  = fields["Phase C Frequency"];

//                 if (v  !== undefined) document.getElementById('live-voltage').textContent = v.toFixed(2);
//                 if (c  !== undefined) document.getElementById('live-current').textContent = c.toFixed(3);
//                 if (pf !== undefined) document.getElementById('live-pf').textContent = pf.toFixed(2);
//                 if (f  !== undefined) document.getElementById('live-freq').textContent = f.toFixed(2);
//             })
//             .catch(err => console.error("Polling failed:", err));
//     }, 2000);
// }




// ── LIVE METRICS TABLE: one row per configured field/register on whichever
// device is currently open (activeDevice) — handles any number of fields ───
let pollTimer = null;

function getActiveFieldList() {
    // Modbus devices are described by currentRegisters, SNMP devices by
    // currentFields — whichever is populated is the one this device uses.
    if (currentRegisters.length > 0) {
        return currentRegisters.map(r => ({ name: r.name, address: r.address }));
    }
    return currentFields.map(f => ({ name: f.name, address: f.oid }));
}

function fmtLiveValue(val) {
    if (val === undefined || val === null) return '--';
    return (typeof val === 'number') ? val.toFixed(2) : String(val);
}

function renderLiveMetricsBody(liveFields) {
    const tbody = document.getElementById('liveMetricsBody');
    if (!tbody) return;
    const items = getActiveFieldList();
    if (!activeDevice || items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text2);">No fields configured</td></tr>';
        return;
    }
    tbody.innerHTML = items.map(item => {
        const val = liveFields ? liveFields[item.name] : undefined;
        return `<tr><td>${item.name}</td><td>${item.address ?? '—'}</td><td>${fmtLiveValue(val)}</td></tr>`;
    }).join('');
}

function fetchLiveActiveDevice() {
    if (!activeDevice) { renderLiveMetricsBody(null); return; }
    fetch(`/api/live/${activeDevice}`)
        .then(r => r.json())
        .then(data => renderLiveMetricsBody(data.error ? null : (data.fields || data)))
        .catch(err => console.error('Live metrics polling failed:', err));
}

function startLiveDataPolling() {
    if (pollTimer) clearInterval(pollTimer);
    fetchLiveActiveDevice();
    pollTimer = setInterval(fetchLiveActiveDevice, 8000);
}

document.getElementById('refreshBtn')?.addEventListener('click', function() {
    this.textContent = '⟳ ...';
    const me = this;
    fetchLiveActiveDevice();
    setTimeout(() => { me.textContent = '⟳ Refresh'; }, 400);
});




document.getElementById('modbusYesBtn').addEventListener('click', () => {
    document.getElementById('modbusStep2').style.display = 'block';
    renderMbRegisterPick();
});

document.getElementById('modbusNoBtn').addEventListener('click', () => {
    document.getElementById('modbusStep2').style.display = 'none';
    mbMapping = {};
});

document.getElementById('saveMbMappingBtn').addEventListener('click', () => {
    const finalMapping = {};
    const typeMap = { "holding_registers": "hr", "input_registers": "ir", "coils": "co", "discrete_inputs": "di" };
    const rangeMap = { "holding_registers": { min: 40001, max: 49999 }, "input_registers": { min: 30001, max: 39999 }, "coils": { min: 1, max: 9999 }, "discrete_inputs": { min: 10001, max: 19999 } };

    let hasError = false;  // ← flag

    document.querySelectorAll('.mb-reg-check:checked').forEach(cb => {
        if (hasError) return;
        const idx = parseInt(cb.dataset.index);
        // const reg = currentRegisters[idx];

        const items = currentRegisters.length > 0 ? currentRegisters :
    currentFields.map(f => ({ name: f.name, type: 'holding_registers', address: f.oid }));
const reg = items[idx];
        const addrInput = document.querySelector(`.mb-addr-final[data-name="${reg.name}"]`);
        const addr = parseInt(addrInput.value);
        const range = rangeMap[reg.type] || { min: 40001, max: 49999 };

        if (addr < range.min || addr > range.max) {
            alert(`"${reg.name}" must be ${range.min}–${range.max}`);
            hasError = true;  // ← set flag
            return;
        }
        finalMapping[reg.name] = { register: addr, length: 1, type: typeMap[reg.type] || "hr" };
    });

    if (hasError) return;  // ← stop here
    if (Object.keys(finalMapping).length === 0) { alert('Select at least one field'); return; }
    axios.post('/api/modbus_config', { mapping: finalMapping })
        .then(() => alert(`${Object.keys(finalMapping).length} field(s) exposed via Modbus!`))
        .catch(err => alert(`${err.response?.data?.error || err.message}`));
});

document.getElementById('readMbRegistersBtn').addEventListener('click', () => {
    const output = document.getElementById('mbRegisterOutput');
    output.style.display = 'block';
    output.textContent = 'Fetching…';
    axios.get('/api/modbus_config').then(res => {
        output.textContent = JSON.stringify(res.data, null, 2);
    }).catch(err => { output.textContent = `${err.message}`; });

});

refreshModbusStatus();
startLiveDataPolling();

// ── MIB UPLOAD, BROWSING, CACHING & LIVE WALK ──────────────────────────────
let mibWalkEntries = [];
let mibWalkCurrentFilename = '';
let mibWalkSelected = new Set();
let mibWalkRenames = new Map();
let mibWalkLiveFields = {};
let mibWalkLiveTimer = null;

// Client-side cache for parsed MIB OID entries: filename -> entries array
const mibCache = {};

// Helper: format bytes into KB/MB
function fmtBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Helper: format epoch timestamp
function fmtDate(epoch) {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    return d.toLocaleString();
}

// ── 1. UPLOAD MIB FILE ──────────────────────────────────────────────────────
document.getElementById('uploadMibBtn')?.addEventListener('click', () => {
    document.getElementById('mibFileInput').click();
});

document.getElementById('mibFileInput')?.addEventListener('change', function () {
    const file = this.files[0];
    this.value = '';
    if (!file) return;
    const formData = new FormData();
    formData.append('mib_file', file);
    showLoading('Uploading MIB file...');
    axios.post('/upload_mib', formData)
        .then(res => {
            const filename = res.data.filename;
            showLoading('Parsing OIDs from MIB...');
            return axios.get(`/walk_mib/${filename}`).then(walkRes => {
                const entries = walkRes.data.entries || [];
                mibCache[filename] = entries;
                openMibWalkModal(filename, entries);
            });
        })
        .catch(err => alert(`MIB upload/walk failed: ${err.response?.data?.error || err.message}`))
        .finally(() => hideLoading());
});

// ── 2. BROWSE PREVIOUSLY UPLOADED MIBS ───────────────────────────────────────
document.getElementById('browseMibsBtn')?.addEventListener('click', () => {
    document.getElementById('browseMibsOverlay').style.display = 'flex';
    fetchUploadedMibs();
});

document.getElementById('browseMibsRefreshBtn')?.addEventListener('click', () => {
    fetchUploadedMibs();
});

document.getElementById('browseMibsSearch')?.addEventListener('input', function () {
    filterBrowseMibsList(this.value);
});

let uploadedMibsList = [];

function fetchUploadedMibs() {
    const listEl = document.getElementById('browseMibsList');
    if (!listEl) return;
    listEl.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text2);">Loading MIB files...</td></tr>';
    
    axios.get('/api/mibs')
        .then(res => {
            uploadedMibsList = res.data || [];
            const countEl = document.getElementById('browseMibsCount');
            if (countEl) countEl.textContent = `${uploadedMibsList.length} files`;
            renderBrowseMibsList(uploadedMibsList);
        })
        .catch(err => {
            listEl.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;">Failed to load MIBs: ${err.message}</td></tr>`;
        });
}


// ── LOADING OVERLAY (works without any HTML changes) ───────────────────────
function showLoading(message) {
    let el = document.getElementById('globalLoadingOverlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'globalLoadingOverlay';
        el.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        el.innerHTML = `
            <div style="background:var(--surface,#fff);border-radius:10px;padding:24px 32px;display:flex;align-items:center;gap:14px;box-shadow:0 8px 30px rgba(0,0,0,0.3);">
                <div style="width:22px;height:22px;border:3px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:globalSpin 0.7s linear infinite;"></div>
                <span id="globalLoadingText" style="font-size:13px;font-weight:600;color:var(--text,#0f172a);"></span>
            </div>`;
        document.body.appendChild(el);
        const style = document.createElement('style');
        style.textContent = '@keyframes globalSpin { to { transform: rotate(360deg); } }';
        document.head.appendChild(style);
    }
    document.getElementById('globalLoadingText').textContent = message || 'Loading...';
    el.style.display = 'flex';
}
function hideLoading() {
    const el = document.getElementById('globalLoadingOverlay');
    if (el) el.style.display = 'none';
}

function renderBrowseMibsList(mibs) {
    const listEl = document.getElementById('browseMibsList');
    if (!listEl) return;
    if (!mibs || mibs.length === 0) {
        listEl.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:20px;">No uploaded MIB files found</td></tr>';
        return;
    }

    listEl.innerHTML = mibs.map(m => {
        const isCached = !!mibCache[m.filename];
        const statusBadge = isCached
            ? '<span class="status-badge" style="background:#dcfce7;color:#166534;font-size:10px;">Cached</span>'
            : '<span class="status-badge" style="background:#f1f5f9;color:#64748b;font-size:10px;">Server</span>';
        
        return `
        <tr>
            <td style="font-weight:600;word-break:break-all;">${m.filename}</td>
            <td style="color:var(--text2);font-size:11px;">${fmtBytes(m.size)}</td>
            <td style="color:var(--text2);font-size:11px;">${fmtDate(m.modified)}</td>
            <td>${statusBadge}</td>
            <td style="text-align:right;white-space:nowrap;">
                <button type="button" class="btn-action primary" onclick="openMibFromBrowse('${m.filename}')" style="height:24px;line-height:22px;padding:0 8px;font-size:11px;">Walk / Open</button>
                <button type="button" class="btn-action danger" onclick="deleteMibFile('${m.filename}')" style="height:24px;line-height:22px;padding:0 8px;font-size:11px;margin-left:4px;">Delete</button>
            </td>
        </tr>`;
    }).join('');
}

function filterBrowseMibsList(q) {
    const searchStr = (q || '').toLowerCase();
    const filtered = uploadedMibsList.filter(m => m.filename.toLowerCase().includes(searchStr));
    renderBrowseMibsList(filtered);
}

function openMibFromBrowse(filename) {
    document.getElementById('browseMibsOverlay').style.display = 'none';
    
    // If already in client cache, open immediately without fetching!
    if (mibCache[filename]) {
        openMibWalkModal(filename, mibCache[filename]);
        return;
    }
    
    // Otherwise fetch once and store in cache
    showLoading('Parsing OIDs from MIB...');
    axios.get(`/walk_mib/${filename}`)
        .then(res => {
            const entries = res.data.entries || [];
            mibCache[filename] = entries;
            openMibWalkModal(filename, entries);
        })
        .catch(err => alert(`Failed to load MIB file ${filename}: ${err.response?.data?.error || err.message}`))
        .finally(() => hideLoading());
}

function deleteMibFile(filename) {
    if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;
    axios.delete(`/api/mibs/${filename}`)
        .then(() => {
            delete mibCache[filename];
            fetchUploadedMibs();
        })
        .catch(err => alert(`Failed to delete MIB file: ${err.response?.data?.error || err.message}`));
}

// ── 3. MIB WALK MODAL ───────────────────────────────────────────────────────
function openMibWalkModal(filename, entries) {
    mibWalkCurrentFilename = filename;
    mibWalkEntries = entries;
    mibWalkSelected.clear();
    mibWalkRenames.clear();
    
    document.getElementById('mibWalkFilename').textContent = filename;
    document.getElementById('mibWalkSearch').value = '';
    document.getElementById('mibWalkSelectAll').checked = false;
    document.getElementById('mibWalkOverlay').style.display = 'flex';
    updateMibQueryBadge();

    // Fetch live fields and render
    fetchMibWalkLiveFields(() => fetchDirectMibValues(() => renderMibWalkResults(entries)));
    renderMibWalkResults(entries);
    
    // Start live auto-refresh interval if checked
    startMibWalkLiveTimer();
}

function closeMibWalkModal() {
    document.getElementById('mibWalkOverlay').style.display = 'none';
    stopMibWalkLiveTimer();
    // Query (if any) keeps running in the background — update the badge
    // so there's a visible sign of it even with the modal closed.
    updateMibQueryBadge();
}

// ── BACKGROUND QUERY STATE ───────────────────────────────────────────────
// Only one direct-SNMP query chain may run at a time, regardless of how
// many times the modal is opened/closed/refreshed — this is what stops
// overlapping chains from piling load onto the device (the exact cause
// of the earlier timeout/overload issues).
let mibQueryActive = false;
let mibQueryCancelled = false;
let mibQueryProgress = { done: 0, total: 0 };
let mibQueryDoneCallbacks = [];

function updateMibQueryBadge() {
    let badge = document.getElementById('mibQueryBadge');
    const overlayOpen = document.getElementById('mibWalkOverlay')?.style.display === 'flex';
    if (!mibQueryActive || overlayOpen) {
        if (badge) badge.style.display = 'none';
        return;
    }
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'mibQueryBadge';
        badge.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:10001;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:8px 14px;font-size:11px;font-weight:600;color:var(--text,#0f172a);box-shadow:0 4px 16px rgba(0,0,0,0.15);cursor:pointer;display:flex;align-items:center;gap:8px;';
        badge.onclick = () => {
            if (mibWalkCurrentFilename) openMibFromBrowse(mibWalkCurrentFilename);
        };
        document.body.appendChild(badge);
    }
    badge.textContent = `Querying ${mibWalkCurrentFilename} — ${mibQueryProgress.done}/${mibQueryProgress.total}`;
    badge.style.display = 'flex';
}

// ── PROGRESS BAR + STOP BUTTON (in the modal header row) ────────────────────
function showMibWalkProgress(done, total) {
    let container = document.getElementById('mibWalkProgressContainer');
    if (!container) {
        const headerRow = document.getElementById('mibWalkHeaderSubrow');
        if (!headerRow) return;

        container = document.createElement('div');
        container.id = 'mibWalkProgressContainer';
        container.style.cssText = 'flex:1;display:flex;align-items:center;gap:10px;margin:0 16px;';

        const track = document.createElement('div');
        track.style.cssText = 'flex:1;height:4px;background:var(--surface2,#f1f5f9);border-radius:2px;overflow:hidden;';
        const bar = document.createElement('div');
        bar.id = 'mibWalkProgressBar';
        bar.style.cssText = 'height:100%;width:0%;background:#6366f1;transition:width 0.15s ease;';
        track.appendChild(bar);

        const stopBtn = document.createElement('button');
        stopBtn.id = 'mibWalkStopBtn';
        stopBtn.type = 'button';
        stopBtn.textContent = 'Stop';
        stopBtn.style.cssText = 'height:22px;line-height:20px;padding:0 8px;font-size:10px;font-weight:600;border:1px solid var(--border,#e2e8f0);border-radius:5px;background:var(--surface2,#f1f5f9);color:var(--text2,#64748b);cursor:pointer;white-space:nowrap;';
        stopBtn.onclick = cancelMibQuery;

        container.appendChild(track);
        container.appendChild(stopBtn);
        headerRow.appendChild(container);
    }
    container.style.display = 'flex';
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('mibWalkProgressBar').style.width = pct + '%';
}

function hideMibWalkProgress() {
    const container = document.getElementById('mibWalkProgressContainer');
    if (container) container.style.display = 'none';
}

function fetchDirectMibValues(done) {
    // A query is already running — don't start a second one. Just render
    // whatever values have arrived so far, and queue this caller to be
    // notified when the in-flight query actually finishes.
    if (mibQueryActive) {
        if (done) { done(); mibQueryDoneCallbacks.push(done); }
        return;
    }

    const protocol = configForm.protocol.value;
    if (protocol !== 'snmp' || !mibWalkEntries.length) { if (done) done(); return; }
    const host = document.querySelector('#snmpFields input[name="host"]')?.value;
    const port = parseInt(document.querySelector('#snmpFields input[name="port"]')?.value) || 161;
    const community = configForm.community.value || 'public';
    if (!host) { if (done) done(); return; }

    const allOids = mibWalkEntries.map(e => e.oid);
    const chunkSize = 10;
    const chunks = [];
    for (let i = 0; i < allOids.length; i += chunkSize) chunks.push(allOids.slice(i, i + chunkSize));

    mibQueryActive = true;
    mibQueryCancelled = false;
    mibQueryDoneCallbacks = done ? [done] : [];

    let i = 0;
    showMibWalkProgress(0, chunks.length);
    function finish() {
        mibQueryActive = false;
        hideMibWalkProgress();
        updateMibQueryBadge();
        const callbacks = mibQueryDoneCallbacks;
        mibQueryDoneCallbacks = [];
        callbacks.forEach(cb => cb());
    }
    function next() {
        if (mibQueryCancelled || i >= chunks.length) { finish(); return; }
        const chunk = chunks[i++];
        axios.post('/api/snmp_live_query', { host, port, community, oids: chunk })
            .then(res => { Object.assign(mibWalkLiveFields, res.data.values || {}); })
            .catch(() => {})
            .finally(() => {
                mibQueryProgress = { done: i, total: chunks.length };
                showMibWalkProgress(i, chunks.length);
                updateMibQueryBadge();
                setTimeout(next, 150);
            });
    }
    next();
}

function cancelMibQuery() {
    mibQueryCancelled = true;
}


function fetchMibWalkLiveFields(done) {
    const sourceEl = document.getElementById('mibWalkLiveSource');
    if (!activeDevice) {
        if (sourceEl) sourceEl.textContent = '(save device config to see live values)';
        if (done) done();
        return;
    }
    fetch(`/api/live/${activeDevice}`)
        .then(r => r.json())
        .then(data => {
            if (data && !data.error) {
                const liveObj = data.fields || data;
                // Merge MQTT live fields into mibWalkLiveFields
                Object.assign(mibWalkLiveFields, liveObj);
            }
            if (sourceEl) sourceEl.textContent = `live values from "${activeDevice}" LOADING `;
        })
        .catch(() => {})
        .finally(() => { if (done) done(); });
}

function updateMibWalkSelectedCount() {
    const el = document.getElementById('mibWalkSelectedCount');
    if (el) el.textContent = `${mibWalkSelected.size} selected`;
}

function renderMibWalkResults(entries) {
    const tbody = document.getElementById('mibWalkResults');
    if (!tbody) return;
    if (!entries || !entries.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:20px;">No resolvable OIDs found in this MIB</td></tr>';
        updateMibWalkSelectedCount();
        return;
    }
    tbody.innerHTML = entries.map(e => {
        const checked = mibWalkSelected.has(e.oid) ? 'checked' : '';
        const renameVal = mibWalkRenames.get(e.oid) ?? e.name;
        
        // Match live values by OID, OID.0, field name, or renamed field name
        const liveVal = mibWalkLiveFields[e.oid] ??
                        mibWalkLiveFields[e.oid + '.0'] ??
                        mibWalkLiveFields[e.name] ??
                        mibWalkLiveFields[renameVal];
        
        const hasVal = liveVal !== undefined && liveVal !== null;
        const valDisplay = hasVal ? fmtLiveValue(liveVal) : '—';
        const valStyle = hasVal ? 'color:#15803d;font-weight:600;' : 'color:var(--text2);';
        
        return `
        <tr>
            <td><input type="checkbox" class="mib-row-check" data-oid="${e.oid}" ${checked}></td>
            <td style="font-weight:500;">${e.name}</td>
            <td style="word-break:break-all;font-family:monospace;font-size:11px;">${e.oid}</td>
            <td style="color:var(--text2);font-size:11px;">${e.syntax || '—'}</td>
            <td style="color:var(--text2);font-size:11px;">${e.type || 'OBJECT-TYPE'}</td>
            <td style="${valStyle}">${valDisplay}</td>
            <td><input type="text" class="mib-row-rename" data-oid="${e.oid}" value="${renameVal}"
                    style="width:100%;height:26px;padding:0 6px;border:1px solid var(--border);border-radius:5px;font-size:11px;"></td>
        </tr>`;
    }).join('');
    updateMibWalkSelectedCount();
}

document.getElementById('mibWalkSearch')?.addEventListener('input', function () {
    const q = this.value.toLowerCase();
    renderMibWalkResults(mibWalkEntries.filter(e => e.name.toLowerCase().includes(q) || e.oid.includes(q)));
});

// Track checkbox selections
document.getElementById('mibWalkResults')?.addEventListener('change', function (evt) {
    const checkbox = evt.target.closest('.mib-row-check');
    if (!checkbox) return;
    if (checkbox.checked) mibWalkSelected.add(checkbox.dataset.oid);
    else mibWalkSelected.delete(checkbox.dataset.oid);
    updateMibWalkSelectedCount();
});

// Track rename edits
document.getElementById('mibWalkResults')?.addEventListener('input', function (evt) {
    const renameInput = evt.target.closest('.mib-row-rename');
    if (renameInput) mibWalkRenames.set(renameInput.dataset.oid, renameInput.value);
});

document.getElementById('mibWalkSelectAll')?.addEventListener('change', function () {
    const checked = this.checked;
    document.querySelectorAll('#mibWalkResults .mib-row-check').forEach(cb => {
        cb.checked = checked;
        if (checked) mibWalkSelected.add(cb.dataset.oid);
        else mibWalkSelected.delete(cb.dataset.oid);
    });
    updateMibWalkSelectedCount();
});

document.getElementById('mibWalkAddSelectedBtn')?.addEventListener('click', () => {
    if (mibWalkSelected.size === 0) { alert('No fields selected'); return; }
    let added = 0;
    const skipped = [];
    mibWalkSelected.forEach(oid => {
        const entry = mibWalkEntries.find(e => e.oid === oid);
        if (!entry) return;
        const name = (mibWalkRenames.get(oid) || '').trim() || entry.name;
	const oidToUse = oid.endsWith('.0') ? oid : oid + '.0';
        const field = { name,oid: oidToUse , is_tag: false };
        const errors = validateField(field, -1);
        if (errors.length > 0) { skipped.push(`${name}: ${errors.join('; ')}`); return; }
        currentFields.push(field);
        added++;
    });
    renderFields();
    mibWalkSelected.clear();
    mibWalkRenames.clear();
    closeMibWalkModal();

    // Jump to the Fields tab so the user can see what was added
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="registers"]').classList.add('active');
    document.getElementById('tab-registers').classList.add('active');
    let msg = `${added} field(s) added`;
    if (skipped.length) msg += `\n\nSkipped:\n${skipped.join('\n')}`;
    alert(msg);
});

/* ── 4. DIRECT SNMP LIVE QUERY HANDLER (Commented out for future use) ──
document.getElementById('snmpDirectQueryBtn')?.addEventListener('click', () => {
    fetchDirectSnmpValues();
});

function fetchDirectSnmpValues() {
    const host = (document.getElementById('snmpDirectHost')?.value || '').trim();
    const port = parseInt(document.getElementById('snmpDirectPort')?.value || '161');
    const community = (document.getElementById('snmpDirectCommunity')?.value || 'public').trim();
    const statusEl = document.getElementById('snmpQueryStatus');

    if (!host) {
        alert('Please enter a target Host IP address for SNMP query');
        return;
    }
    if (!mibWalkEntries || mibWalkEntries.length === 0) {
        alert('No OIDs to query in current MIB');
        return;
    }

    if (statusEl) statusEl.textContent = 'Fetching SNMP values...';
    
    // Extract OIDs from current MIB entries
    const oids = mibWalkEntries.map(e => e.oid);

    axios.post('/api/snmp_live_query', { host, port, community, oids })
        .then(res => {
            const values = res.data.values || {};
            const count = Object.keys(values).length;
            // Merge returned live values
            Object.assign(mibWalkLiveFields, values);
            if (statusEl) statusEl.textContent = `Received ${count} live values from ${host}:${port}`;
            
            // Re-render MIB Walk table with new values
            const q = document.getElementById('mibWalkSearch')?.value.toLowerCase() || '';
            const entries = q ? mibWalkEntries.filter(e => e.name.toLowerCase().includes(q) || e.oid.includes(q)) : mibWalkEntries;
            renderMibWalkResults(entries);
        })
        .catch(err => {
            if (statusEl) statusEl.textContent = `SNMP Query failed: ${err.message}`;
        });
}
*/

// ── 5. LIVE REFRESH POLLING TIMER FOR MIB WALK ──────────────────────────────
function startMibWalkLiveTimer() {
    stopMibWalkLiveTimer();
    const liveToggle = document.getElementById('mibWalkLiveToggle');
    if (liveToggle && liveToggle.checked) {
        mibWalkLiveTimer = setInterval(() => {
            fetchMibWalkLiveFields(() => fetchDirectMibValues(() =>  {
                const q = document.getElementById('mibWalkSearch')?.value.toLowerCase() || '';
                const entries = q ? mibWalkEntries.filter(e => e.name.toLowerCase().includes(q) || e.oid.includes(q)) : mibWalkEntries;
                renderMibWalkResults(entries);
            }));
        }, 8000);
    }
}

function stopMibWalkLiveTimer() {
    if (mibWalkLiveTimer) {
        clearInterval(mibWalkLiveTimer);
        mibWalkLiveTimer = null;
    }
}

document.getElementById('mibWalkLiveToggle')?.addEventListener('change', function () {
    if (this.checked) {
        startMibWalkLiveTimer();
    } else {
        stopMibWalkLiveTimer();
    }
});

document.getElementById('mibWalkRefreshBtn')?.addEventListener('click', function () {
    this.textContent = '⟳ ...';
    const btn = this;
    fetchDirectMibValues(() => {
        const q = document.getElementById('mibWalkSearch')?.value.toLowerCase() || '';
        const entries = q ? mibWalkEntries.filter(e => e.name.toLowerCase().includes(q) || e.oid.includes(q)) : mibWalkEntries;
        renderMibWalkResults(entries);
        setTimeout(() => { btn.textContent = '⟳ Refresh'; }, 300);
    });
});

// Expose modal control functions globally on window object for HTML onclick handlers
window.openMibWalkModal = openMibWalkModal;
window.closeMibWalkModal = closeMibWalkModal;
window.openMibFromBrowse = openMibFromBrowse;
window.deleteMibFile = deleteMibFile;
window.fetchUploadedMibs = fetchUploadedMibs;

});
