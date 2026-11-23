# NEU159 USB License Installation Issue

## What the app is supposed to do

The dashboard and configuration pages show a blocking license overlay while checking the cached license. A valid cached license dismisses the overlay. If no valid license is installed, the overlay calls `GET /api/usb/status`; if a valid USB license is found, it calls `POST /api/usb/install_license`. The server saves the license to the repo's `license.json`, reloads the current page, and dismisses the overlay after validating the cached copy.

The browser cannot read USB files directly. The browser's Network tab shows requests to the Flask API; Flask performs the filesystem and USB operations on the controller. With no cached license, the expected sequence is:

1. `GET /api/license`
2. `GET /api/usb/status`
3. `POST /api/usb/install_license` only after the USB status is `ready`

An installed, valid license is cached in the repo's ignored `license.json`, so later visits can access the dashboard without reconnecting the USB. Without a valid cached license, the overlay stays in front and dashboard/configuration APIs and device actions are blocked. The overlay checks the USB and installs a valid license before access is granted.

License enforcement is mandatory in the app. `/license` and the license/USB status APIs remain available so an unlicensed controller can activate.

The app verifies signatures using the replacement public key embedded in `app.py`; it does not load `vendor_pub.pem` from disk.

## What I found on the USB

The USB is mounted at `/run/media/omkar-shirsekar/E4F1-D27A`. Its license files are in:

```text
NEU159_USB/licenses/amd64/license.lic
NEU159_USB/licenses/arm64/license.lic
```

The app originally did not look for a `.lic` file inside the architecture directory. The scanner now supports `license.lic` as well as `license.json`, and accepts line-wrapped signature text and backslash line continuations.

## Why `license.json` is not being created

The USB file is being found and parsed. An earlier version mistakenly placed the PEM private key in the `signature` field; that has since been replaced. The current file contains a 512-character base64 value (384 bytes), which is the expected size for RSA-3072, but the signature does not verify against either the current public key or the retired public key. This points to a signing-key mismatch or license data edited after signing. The current rejection is:

```text
License signature does not match the license contents.
```

Machine-ID enforcement is disabled, and the current failure is not a USB-path, JSON parsing, or cache-permission issue. The app refuses to write `license.json` until the signature verifies.

The license signature must cover the canonical JSON encoding of the `license` object:

```python
json.dumps(license_data, sort_keys=True, separators=(",", ":")).encode("utf-8")
```

The app verifies that signature using RSA PKCS#1 v1.5 with SHA-256. The `signature` property in the final JSON must contain only the base64-encoded signature result, not a PEM key or PEM headers.

## Machine ID behavior

The USB license has a `machine_id` that differs from this development machine's `/etc/machine-id`. At the owner's request, machine-ID enforcement is currently disabled by default. Set `NEU_ENFORCE_MACHINE_ID=true` to enable it again. The `machine_id` field should still be populated with the target controller ID so the license is ready for binding later.

## Key handling

The former private key was pasted into the conversation and is considered compromised. The app now embeds the replacement public key, which matches `vendor_pub.pem`; it does not load that file at runtime. Keep the replacement private key on the trusted issuer/signing machine and use it only to generate license signatures. Never put a private key in the app, repo, license JSON, or USB.

## How to complete activation

1. Confirm the issuer private key corresponds to the embedded replacement public key. The derived public-key fingerprints must match.
2. Create the `license` object with `product: "NEU159"`, a license ID, target `machine_id`, `license_type`, ISO-8601 `issued_at`, `expires_at` (`null` for perpetual), and integer `max_devices`.
3. On the issuer machine, sign the canonical JSON for that object with the replacement private key using RSA PKCS#1 v1.5 and SHA-256. Base64-encode the resulting signature bytes.
4. Write the final JSON document to `NEU159_USB/licenses/amd64/license.lic` (and the appropriate ARM directory if needed). The document should have exactly two top-level properties: `license` and `signature`.
5. Restart Flask and reload the page. A valid USB should report `ready`, then the install request should return the saved path. The default cache is the repo's ignored `license.json`; `NEU_LICENSE_PATH` can override it.

License gating and the licensed device limit are mandatory. Restart Flask for the updated request guard to take effect.

The repo is writable and no `license.json` was present during diagnosis, so the current blocker is license verification, not directory permissions.
