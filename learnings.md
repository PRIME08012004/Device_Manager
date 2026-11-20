# Project review notes

Reviewed the repository instructions in `agents.md` before inspecting the application. This file is the working log for the project walkthrough and the findings below are based on the current checkout.

## Project shape

- `app.py` is a single-file Flask application. It serves the dashboard and configuration UI, reads/writes Telegraf configuration files, creates systemd service files, calls `systemctl` and `telegraf`, keeps MQTT data in memory, handles Modbus mapping JSON, and uploads/parses MIB files.
- `templates/dashboard.html` loads `static/dashboard.js`; `templates/config.html` loads `static/config.js`. `templates/index.html` loads the older `static/script.js`, but `/` currently renders `dashboard.html`, so the older page/script is not on the normal route flow.
- `configs/*.conf` are working Telegraf configurations. The examples cover SNMP and Modbus TCP. They contain credential fields (InfluxDB tokens and SNMP community values), so treat those files as sensitive and avoid copying values into notes or logs.
- `mibs/` contains uploaded MIB examples; `modbus_config.json` stores register exposure mapping. `requirements.txt` is the Python dependency list. No test suite, package manifest, deployment files, or portal code were found in the tracked project layout during this pass.
- There is no licensing implementation yet: no verifier, USB handling module, public key, license endpoint, activation UI, or portal. Follow the build order and ask the owner before adding a portal or test location, as required by `agents.md`.

## Behavior traced

- Device lifecycle endpoints in `app.py`: list/read/save/delete configs; duplicate, download, and generate configs; test configs using Telegraf; create/start/stop/delete systemd services; report service status and dashboard totals.
- Supporting endpoints handle Modbus mapping (`/api/modbus_config`), in-memory MQTT live data (`/api/live*`), MIB upload/list/delete/walk, and direct SNMP queries (`/api/snmp_live_query`).
- The UI in `config.html` is a tabbed device editor with overview, configuration, registers, tags, integrations, and MIB/log views. `config.js` handles form validation/rendering, service actions and status polling, Modbus mapping, and MIB browsing/query flows. `dashboard.html` and `dashboard.js` show service totals.
- The app starts MQTT polling opportunistically on import and then serves Flask on `0.0.0.0:2999` with debug disabled.

## Findings to account for in future work

- The device-management APIs have no authentication or authorization in this repo, while they can write configs and systemd unit files and invoke system services. Since the server listens on all interfaces, deployment network access is a major trust boundary. This matters especially before adding license-management endpoints.
- `agents.md` requires backend validation for device names, but current routes accept URL/data names without applying the specified `^[A-Za-z0-9_-]{1,40}$` check. The licensing work must validate names at each route that uses them for paths or unit names.
- Config writes currently happen without a lock and without license enforcement. `duplicate_config` also creates another config without checking any limit; `start_service` starts any existing config. These are the required enforcement points from `agents.md`.
- `generate_telegraf_conf` interpolates request values into TOML strings. Backend validation/escaping will matter for malformed or hostile input; frontend validation alone is not a trust boundary.
- MIB upload sanitizes filenames, but this pass did not find an upload-size cap. The USB size/symlink/path requirements in `agents.md` are separate and must be enforced by the new USB code.
- Several frontend renderers build HTML strings with `innerHTML`. Keep server- or user-supplied values out of raw HTML contexts or escape them before rendering when those paths are changed.
- Existing sample config files include secrets/credential-like values. Do not put them in issue reports, commits, or this log; review repository history and rotate them if they are real and have been exposed.

## Review scope and workspace state

- This pass inspected repository instructions, route and function structure, application behavior, templates, JavaScript responsibilities, dependencies, sample configs, and supporting data files.
- No application behavior was changed and no tests were run; the request was a project walkthrough and the repository contains no visible test suite.
- `.gitignore` already had a user change (`agents.md` added to ignore rules) when the review began. Preserve it. `learnings.md` was empty when read and is being used for these notes.

## Config limit implementation

- Owner chose a fixed cap of 5 saved config files for this feature, so this change uses a local constant instead of introducing the signed-license flow described elsewhere in `agents.md`.
- The server counts persistent `.conf` files in `configs/`, ignores `temp_test_*.conf`, and uses a shared lock around save, duplicate, delete, and start checks. Input entries inside a config do not affect the cap.
- There are four checked-in sample config files, leaving room for one more saved config under the cap.
- New saves and duplicates are rejected with HTTP 403 and the `license_limit` error when they would exceed 5. Existing configs can still be edited at the cap. Service starts are rejected if the current saved config file count is already over 5.
- The configuration page recognizes that response and displays a browser popup. Device names are also checked against the repo's required allowed-name format before they are used in config or service paths.
- I reviewed the resulting diff and ran `git diff --check` with CRLF-aware whitespace handling. No tests were added or run; the repo has no test location and `agents.md` says to ask before creating one.
