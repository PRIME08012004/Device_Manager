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
