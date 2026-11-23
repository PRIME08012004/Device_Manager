# AGENT.md: Fix NEU159 USB License Activation

## Goal

Make USB license activation work end to end. A valid, correctly signed `license.lic` on the USB must verify, install to the repo's `license.json`, and let the dashboard open without the USB afterwards.

## Context

- Flask serves the activation page. The browser never reads the USB; Flask does, on the controller.
- Expected request sequence with no cached license:
  1. `GET /api/license`
  2. `GET /api/usb/status`
  3. `POST /api/usb/install_license` (only when USB status is `ready`)
- USB mount: `/run/media/omkar-shirsekar/E4F1-D27A`
- License files: `NEU159_USB/licenses/amd64/license.lic` and `NEU159_USB/licenses/arm64/license.lic`
- Cache path: repo `license.json` (git-ignored). `NEU_LICENSE_PATH` overrides it.
- The scanner already supports `license.lic` and `license.json`, line-wrapped signatures, and backslash line continuations.
- Machine-ID enforcement is off by default. `NEU_ENFORCE_MACHINE_ID=true` turns it on.

## Root cause

The existing USB `license.lic` has a PEM **private key** in its `signature` field. The verifier correctly rejects it, so no `license.json` is written. The app code is not the bug. The license file was issued wrongly, and the issuer key is compromised because the private key was pasted into a chat.

## Hard rules

1. **Never** write a private key into the app source, the repo, `license.json`, the USB, logs, or test fixtures.
2. **Never** loosen the verifier to accept a PEM or any non-signature value in `signature`.
3. Embed only the **public** key in `PUBLIC_KEY_PEM`. Do not load `vendor_pub.pem` from disk.
4. Keep the atomic-write behavior: no partial `license.json` on failure.
5. Add `*.pem` and `*.key` to `.gitignore`.

## Tasks

### 1. Build the issuer tool (outside the app package)

Create `tools/issue_license.py`, a standalone CLI that runs only on the trusted signing machine.

- Arguments: `--private-key PATH`, `--machine-id`, `--license-id`, `--license-type` (default `perpetual`), `--max-devices` (int), `--expires-at` (ISO-8601 or `null`), `--out PATH`
- Build this `license` object:
  ```json
  {
    "product": "NEU159",
    "license_id": "...",
    "machine_id": "...",
    "license_type": "perpetual",
    "issued_at": "<now, ISO-8601 UTC>",
    "expires_at": null,
    "max_devices": 5
  }
  ```
- Sign the canonical bytes. The bytes must match the verifier exactly:
  ```python
  payload = json.dumps(license_data, sort_keys=True, separators=(",", ":")).encode("utf-8")
  sig = private_key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
  ```
- Write `{"license": {...}, "signature": "<base64 of sig>"}` as the output. The document must have exactly two top-level keys.
- Safety checks, all fatal:
  - Refuse to run if the loaded key is not RSA-3072.
  - Refuse to write if the signature string contains `-----BEGIN`.
  - After signing, verify the result against the matching public key before writing the file.
  - Check the decoded signature is 384 bytes (512 base64 chars).
- Also add `tools/gen_keypair.sh`, which uses `openssl genrsa -out issuer_private.pem 3072` and derives `issuer_public.pem`. It prints a reminder that the private key stays off the repo and the USB.

### 2. Rotate the key

- Generate a new keypair (do not reuse the leaked one).
- Replace `PUBLIC_KEY_PEM` in the app with the new **public** key only.
- Leave a short comment next to it saying the previous key was retired because of exposure.
- Do not commit the private key. If it is missing from the environment, stop and ask the owner to generate and place it.

### 3. Re-issue the licenses

- Use the issuer tool with the target controller's `/etc/machine-id` as `--machine-id`. Always populate this, even while enforcement is off.
- Use `--license-id NEU-2026-0001 --license-type perpetual --max-devices 5` unless told otherwise.
- Write the result to `NEU159_USB/licenses/amd64/license.lic`, and to `arm64/` if needed.

### 4. Improve the verifier's error handling (without weakening it)

- Keep the existing rejection for a PEM private key in `signature`.
- Add clear distinct messages for: invalid base64, wrong signature length, signature does not match, missing `license` or `signature` key, and extra top-level keys.
- Make sure `/api/usb/status` returns these messages so the activation page can show them.

### 5. Tests

Add tests that cover:

- A valid license (signed with a throwaway test keypair generated in the test) installs and creates `license.json`.
- A license with a PEM private key in `signature` is rejected and no `license.json` is created.
- A tampered `license` field (for example `max_devices` changed) fails verification.
- Line-wrapped base64 and backslash-continued signatures still parse.
- With `NEU_ENFORCE_MACHINE_ID=true`, a mismatched `machine_id` is rejected. With it unset, it is accepted.
- Test keys are generated at test time. Do not commit any key material.

### 6. Verify manually

1. Restart Flask and reload the activation page.
2. Confirm the Network tab shows `GET /api/license`, then `GET /api/usb/status` returning `ready`, then `POST /api/usb/install_license` returning the saved path.
3. Confirm `license.json` exists, then unplug the USB, reload, and confirm the dashboard opens directly (only `GET /api/license` is called).

## Definition of done

- [ ] New public key embedded; no private key anywhere in the repo or on the USB
- [ ] `tools/issue_license.py` and `tools/gen_keypair.sh` added, with safety checks
- [ ] New `license.lic` issued and placed on the USB
- [ ] Verifier errors are specific and surfaced in the UI
- [ ] Tests pass
- [ ] `*.pem` and `*.key` are git-ignored
- [ ] Manual activation flow works with and without the USB

## If blocked

If you need the new private key, the controller's machine ID, or a decision about enforcement, stop and ask the owner. Do not invent values or work around the verifier.
