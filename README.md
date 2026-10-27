# Calendar Bridge

A small Node.js service that mirrors events from a published Microsoft iCalendar (`.ics`) feed into one or more Google Calendars.

It is designed for a small Linux host such as a Wyse thin client. The service copies the event title and time, and optionally the location and description. It is one-way: the source calendar is authoritative and changes made in Google Calendar may be overwritten on the next synchronization.

The project was inspired by the original macOS/EventKit calendar-sync series: [Building a local calendar sync](https://pumpingco.de/blog/building-local-calendar-sync-day-01-creating-a-new-project-and-exploring-eventkit-2/).

## Requirements

- Node.js 20 or newer
- npm
- A published or otherwise reachable Microsoft `.ics` URL
- A Google Cloud OAuth desktop application
- A Google Calendar where the mirrored events will be created

## Install

From this directory:

```sh
npm install
npm test
npm run build
```

The TypeScript source is compiled to `dist/`. The `npm run sync` and `npm run authorize` commands use `tsx` directly, so building first is useful for validation but is not required for normal development.

## Google authorization

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the Google Calendar API.
4. Configure the OAuth consent screen.
5. Create an OAuth client of type **Desktop app**.
6. Download the JSON file as `credentials.json` into this directory.

`credentials.json` is private and is ignored by Git.

Copy the example configuration:

```sh
cp config.example.yaml config.yaml
```

Edit `config.yaml` with the source URL, timezone, and destination calendar ID. Then authorize:

```sh
npm run authorize -- --config config.yaml
```

The command prints a Google authorization URL. Open it in a browser, grant calendar access, and paste the returned authorization code. The resulting `token.json` is also private and ignored by Git.

For a headless machine, authorize on a workstation and transfer `credentials.json` and `token.json` securely, or use SSH port forwarding if the OAuth flow requires it.

## Configuration

`config.example.yaml` contains the complete schema:

```yaml
source:
  icsUrl: "https://example.invalid/work-calendar.ics"
  timezone: "Europe/Vienna"

destinations:
  - calendarId: "primary"
    name: "Work mirror"

sync:
  lookaheadDays: 90
  onlyBusy: true
  copyDescription: true
  copyLocation: true
  visibility: private
  summaryPrefix: ""
  deleteRemovedEvents: true
  allowEmptySource: false
  writeDelayMs: 1000
  credentialsFile: "credentials.json"
  tokenFile: "token.json"
  stateFile: "state.json"
  lockFile: "sync.lock"
```

Important settings:

- `source.icsUrl`: the Microsoft calendar feed.
- `source.timezone`: timezone used for recurring-event identity and display.
- `destinations`: one or more Google Calendar IDs.
- `lookaheadDays`: how far into the future to mirror events.
- `onlyBusy`: omit free or transparent source events when `true`.
- `copyDescription` and `copyLocation`: control copied fields.
- `writeDelayMs`: pause before Google writes to reduce quota pressure.
- `deleteRemovedEvents`: remove managed Google events no longer present in the source.
- `allowEmptySource`: explicitly allow an empty source to remove all managed events; keep this `false` unless an empty calendar is expected.
- `stateFile`: records the last successful live run.
- `lockFile`: prevents overlapping live runs.

Paths are resolved relative to the configuration file. Keep credentials, tokens, state, and lock files outside version control.

## Dry run

The dry run fetches and parses the live ICS feed, reads managed events from Google, calculates creates/updates/deletes, and performs no Google writes:

```sh
npm run sync -- --config config.yaml --dry-run
```

Example output:

```text
sync complete: {"created":0,"updated":0,"deleted":0,"unchanged":200,"eventCount":200,"dryRun":true}
```

Use this before the first live run and after configuration changes. Repeating a dry run produces the same plan because it intentionally does not apply changes.

## Live synchronization

Run one synchronization manually:

```sh
npm run sync -- --config config.yaml
```

After a successful live run, a repeated run should normally report all events as unchanged. The service:

- Manages only Google events carrying its private metadata.
- Uses source UID and occurrence identity to match recurring events.
- Does not copy attendees or send invitations.
- Stops before reconciliation if the ICS download or parse fails.
- Uses pacing and exponential backoff for temporary Google API errors.
- Removes managed Google events no longer present in the source feed when `deleteRemovedEvents` is enabled.
- Refuses to reconcile an empty source by default, preventing accidental mass deletion after a bad feed response.

Do not run multiple live instances against the same destination calendar. The lock file prevents overlapping instances from this installation.

## Tests and local fixture

Run unit and end-to-end tests:

```sh
npm test
npm run build
```

The end-to-end test uses the committed, anonymized `test/fixtures/calendar.ics`. Keep real calendar exports and meeting links out of the repository.

## Running on Linux with systemd

Install the project in a dedicated directory, for example `/opt/calendar-bridge`, and use a restricted service account:

```sh
sudo useradd --system --home /opt/calendar-bridge --shell /usr/sbin/nologin calendar-bridge
sudo mkdir -p /opt/calendar-bridge
sudo chown -R calendar-bridge:calendar-bridge /opt/calendar-bridge
```

Copy the project there, install dependencies, create `config.yaml`, and place `credentials.json` and `token.json` in the configured locations. Test manually as the service user first:

```sh
sudo -u calendar-bridge npm test
sudo -u calendar-bridge npm run sync -- --config config.yaml --dry-run
```

Create `/etc/systemd/system/calendar-bridge.service`:

```ini
[Unit]
Description=Calendar Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=calendar-bridge
Group=calendar-bridge
WorkingDirectory=/opt/calendar-bridge
ExecStart=/usr/bin/npm run sync -- --config /opt/calendar-bridge/config.yaml
```

Create `/etc/systemd/system/calendar-bridge.timer`:

```ini
[Unit]
Description=Run Calendar Bridge periodically

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and inspect it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now calendar-bridge.timer
systemctl list-timers calendar-bridge.timer
journalctl -u calendar-bridge.service
```

For an initial observation period, schedule the same service with `--dry-run`. Once the dry-run plan is understood and stable, remove `--dry-run` for live operation.

## Security and operations

- Restrict permissions on `credentials.json`, `token.json`, `config.yaml`, and `state.json`.
- Do not commit credentials, access tokens, private ICS data, or destination IDs that should remain private.
- Use a dedicated Google Calendar for the mirror when practical.
- Keep the source calendar authoritative; this service is intentionally one-way.
- If a lock remains after a crash, first verify that no sync process is active before removing it.
