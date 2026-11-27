// This status request is visible in DevTools and confirms the cached license
// that the server checked before rendering the dashboard.
fetch('/api/license', { cache: 'no-store' })
    .then(response => response.json())
    .then(data => {
        if (!data.valid) console.info('No cached NEU159 license is installed yet.');
    })
    .catch(error => {
        console.error('License status request failed:', error);
    });

function loadDashboardStats() {
    const total = document.getElementById('totalDevices');
    const active = document.getElementById('activeDevices');
    const inactive = document.getElementById('inactiveDevices');

    if (!total || !active || !inactive) return; // key line

    axios.get('/dashboard/stats').then(res => {
        total.textContent = res.data.total;
        active.textContent = res.data.active;
        inactive.textContent = res.data.inactive;
    });
}

loadDashboardStats();

function parseInfluxCsv(csvText) {
    const records = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < csvText.length; i += 1) {
        const char = csvText[i];
        if (quoted) {
            if (char === '"' && csvText[i + 1] === '"') {
                cell += '"';
                i += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            row.push(cell);
            cell = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && csvText[i + 1] === '\n') i += 1;
            row.push(cell);
            if (row.some(value => value !== '')) records.push(row);
            row = [];
            cell = '';
        } else {
            cell += char;
        }
    }
    if (cell !== '' || row.length) {
        row.push(cell);
        if (row.some(value => value !== '')) records.push(row);
    }

    const readings = [];
    let header = null;
    records.forEach(record => {
        if (!record[0] || record[0].startsWith('#')) return;
        if (record.includes('_time') && record.includes('_value')) {
            header = record;
            return;
        }
        if (!header) return;
        const values = Object.fromEntries(header.map((key, index) => [key, record[index] || '']));
        if (values._value !== '') {
            readings.push({
                time: values._time,
                measurement: values._measurement,
                field: values._field,
                value: values._value,
            });
        }
    });
    return readings;
}

async function loadInfluxDashboardData() {
    const status = document.getElementById('influxDashboardStatus');
    const rows = document.getElementById('influxDashboardRows');
    if (!status || !rows) return;

    status.textContent = 'Loading InfluxDB settings…';
    try {
        const configResponse = await fetch('/api/influx-config');
        if (!configResponse.ok) throw new Error(`Could not load InfluxDB settings (${configResponse.status}).`);
        const cfg = await configResponse.json();
        if (!cfg.url || !cfg.token || !cfg.org || !cfg.bucket) {
            throw new Error('Set INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, and INFLUXDB_BUCKET to load readings.');
        }

        const escapedBucket = cfg.bucket.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const flux = `from(bucket: "${escapedBucket}")\n  |> range(start: -1h)\n  |> filter(fn: (r) => r._measurement == "pdu")`;
        const queryUrl = new URL('/api/v2/query', cfg.url);
        queryUrl.searchParams.set('org', cfg.org);
        status.textContent = 'Querying the last hour of PDU readings…';
        const queryResponse = await fetch(queryUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${cfg.token}`,
                'Content-Type': 'application/vnd.flux',
                'Accept': 'application/csv',
            },
            body: flux,
        });
        if (!queryResponse.ok) {
            const details = await queryResponse.text();
            throw new Error(`InfluxDB query failed (${queryResponse.status}): ${details.slice(0, 240)}`);
        }

        const readings = parseInfluxCsv(await queryResponse.text()).slice(-100).reverse();
        rows.replaceChildren();
        if (!readings.length) {
            rows.innerHTML = '<tr><td colspan="4" style="padding:12px;color:var(--text2);">No PDU readings found in the last hour.</td></tr>';
            status.textContent = 'Connected to InfluxDB.';
            return;
        }
        readings.forEach(reading => {
            const row = document.createElement('tr');
            [reading.time, reading.measurement, reading.field, reading.value].forEach(value => {
                const cell = document.createElement('td');
                cell.textContent = value || '—';
                cell.style.padding = '10px 12px';
                row.appendChild(cell);
            });
            rows.appendChild(row);
        });
        status.textContent = `Showing ${readings.length} reading${readings.length === 1 ? '' : 's'} from the last hour.`;
    } catch (error) {
        rows.replaceChildren();
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 4;
        cell.textContent = error.message || 'Could not load InfluxDB readings.';
        cell.style.cssText = 'padding:12px;color:var(--danger);';
        row.appendChild(cell);
        rows.appendChild(row);
        status.textContent = 'InfluxDB data could not be loaded.';
    }
}

document.getElementById('refreshInfluxDashboard')?.addEventListener('click', loadInfluxDashboardData);
loadInfluxDashboardData();
