# NEU159 USB License Installation Issue

## What the app is supposed to do

When the app opens without an installed license, it serves the activation page. The page calls `GET /api/license`, then `GET /api/usb/status`. If the USB license is found and verifies successfully, it calls `POST /api/usb/install_license`. The server then saves the license to the repo's `license.json`; later visits can open the dashboard without the USB.

The browser cannot read USB files directly. The browser's Network tab shows requests to the Flask API; Flask performs the filesystem and USB operations on the controller. With no cached license, the expected sequence is:

1. `GET /api/license`
2. `GET /api/usb/status`
3. `POST /api/usb/install_license` only after the USB status is `ready`

If an already-installed license is valid, the server opens the dashboard directly. In that case the USB is intentionally not checked; the dashboard makes a `GET /api/license` status request.

For now, the dashboard and configuration pages, their APIs, and device actions are available without a USB license, at the owner's request. License activation remains available at `/license`. Set `NEU_LICENSE_REQUIRED=true` to re-enable license gating and device limits once key rotation is complete.

The previously embedded public key has been retired and replaced by a placeholder. This deliberately fails closed until the owner supplies the replacement public key. The app does not load `vendor_pub.pem` from disk.

## What I found on the USB

The USB is mounted at `/run/media/omkar-shirsekar/E4F1-D27A`. Its license files are in:

```text
NEU159_USB/licenses/amd64/license.lic
NEU159_USB/licenses/arm64/license.lic
```

The app originally did not look for a `.lic` file inside the architecture directory. The scanner now supports `license.lic` as well as `license.json`, and accepts line-wrapped signature text and backslash line continuations.

## Why `license.json` is not being created

The USB file is being found and parsed, but its `signature` field contains a PEM **private key**, rather than a license signature. The verifier intentionally rejects that value before the atomic write, so no partial `license.json` is created. The current rejection message is:

```text
The signature field contains a PEM private key, not a license signature.
```

The private key must never be copied into the license file, app source, or USB license folder. It is used only by the issuer to sign the license data. The resulting signature is a separate base64 string. For the configured RSA-3072 public key, the signature bytes are 384 bytes (512 base64 characters).

The license signature must cover the canonical JSON encoding of the `license` object:

```python
json.dumps(license_data, sort_keys=True, separators=(",", ":")).encode("utf-8")
```

The app verifies that signature using RSA PKCS#1 v1.5 with SHA-256. The `signature` property in the final JSON must contain only the base64-encoded signature result, not a PEM key or PEM headers.

## Machine ID behavior

The USB license has a `machine_id` that differs from this development machine's `/etc/machine-id`. At the owner's request, machine-ID enforcement is currently disabled by default. Set `NEU_ENFORCE_MACHINE_ID=true` to enable it again. The `machine_id` field should still be populated with the target controller ID so the license is ready for binding later.

## Key handling

The private key was pasted into the conversation. Treat it as compromised and rotate the issuer key pair before production use. Put only the replacement public key in the app's `PUBLIC_KEY_PEM` constant. Keep the replacement private key on the trusted issuer/signing machine and use it only to generate license signatures. The current app embeds the public key; it does not automatically load `vendor_pub.pem`.

## How to complete activation

1. Generate a replacement issuer key pair and update `PUBLIC_KEY_PEM` with its public key.
2. Create the `license` object with `product: "NEU159"`, a license ID, target `machine_id`, `license_type`, ISO-8601 `issued_at`, `expires_at` (`null` for perpetual), and integer `max_devices`.
3. On the issuer machine, sign the canonical JSON for that object with the replacement private key using RSA PKCS#1 v1.5 and SHA-256. Base64-encode the resulting signature bytes.
4. Write the final JSON document to `NEU159_USB/licenses/amd64/license.lic` (and the appropriate ARM directory if needed). The document should have exactly two top-level properties: `license` and `signature`.
5. Restart Flask and reload the page. A valid USB should report `ready`, then the install request should return the saved path. The default cache is the repo's ignored `license.json`; `NEU_LICENSE_PATH` can override it.

The repo is writable and no `license.json` was present during diagnosis, so the current blocker is license verification, not directory permissions.
