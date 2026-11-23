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

    if (!total || !active || !inactive) return; // 👈 key line

    axios.get('/dashboard/stats').then(res => {
        total.textContent = res.data.total;
        active.textContent = res.data.active;
        inactive.textContent = res.data.inactive;
    });
}

loadDashboardStats();
