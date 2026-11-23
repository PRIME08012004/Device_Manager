(() => {
    const overlay = document.getElementById('licenseOverlay');
    const state = document.getElementById('licenseOverlayState');
    const retry = document.getElementById('licenseOverlayRetry');
    const details = document.getElementById('licenseOverlayDetails');
    const diagnosticSection = document.getElementById('licenseOverlayDiagnostics');
    const diagnosticData = document.getElementById('licenseOverlayDiagnosticData');
    if (!overlay || !state || !retry || overlay.hidden) return;

    let retryTimer = null;

    function showDiagnostics(value) {
        if (!value) return;
        diagnosticData.textContent = JSON.stringify(value, null, 2);
        diagnosticSection.classList.remove('hidden');
    }

    async function readJson(response) {
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            throw new Error(`Server returned ${response.status} ${response.statusText} instead of JSON.`);
        }
        return response.json();
    }

    function retrySoon() {
        retry.disabled = false;
        retryTimer = window.setTimeout(checkLicense, 5000);
    }

    async function checkLicense() {
        window.clearTimeout(retryTimer);
        retry.disabled = true;
        details.classList.add('hidden');
        state.textContent = 'Checking this controller and looking for the USB license…';
        try {
            const licenseResponse = await fetch('/api/license', { cache: 'no-store' });
            const license = await readJson(licenseResponse);
            if (license.valid) {
                overlay.hidden = true;
                overlay.classList.add('hidden');
                return;
            }

            const statusResponse = await fetch('/api/usb/status', { cache: 'no-store' });
            const usbStatus = await readJson(statusResponse);
            showDiagnostics(usbStatus.diagnostics);
            state.textContent = usbStatus.message;
            if (usbStatus.state !== 'ready') {
                retrySoon();
                return;
            }

            const response = await fetch('/api/usb/install_license', {
                method: 'POST',
                headers: { 'Accept': 'application/json' },
                cache: 'no-store'
            });
            const result = await readJson(response);
            if (!response.ok) throw new Error(result.error || 'License installation failed.');
            showDiagnostics(result.diagnostics);
            state.textContent = result.message;
            details.textContent = `License ${result.license.license_id || ''} · up to ${result.license.max_devices} devices. License installed.`;
            details.classList.remove('hidden');
            window.setTimeout(() => window.location.reload(), 900);
        } catch (error) {
            state.textContent = error.message || 'Could not check the USB license.';
            retrySoon();
        }
    }

    retry.addEventListener('click', checkLicense);
    checkLicense();
})();
