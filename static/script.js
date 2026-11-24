document.addEventListener('DOMContentLoaded', () => {
    const configForm = document.getElementById('configForm');
    const configList = document.getElementById('configList');
    const registersTable = document.getElementById('registersTable');
    const fieldsTable = document.getElementById('fieldsTable');
    const tagsTable = document.getElementById('tagsTable');
    const testOutput = document.getElementById('testOutput');
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
    

const influxTable = document.getElementById('influxTable');
const addInfluxBtn = document.querySelector('button[onclick="addInfluxDB()"]');

    if (!configForm || !configList || !registersTable || !fieldsTable || !tagsTable || !testOutput || !byteOrderLabel || !byteOrderWarning || !regAddress || !editingConfigNameInput || !deviceNameInput || !addRegisterBtn || !addFieldBtn || !cancelEditBtn || !editingRegisterIndexInput || !editingFieldIndexInput || !registerTypeSelect || !byteOrderGroup || !dataTypeGroup || !scaleGroup || !addTagBtn || !editingTagIndexInput || !influxUrls || !influxToken || !influxOrg || !influxBucket || !modbusRegistersSection || !snmpFieldsSection) {
        console.error('Required DOM elements are missing');
        if (testOutput) testOutput.textContent = 'Error: Required DOM elements are missing';
        return;
    }

    let currentRegisters = [];
    let currentFields = [];
    let currentTags = [];
    let existingConfigNames = [];
    let currentInfluxDBs = [];
let editingInfluxIndex = -1;
    let lastKnownStatuses = {};
    

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
        if (!dataTypeSelect || !byteOrderSelect) {
            testOutput.textContent = 'Error: Data Type or Byte Order dropdown not found';
            return;
        }

        const dataType = dataTypeSelect.value;
        const byteOrder = byteOrderSelect.value;
        const recommendedOptions = {
            'BIT': ['AB', 'BA'],
            'INT8L': ['AB', 'BA'], 'INT8H': ['AB', 'BA'], 'UINT8L': ['AB', 'BA'], 'UINT8H': ['AB', 'BA'],
            'INT16': ['AB', 'BA'], 'UINT16': ['AB', 'BA'], 'FIXED': ['AB', 'BA'], 'UFIXED': ['AB', 'BA'],
            'FLOAT16-IEEE': ['AB', 'BA'],
            'INT32': ['ABCD', 'DCBA', 'BADC', 'CDAB'],
            'UINT32': ['ABCD', 'DCBA', 'BADC', 'CDAB'],
            'FLOAT32-IEEE': ['ABCD', 'DCBA', 'BADC', 'CDAB'],
            'INT64': ['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'],
            'UINT64': ['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'],
            'FLOAT64-IEEE': ['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'],
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

    function validateRegister(reg) {
        const errors = [];
        if (!reg.name) errors.push('Register name is required');
        const addresses = reg.address.split(',').map(a => a.trim());
        const registerType = reg.type;
        try {
            addresses.forEach(a => {
                if (isNaN(a) || parseInt(a) < 0) throw new Error('Invalid address');
            });
            const addressCounts = {
                'discrete_inputs': 1,
                'coils': 1,
                'BIT': 1, 'INT8L': 1, 'INT8H': 1, 'UINT8L': 1, 'UINT8H': 1,
                'INT16': 1, 'UINT16': 1, 'FIXED': 1, 'UFIXED': 1, 'FLOAT16-IEEE': 1,
                'INT32': 2, 'UINT32': 2, 'FLOAT32-IEEE': 2,
                'INT64': 4, 'UINT64': 4, 'FLOAT64-IEEE': 4,
                'STRING': addresses.length >= 1
            };
            if (['discrete_inputs', 'coils'].includes(registerType)) {
                if (addresses.length !== 1) {
                    errors.push('Discrete Inputs and Coils require exactly 1 address');
                }
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
        const duplicateIndex = currentFields.findIndex((f, i) => f.name === field.name && i !== index);
        if (duplicateIndex !== -1) errors.push('Field name must be unique');
        return errors;
    }

    function validateTag(tag, index) {
        const errors = [];
        if (!tag.label) errors.push('Tag label is required');
        if (!tag.value) errors.push('Tag value is required');
        const duplicateIndex = currentTags.findIndex((t, i) => t.label === tag.label && i !== index);
        if (duplicateIndex !== -1) errors.push('Tag label must be unique');
        return errors;
    }

    // Render the InfluxDB table
function renderInfluxDBs() {
    influxTable.innerHTML = '';
    currentInfluxDBs.forEach((db, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="p-3 truncate max-w-xs">${db.urls}</td>
            <td class="p-3">${db.organization}</td>
            <td class="p-3">${db.bucket}</td>
            <td class="p-3 flex space-x-2">
                <button type="button" onclick="editInfluxDB(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                <button type="button" onclick="deleteInfluxDB(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
            </td>
        `;
        influxTable.appendChild(row);
    });
}

// Add or Update Entry
window.addInfluxDB = () => {
    const urls = document.getElementById('influxUrls').value.trim();
    const token = document.getElementById('influxToken').value.trim();
    const organization = document.getElementById('influxOrg').value.trim();
    const bucket = document.getElementById('influxBucket').value.trim();

    if (!urls || !token || !organization || !bucket) {
        alert("Please fill all InfluxDB fields");
        return;
    }

    const entry = { urls, token, organization, bucket };

    if (editingInfluxIndex > -1) {
        currentInfluxDBs[editingInfluxIndex] = entry;
        editingInfluxIndex = -1;
        addInfluxBtn.textContent = 'Add InfluxDB';
    } else {
        currentInfluxDBs.push(entry);
    }

    // Clear inputs
    document.getElementById('influxUrls').value = '';
    document.getElementById('influxToken').value = '';
    document.getElementById('influxOrg').value = '';
    document.getElementById('influxBucket').value = '';
    
    renderInfluxDBs();
};

// Edit Existing Entry
window.editInfluxDB = (index) => {
    const db = currentInfluxDBs[index];
    document.getElementById('influxUrls').value = db.urls;
    document.getElementById('influxToken').value = db.token;
    document.getElementById('influxOrg').value = db.organization;
    document.getElementById('influxBucket').value = db.bucket;
    
    editingInfluxIndex = index;
    addInfluxBtn.textContent = 'Update InfluxDB';
    window.scrollTo({ top: document.querySelector('.influxdb-section').offsetTop, behavior: 'smooth' });
};

// Delete Entry
window.deleteInfluxDB = (index) => {
    currentInfluxDBs.splice(index, 1);
    renderInfluxDBs();
};

    function validateInfluxDB() {
        const errors = [];
        // Check if the array has at least one entry
    if (currentInfluxDBs.length === 0) {
        errors.push('At least one InfluxDB output must be added to the list');
    }
    return errors;
        const urls = influxUrls.value.trim();
        const token = influxToken.value.trim();
        const org = influxOrg.value.trim();
        const bucket = influxBucket.value.trim();

        if (!urls) errors.push('InfluxDB URLs are required');
        if (!token) errors.push('InfluxDB token is required');
        if (!org) errors.push('InfluxDB organization is required');
        if (!bucket) errors.push('InfluxDB bucket is required');

        if (urls) {
            const urlList = urls.split(',').map(url => url.trim());
            if (urlList.some(url => !url)) {
                errors.push('InfluxDB URLs contain empty entries or trailing commas');
            }
        }

        return errors;
    }

    function validateForm() {
        const errors = [];
        const protocol = configForm.protocol.value;
        const timeout = configForm.timeout.value;
        if (!configForm.name.value) errors.push('Device name is required');
        if (!timeout.match(/^\d+(ms|s)$/)) {
            errors.push('Timeout must be in the format "5s" or "500ms"');
        }

        let hostField, portField;
        if (protocol === 'tcp') {
            hostField = document.getElementById('host');
            portField = document.querySelector('#tcpFields input[name="port"]');
            if (!hostField.value) {
                errors.push('Host is required for Modbus TCP');
            }
            const portValue = portField.value.trim();
            if (!portValue) {
                errors.push('Port is required for Modbus TCP');
            } else {
                const port = parseInt(portValue);
                if (isNaN(port) || port <= 0 || port > 65535) {
                    errors.push('Port must be a valid number between 1 and 65535 for Modbus TCP');
                }
            }
        } else if (protocol === 'rtu') {
            hostField = null;
            portField = null;
            const controller = configForm.controller.value.trim();
            if (!controller) {
                errors.push('Controller is required for Modbus RTU');
            }
        } else if (protocol === 'snmp') {
            hostField = document.querySelector('#snmpFields input[name="host"]');
            portField = document.querySelector('#snmpFields input[name="port"]');
            if (!hostField.value) {
                errors.push('Host is required for SNMP');
            }
            const portValue = portField.value.trim();
            if (!portValue) {
                errors.push('Port is required for SNMP');
            } else {
                const port = parseInt(portValue);
                if (isNaN(port) || port <= 0 || port > 65535) {
                    errors.push('Port must be a valid number between 1 and 65535 for SNMP');
                }
            }
            const version = parseInt(configForm.version.value);
            if (![1, 2, 3].includes(version)) {
                errors.push('SNMP version must be 1, 2, or 3');
            }
            if (!configForm.community.value) {
                errors.push('SNMP community string is required');
            }
        }

        const influxErrors = validateInfluxDB();
        return errors.concat(influxErrors);
    }

    function renderConfigs() {
        if (typeof axios === 'undefined') {
            testOutput.textContent = 'Error: Axios is not loaded';
            return;
        }
        axios.get('/configs').then(res => {
            configList.innerHTML = '';
            existingConfigNames = res.data.map(filename => filename.replace('.conf', ''));
            const promises = res.data.map(filename => {
                const name = filename.replace('.conf', '');
                return axios.get(`/service_status/${name}`).then(statusRes => {
                    const status = statusRes.data.status;
                    lastKnownStatuses[name] = status;
                    return { filename, name, status };
                }).catch(err => {
                    console.error(`Error fetching status for ${name}:`, err);
                    return { filename, name, status: 'unknown' };
                });
            });

            Promise.all(promises).then(configs => {
                configs.forEach(({ filename, name, status }) => {
                    const displayName = filename;

                    const row = document.createElement('tr');
                    row.dataset.configName = name;
                    const nameCell = document.createElement('td');
                    const statusCell = document.createElement('td');
                    const actionsCell = document.createElement('td');

                    nameCell.textContent = displayName;
                    nameCell.className = 'config-name p-3';
                    statusCell.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                    statusCell.className = `config-status ${status} p-3`;
                    statusCell.dataset.status = status;
                    actionsCell.className = 'config-actions p-3 flex space-x-2';

                    const startBtn = document.createElement('button');
                    startBtn.textContent = 'Start';
                    startBtn.className = 'bg-green-500 text-white px-3 py-1 rounded-md hover:bg-green-600 transition transform hover:scale-105';
                    const stopBtn = document.createElement('button');
                    stopBtn.textContent = 'Stop';

                    const editBtn = document.createElement('button');
                    editBtn.textContent = 'Edit';
                    editBtn.className = 'bg-yellow-500 text-white px-3 py-1 rounded-md hover:bg-yellow-600 transition transform hover:scale-105';

                    stopBtn.className = 'bg-red-500 text-white px-3 py-1 rounded-md hover:bg-red-600 transition transform hover:scale-105';
                    const deleteBtn = document.createElement('button');
                    deleteBtn.textContent = 'Delete';
                    deleteBtn.className = 'bg-red-600 text-white px-3 py-1 rounded-md hover:bg-red-700 transition transform hover:scale-105';
                    const testBtn = document.createElement('button');
                    testBtn.textContent = 'Test';
                    testBtn.className = 'bg-blue-500 text-white px-3 py-1 rounded-md hover:bg-blue-600 transition transform hover:scale-105';
                    const downloadBtn = document.createElement('button');
                    downloadBtn.textContent = 'Download';
                    downloadBtn.className = 'bg-green-600 text-white px-3 py-1 rounded-md hover:bg-green-700 transition transform hover:scale-105';

const duplicateBtn = document.createElement('button');
duplicateBtn.textContent = 'Duplicate';
duplicateBtn.className = 'bg-purple-600 text-white px-3 py-1 rounded-md hover:bg-purple-700 transition transform hover:scale-105';

                    actionsCell.appendChild(startBtn);
                    actionsCell.appendChild(stopBtn);
                    actionsCell.appendChild(editBtn);  // Add this
                    actionsCell.appendChild(deleteBtn);
                    actionsCell.appendChild(testBtn);
                    actionsCell.appendChild(downloadBtn);
                    actionsCell.appendChild(duplicateBtn);

                    row.appendChild(nameCell);
                    row.appendChild(statusCell);
                    row.appendChild(actionsCell);

                    nameCell.addEventListener('click', () => {
                        loadConfig(name);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    });
                    startBtn.addEventListener('click', () => startService(name));
                    stopBtn.addEventListener('click', () => stopService(name));
                    editBtn.addEventListener('click', () => loadConfig(name));  // ADD THIS
                    deleteBtn.addEventListener('click', () => deleteConfig(name));
                    testBtn.addEventListener('click', () => testConfig(name));
                    downloadBtn.addEventListener('click', () => downloadConfig(name));
                    duplicateBtn.addEventListener('click', () => duplicateConfig(name));

                    configList.appendChild(row);
                });
            }).catch(err => {
                testOutput.textContent = `Error rendering configurations: ${err.response?.data?.error || err.message}`;
            });
        }).catch(err => {
            testOutput.textContent = `Error loading configurations: ${err.response?.data?.error || err.message}`;
        });
    }

    function updateStatuses() {
        if (typeof axios === 'undefined') {
            testOutput.textContent = 'Error: Axios is not loaded';
            return;
        }

        axios.get('/configs').then(res => {
            const configNames = res.data.map(filename => filename.replace('.conf', ''));
            const promises = configNames.map(name => {
                return axios.get(`/service_status/${name}`).then(statusRes => {
                    return { name, status: statusRes.data.status };
                }).catch(err => {
                    console.error(`Error fetching status for ${name}:`, err);
                    return { name, status: 'unknown' };
                });
            });

            Promise.all(promises).then(statuses => {
                statuses.forEach(({ name, status }) => {
                    if (lastKnownStatuses[name] !== status) {
                        lastKnownStatuses[name] = status;
                        const row = configList.querySelector(`tr[data-config-name="${name}"]`);
                        if (row) {
                            const statusCell = row.querySelector('.config-status');
                            if (statusCell) {
                                statusCell.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                                statusCell.className = `config-status ${status} p-3`;
                                statusCell.dataset.status = status;
                            }
                        }
                    }
                });
            }).catch(err => {
                console.error('Error updating statuses:', err);
            });
        }).catch(err => {
            console.error('Error fetching config list for status update:', err);
        });
    }

    function startStatusPolling() {
        setInterval(() => {
            updateStatuses();
        }, 5000);
    }

    function renderRegisters() {
        registersTable.innerHTML = '';
        currentRegisters.forEach((reg, index) => {
            const isBinaryType = ['discrete_inputs', 'coils'].includes(reg.type);
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="p-3">${reg.type}</td>
                <td class="p-3">${reg.name}</td>
                <td class="p-3">${reg.address}</td>
                <td class="p-3">${isBinaryType ? '-' : (reg.data_type === 'STRING' ? '-' : reg.byte_order)}</td>
                <td class="p-3">${isBinaryType ? '-' : reg.data_type}</td>
                <td class="p-3">${isBinaryType ? '-' : reg.scale}</td>
                <td class="p-3 flex space-x-2">
                    <button type="button" onclick="editRegister(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md hover:bg-yellow-600 transition transform hover:scale-105"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                    <button type="button" onclick="deleteRegister(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md hover:bg-red-600 transition transform hover:scale-105"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
                </td>
            `;
            registersTable.appendChild(row);
        });
    }

    function renderFields() {
        fieldsTable.innerHTML = '';
        currentFields.forEach((field, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="p-3">${field.name}</td>
                <td class="p-3">${field.oid}</td>
                <td class="p-3">${field.is_tag ? 'Yes' : 'No'}</td>
                <td class="p-3 flex space-x-2">
                    <button type="button" onclick="editField(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md hover:bg-yellow-600 transition transform hover:scale-105"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                    <button type="button" onclick="deleteField(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md hover:bg-red-600 transition transform hover:scale-105"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
                </td>
            `;
            fieldsTable.appendChild(row);
        });
    }

    function renderTags() {
        tagsTable.innerHTML = '';
        currentTags.forEach((tag, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="p-3">${tag.label}</td>
                <td class="p-3">${tag.value}</td>
                <td class="p-3 flex space-x-2">
                    <button type="button" onclick="editTag(${index})" class="bg-yellow-500 text-white px-3 py-1 rounded-md hover:bg-yellow-600 transition transform hover:scale-105"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                    <button type="button" onclick="deleteTag(${index})" class="bg-red-500 text-white px-3 py-1 rounded-md hover:bg-red-600 transition transform hover:scale-105"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
                </td>
            `;
            tagsTable.appendChild(row);
        });
    }

    window.addRegister = () => {
        const registerType = document.getElementById('registerType');
        const regName = document.getElementById('regName');
        const regAddress = document.getElementById('regAddress');
        const byteOrder = document.getElementById('byteOrder');
        const dataType = document.getElementById('dataType');
        const regScale = document.getElementById('regScale');

        if (!registerType || !regName || !regAddress || !byteOrder || !dataType || !regScale) {
            testOutput.textContent = 'Error: Register form elements not found';
            return;
        }

        const isBinaryType = ['discrete_inputs', 'coils'].includes(registerType.value);
        const reg = {
            type: registerType.value,
            name: regName.value,
            address: regAddress.value,
        };
        if (!isBinaryType) {
            reg.byte_order = byteOrder.value;
            reg.data_type = dataType.value;
            reg.scale = parseFloat(regScale.value) || 1.0;
        }
        const errors = validateRegister(reg);
        if (errors.length > 0) {
            testOutput.textContent = `${errors.join('; ')}`;
            return;
        }
        currentRegisters.push(reg);
        renderRegisters();
        testOutput.textContent = 'Register added';
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

        if (!registerType || !regName || !regAddress || !byteOrder || !dataType || !regScale) {
            testOutput.textContent = 'Error: Register form elements not found';
            return;
        }

        const isBinaryType = ['discrete_inputs', 'coils'].includes(registerType.value);
        const reg = {
            type: registerType.value,
            name: regName.value,
            address: regAddress.value,
        };
        if (!isBinaryType) {
            reg.byte_order = byteOrder.value;
            reg.data_type = dataType.value;
            reg.scale = parseFloat(regScale.value) || 1.0;
        }
        const errors = validateRegister(reg);
        if (errors.length > 0) {
            testOutput.textContent = `${errors.join('; ')}`;
            return;
        }

        currentRegisters[editingIndex] = reg;
        renderRegisters();
        testOutput.textContent = 'Register updated';
        resetRegisterForm();
    };

    function resetRegisterForm() {
        const registerType = document.getElementById('registerType');
        const regName = document.getElementById('regName');
        const regAddress = document.getElementById('regAddress');
        const byteOrder = document.getElementById('byteOrder');
        const dataType = document.getElementById('dataType');
        const regScale = document.getElementById('regScale');

        registerType.value = 'discrete_inputs';
        regName.value = '';
        regAddress.value = '';
        byteOrder.value = 'AB';
        dataType.value = 'BIT';
        regScale.value = '1.0';
        editingRegisterIndexInput.value = '-1';
        addRegisterBtn.textContent = 'Add Register';
        addRegisterBtn.onclick = addRegister;
        toggleRegisterFields();
    }

    window.deleteRegister = (index) => {
        currentRegisters.splice(index, 1);
        renderRegisters();
        testOutput.textContent = 'Register deleted';
    };

    window.editRegister = (index) => {
        const reg = currentRegisters[index];
        const registerType = document.getElementById('registerType');
        const regName = document.getElementById('regName');
        const regAddress = document.getElementById('regAddress');
        const byteOrder = document.getElementById('byteOrder');
        const dataType = document.getElementById('dataType');
        const regScale = document.getElementById('regScale');

        registerType.value = reg.type;
        regName.value = reg.name;
        regAddress.value = reg.address;
        if (!['discrete_inputs', 'coils'].includes(reg.type)) {
            byteOrder.value = reg.byte_order;
            dataType.value = reg.data_type;
            regScale.value = reg.scale;
        }
        toggleRegisterFields();
        editingRegisterIndexInput.value = index;
        addRegisterBtn.textContent = 'Update Register';
        addRegisterBtn.onclick = updateRegister;
    };

    window.addField = () => {
        const fieldName = document.getElementById('fieldName');
        const fieldOid = document.getElementById('fieldOid');
        const fieldIsTag = document.getElementById('fieldIsTag');

        if (!fieldName || !fieldOid || !fieldIsTag) {
            testOutput.textContent = 'Error: SNMP field form elements not found';
            return;
        }

        const field = {
            name: fieldName.value,
            oid: fieldOid.value,
            is_tag: fieldIsTag.checked
        };
        const errors = validateField(field, -1);
        if (errors.length > 0) {
            testOutput.textContent = `${errors.join('; ')}`;
            return;
        }
        currentFields.push(field);
        renderFields();
        testOutput.textContent = 'Field added';
        resetFieldForm();
    };

    window.updateField = () => {
        const fieldName = document.getElementById('fieldName');
        const fieldOid = document.getElementById('fieldOid');
        const fieldIsTag = document.getElementById('fieldIsTag');
        const editingIndex = parseInt(editingFieldIndexInput.value);

        if (!fieldName || !fieldOid || !fieldIsTag) {
            testOutput.textContent = 'Error: SNMP field form elements not found';
            return;
        }

        const field = {
            name: fieldName.value,
            oid: fieldOid.value,
            is_tag: fieldIsTag.checked
        };
        const errors = validateField(field, editingIndex);
        if (errors.length > 0) {
            testOutput.textContent = `${errors.join('; ')}`;
            return;
        }

        currentFields[editingIndex] = field;
        renderFields();
        testOutput.textContent = 'Field updated';
        resetFieldForm();
    };

    function resetFieldForm() {
        const fieldName = document.getElementById('fieldName');
        const fieldOid = document.getElementById('fieldOid');
        const fieldIsTag = document.getElementById('fieldIsTag');

        fieldName.value = '';
        fieldOid.value = '';
        fieldIsTag.checked = false;
        editingFieldIndexInput.value = '-1';
        addFieldBtn.textContent = 'Add Field';
        addFieldBtn.onclick = addField;
    }

    window.deleteField = (index) => {
        currentFields.splice(index, 1);
        renderFields();
        testOutput.textContent = 'Field deleted';
    };

    window.editField = (index) => {
        const field = currentFields[index];
        const fieldName = document.getElementById('fieldName');
        const fieldOid = document.getElementById('fieldOid');
        const fieldIsTag = document.getElementById('fieldIsTag');

        fieldName.value = field.name;
        fieldOid.value = field.oid;
        fieldIsTag.checked = field.is_tag;
        editingFieldIndexInput.value = index;
        addFieldBtn.textContent = 'Update Field';
        addFieldBtn.onclick = updateField;
    };

    window.addTag = () => {
        const tagLabel = document.getElementById('tagLabel');
        const tagValue = document.getElementById('tagValue');

        if (!tagLabel || !tagValue) {
            testOutput.textContent = 'Error: Tag form elements not found';
            return;
        }

        const tag = {
            label: tagLabel.value,
            value: tagValue.value
        };
        const errors = validateTag(tag, -1);
        if (errors.length > 0) {
            testOutput.textContent = `${errors.join('; ')}`;
            return;
        }
        currentTags.push(tag);
        renderTags();
        testOutput.textContent = 'Tag added';
        resetTagForm();
    };

    window.updateTag = () => {
        const tagLabel = document.getElementById('tagLabel');
        const tagValue = document.getElementById('tagValue');
        const editingIndex = parseInt(editingTagIndexInput.value);

        if (!tagLabel || !tagValue) {
            testOutput.textContent = 'Error: Tag form elements not found';
            return;
        }

        const tag = {
            label: tagLabel.value,
            value: tagValue.value
        };
        const errors = validateTag(tag, editingIndex);
        if (errors.length > 0) {
            testOutput.textContent = `${errors.join('; ')}`;
            return;
        }

        currentTags[editingIndex] = tag;
        renderTags();
        testOutput.textContent = 'Tag updated';
        resetTagForm();
    };

    function resetTagForm() {
        const tagLabel = document.getElementById('tagLabel');
        const tagValue = document.getElementById('tagValue');

        tagLabel.value = '';
        tagValue.value = '';
        editingTagIndexInput.value = '-1';
        addTagBtn.textContent = 'Add Tag';
        addTagBtn.onclick = addTag;
    }

    window.deleteTag = (index) => {
        currentTags.splice(index, 1);
        renderTags();
        testOutput.textContent = 'Tag deleted';
    };

    window.editTag = (index) => {
        const tag = currentTags[index];
        const tagLabel = document.getElementById('tagLabel');
        const tagValue = document.getElementById('tagValue');

        tagLabel.value = tag.label;
        tagValue.value = tag.value;
        editingTagIndexInput.value = index;
        addTagBtn.textContent = 'Update Tag';
        addTagBtn.onclick = updateTag;
    };

    window.cancelEdit = () => {
        configForm.reset();
        currentRegisters = [];
        currentFields = [];
        currentTags = [];

        currentInfluxDBs = []; // Clears the data array
        renderInfluxDBs();    // Clears the HTML table

        renderRegisters();
        renderFields();
        renderTags();
        editingConfigNameInput.value = '';
        cancelEditBtn.style.display = 'none';
        deviceNameInput.disabled = false;
        toggleProtocolFields(configForm.protocol.value);
        testOutput.textContent = 'Edit cancelled';
       

        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    function loadConfig(name) {
        axios.get(`/config/${name}`).then(res => {
            const data = res.data;
            configForm.name.value = data.name;
            configForm.timeout.value = data.timeout || '1s';
            configForm.protocol.value = data.protocol;
            toggleProtocolFields(configForm.protocol.value);

            if (data.protocol === 'tcp') {
                configForm.host.value = data.host || 'localhost';
                const tcpPortInput = document.querySelector('#tcpFields input[name="port"]');
                tcpPortInput.value = data.port || 502;
                configForm.slave_id.value = data.slave_id || 1;
            } else if (data.protocol === 'rtu') {
                configForm.controller.value = data.controller || '/dev/ttyS0';
                configForm.baud_rate.value = data.baud_rate || 9600;
                configForm.data_bits.value = data.data_bits || 8;
                configForm.parity.value = data.parity || 'N';
                configForm.stop_bits.value = data.stop_bits || 1;
                configForm.slave_id.value = data.slave_id || 1;
            } else if (data.protocol === 'snmp') {
                const snmpHostInput = document.querySelector('#snmpFields input[name="host"]');
                const snmpPortInput = document.querySelector('#snmpFields input[name="port"]');
                snmpHostInput.value = data.host || 'localhost';
                snmpPortInput.value = data.port || 161;
                configForm.version.value = data.version || 2;
                configForm.community.value = data.community || 'public';
            }

            currentRegisters = data.registers || [];
            currentFields = data.fields || [];
            currentTags = data.tags || [];
            renderRegisters();
            renderFields();
            renderTags();

            // Populate the global array instead of just filling input boxes
if (data.influxdb) {
    // Telegraf sends a list of objects; map it to our UI format
    const influxList = Array.isArray(data.influxdb) ? data.influxdb : [data.influxdb];
    currentInfluxDBs = influxList.map(db => ({
        urls: Array.isArray(db.urls) ? db.urls.join(', ') : db.urls,
        token: db.token,
        organization: db.organization || db.org,
        bucket: db.bucket
    }));
} else {
    currentInfluxDBs = [];
}
renderInfluxDBs(); // This draws the table with the loaded data
           
            editingConfigNameInput.value = name;
            cancelEditBtn.style.display = 'inline-block';
            deviceNameInput.disabled = true;
            testOutput.textContent = `Loaded configuration: ${name}.conf`;
        }).catch(err => {
            testOutput.textContent = `Error loading configuration: ${err.response?.data?.error || err.message}`;
        });
    }

    function deleteConfig(name) {
        if (confirm(`Are you sure you want to delete ${name}.conf?`)) {
            axios.delete(`/config/${name}`).then(res => {
                testOutput.textContent = res.data.message;
                axios.delete(`/service/${name}`).catch(err => {
                    console.error(`Error deleting service for ${name}:`, err);
                });
                renderConfigs();
            }).catch(err => {
                testOutput.textContent = `Error deleting configuration: ${err.response?.data?.error || err.message}`;
            });
        }
    }

    function testConfig(name) {
        axios.get(`/test_config/${name}`).then(res => {
            testOutput.textContent = `Test ${res.data.status}: ${res.data.output}`;
        }).catch(err => {
            testOutput.textContent = `Test failed: ${err.response?.data?.output || err.response?.data?.error || err.message}`;
        });
    }

    function downloadConfig(name) {
        window.location.href = `/download/${name}`;
    }


    function duplicateConfig(name) {
    const newName = prompt(`Enter a new name for the duplicate of "${name}":`);
    
    if (!newName) {
        return; // User cancelled
    }

    if (!newName.trim()) {
        testOutput.textContent = 'Configuration name cannot be empty';
        return;
    }

    // Check if name already exists
    if (existingConfigNames.includes(newName)) {
        testOutput.textContent = 'Configuration name already exists';
        return;
    }

    axios.post(`/duplicate_config/${name}`, { new_name: newName })
        .then(res => {
            testOutput.textContent = `${res.data.message}`;
            renderConfigs(); // Refresh the list
        })
        .catch(err => {
            testOutput.textContent = `Error duplicating: ${err.response?.data?.error || err.message}`;
        });
}



    window.startService = (name) => {
        axios.post(`/start_service/${name}`).then(res => {
            testOutput.textContent = `Started communication service for ${name}.conf`;
            updateStatuses();
            setTimeout(() => {
                updateStatuses();
            }, 2000);
        }).catch(err => {
            testOutput.textContent = `Error starting service for ${name}.conf: ${err.response?.data?.error || err.message}`;
            updateStatuses();
        });
    };

    window.stopService = (name) => {
        axios.post(`/stop_service/${name}`).then(res => {
            testOutput.textContent = `Stopped communication service for ${name}.conf`;
            updateStatuses();
        }).catch(err => {
            testOutput.textContent = `Error stopping service for ${name}.conf: ${err.response?.data?.error || err.message}`;
            updateStatuses();
        });
    };

    document.getElementById('saveConfigBtn').addEventListener('click', () => {
        const errors = validateForm();
        if (errors.length > 0) {
            testOutput.textContent = `${errors.join('; ')}`;
            return;
        }

        const editingConfigName = editingConfigNameInput.value;
        const name = editingConfigName || configForm.name.value;
        if (!editingConfigName && existingConfigNames.includes(name)) {
            testOutput.textContent = 'Configuration name already exists';
            return;
        }

        const data = {
            name: name,
            timeout: configForm.timeout.value,
            protocol: configForm.protocol.value,
            registers: currentRegisters,
            fields: currentFields,
            tags: currentTags,
            influxdb: currentInfluxDBs.map(db => ({
        urls: typeof db.urls === 'string' ? db.urls.split(',').map(url => url.trim()) : db.urls,
        token: db.token,
        organization: db.organization,
        bucket: db.bucket
    }))
        };

        if (data.protocol === 'tcp') {
            data.host = document.querySelector('#tcpFields input[name="host"]').value;  // Specific
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
            data.community = configForm.community.value;
        }

        // Perform the test but don't block saving
        axios.post(`/test_config_from_data`, data).then(res => {
            // Display test result
            if (res.data.status === 'success') {
                testOutput.textContent = `Test passed: ${res.data.output}`;
            } else {
                testOutput.textContent = `Test failed: ${res.data.output}${res.data.warning ? `\n${res.data.warning}` : ''}`;
            }

            // Proceed to save the configuration regardless of test result
            axios.post(`/config/${name}`, data).then(saveRes => {
                testOutput.textContent += `\nConfiguration saved: ${saveRes.data.message}`;
                renderConfigs();
                if (!editingConfigName) {
                    configForm.reset();
                    currentRegisters = [];
                    currentFields = [];
                    currentTags = [];
                    renderRegisters();
                    renderFields();
                    renderTags();
                    toggleProtocolFields(configForm.protocol.value);
                }
                editingConfigNameInput.value = '';
                cancelEditBtn.style.display = 'none';
                deviceNameInput.disabled = false;
            }).catch(saveErr => {
                testOutput.textContent += `\nError saving configuration: ${saveErr.response?.data?.error || saveErr.message}`;
            });
        }).catch(testErr => {
            testOutput.textContent = `Test failed: ${testErr.response?.data?.error || testErr.message}`;

            // Proceed to save the configuration even if the test fails
            axios.post(`/config/${name}`, data).then(saveRes => {
                testOutput.textContent += `\nConfiguration saved: ${saveRes.data.message}`;
                renderConfigs();
                if (!editingConfigName) {
                    configForm.reset();
                    currentRegisters = [];
                    currentFields = [];
                    currentTags = [];
                    renderRegisters();
                    renderFields();
                    renderTags();
                    toggleProtocolFields(configForm.protocol.value);
                }
                editingConfigNameInput.value = '';
                cancelEditBtn.style.display = 'none';
                deviceNameInput.disabled = false;
            }).catch(saveErr => {
                testOutput.textContent += `\nError saving configuration: ${saveErr.response?.data?.error || saveErr.message}`;
            });
        });
    });

    window.toggleProtocolFields = (protocol) => {
        const tcpFields = document.getElementById('tcpFields');
        const rtuFields = document.getElementById('rtuFields');
        const snmpFields = document.getElementById('snmpFields');
        const slaveIdField = document.getElementById('slave_id').parentElement;

        if (protocol === 'tcp') {
            tcpFields.style.display = 'block';
            rtuFields.style.display = 'none';
            snmpFields.style.display = 'none';
            slaveIdField.style.display = 'block';
            modbusRegistersSection.style.display = 'block';
            snmpFieldsSection.style.display = 'none';
        } else if (protocol === 'rtu') {
            tcpFields.style.display = 'none';
            rtuFields.style.display = 'block';
            snmpFields.style.display = 'none';
            slaveIdField.style.display = 'block';
            modbusRegistersSection.style.display = 'block';
            snmpFieldsSection.style.display = 'none';
        } else if (protocol === 'snmp') {
            tcpFields.style.display = 'none';
            rtuFields.style.display = 'none';
            snmpFields.style.display = 'block';
            slaveIdField.style.display = 'none';
            modbusRegistersSection.style.display = 'none';
            snmpFieldsSection.style.display = 'block';
        }
    };

    registerTypeSelect.addEventListener('change', toggleRegisterFields);
    document.getElementById('dataType').addEventListener('change', updateByteOrderWarning);
    document.getElementById('byteOrder').addEventListener('change', updateByteOrderWarning);

    const themeToggle = document.getElementById('themeToggle');
if (localStorage.getItem('darkMode') === 'false') document.body.classList.remove('dark');

if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        document.body.classList.toggle('dark');
        localStorage.setItem('darkMode', document.body.classList.contains('dark'));
    });
}

    toggleRegisterFields();
    renderConfigs();
    startStatusPolling();



});
