# Core Retail ERP

A single-tenant desktop ERP for retail shops. Point-of-sale, inventory ledger, purchase management, customers and suppliers, daily reports, and local backups, all packaged as a single self-contained installer per operating system.

Built on Electron + React + TypeScript with SQLite (via Prisma) for storage. The application runs entirely on the local machine. No cloud, no server, no internet required.

## What this is

Core Retail ERP is intended for a single shop running on a single computer (the cashier's workstation). Everything the app needs ships inside the installer:

- The Electron runtime (Chromium + Node)
- The compiled application code
- The Prisma client and migration files
- The SQLite engine (`better-sqlite3` native binary, rebuilt per OS)
- A pre-migrated, seeded `shop.db.template`

You install it, you launch it, you create the first Admin account on the first-run screen, and you start ringing up sales. There is no separate database server to set up.

## Quickstart

1. Download the installer for your operating system from the release artifacts (`release/` directory of a packaged build).
2. Run the installer. Follow the per-OS steps in the next section if your OS shows an "unverified publisher" warning.
3. Launch the application.
4. The first launch shows a brief migration progress screen, then routes to the **Initial Admin Setup** screen.
5. Enter a username, password, and confirm the password to create your first Admin account.
6. Log in with the Admin account you just created. You are now on the home screen, with POS reachable in one click.

That is the entire setup. The database, the SQLite engine, and the Prisma migrations are all handled automatically behind the scenes.

## Per-OS install instructions

V1 builds are unsigned. Code signing is deferred, so each OS will show a one-time warning that you have to override. Once you have approved the app the first time, subsequent launches do not prompt.

### Windows (`.exe`, NSIS)

1. Download `Core Retail ERP-<version>-win-x64.exe`.
2. Double-click the installer.
3. **SmartScreen warning:** Windows may show "Windows protected your PC" with an "unrecognized app" message because the build is unsigned. Click **More info**, then click **Run anyway**.
4. The NSIS wizard opens. Choose an install directory (the default under `Program Files` is fine), then click **Install**.
5. When the wizard finishes, launch the app from the Start menu or the desktop shortcut.

### macOS (`.dmg`)

1. Download `Core Retail ERP-<version>-mac-x64.dmg` (Intel) or `Core Retail ERP-<version>-mac-arm64.dmg` (Apple Silicon).
2. Double-click the `.dmg` to mount it.
3. Drag **Core Retail ERP** into the **Applications** folder.
4. **Gatekeeper warning:** macOS will block the first launch with a message that the app cannot be opened because it is from an unidentified developer. To override:
   - Open **System Settings** → **Privacy & Security**.
   - Scroll to the **Security** section. You will see "Core Retail ERP was blocked from use because it is not from an identified developer."
   - Click **Open Anyway**.
   - Confirm with your administrator password.
5. Subsequent launches open without prompting.

### Linux (`.AppImage`)

1. Download `Core Retail ERP-<version>-linux-x64.AppImage`.
2. Make it executable:
   ```bash
   chmod +x "Core Retail ERP-<version>-linux-x64.AppImage"
   ```
3. Run it:
   ```bash
   ./"Core Retail ERP-<version>-linux-x64.AppImage"
   ```

AppImage runs without elevated privileges and without a package manager. If your desktop environment supports it, you can integrate the AppImage into the application menu via tools like `appimaged` or by right-clicking and choosing "Run".

## First-run flow

On the very first launch:

1. The app creates `<userData>/shop.db` by copying the seeded template that ships inside the installer. You are not asked for a database location, port, or credentials.
2. A migration progress screen runs `prisma migrate deploy`. This is fast on a fresh install because the template already has the schema applied; the screen exists so future upgrades that add migrations have a place to report progress. Feature modules are gated behind this screen until migrations finish.
3. Because no users exist yet, the app routes to the **Initial Admin Setup** screen. You create the first Admin account here.
4. After creating the Admin, you are sent to the login screen. Log in with the credentials you just set.

On every subsequent launch the app skips the template copy, runs `prisma migrate deploy` (idempotent — already-applied migrations are no-ops), runs `PRAGMA integrity_check` against the database, and routes straight to login.

## Where data lives

All persistent data lives under the OS-standard per-user data directory (`app.getPath('userData')`). Nothing is written to `Program Files`, `/Applications`, or system directories.

| OS      | `<userData>` resolves to                                |
| ------- | ------------------------------------------------------- |
| Windows | `%APPDATA%\Core Retail ERP\`                            |
| macOS   | `~/Library/Application Support/Core Retail ERP/`        |
| Linux   | `~/.config/Core Retail ERP/`                            |

Inside `<userData>`:

- `<userData>/shop.db` — the SQLite database. Open in WAL mode, so you may also see `shop.db-wal` and `shop.db-shm` alongside it. Do not delete those; they are part of the same database.
- `<userData>/backups/` — daily and manual snapshots, named `shop-YYYY-MM-DD.db`. Retention is 14 most-recent files by default.
- `<userData>/receipts/` — PDF receipts written by the print chain when both ESC/POS and HTML printing fail. Named `INV-XXXXXX.pdf` to match the sale serial.
- `<userData>/logs/` — application logs from the main process.

If you ever uninstall the app, `<userData>` is preserved by default. Reinstalling on top of an existing `<userData>` keeps your data intact.

## Backups

Backups use SQLite's `VACUUM INTO` command, which produces a fully consistent copy of the database while writers are still open. Snapshots live in `<userData>/backups/` as `shop-YYYY-MM-DD.db`.

### Automatic backups

- A snapshot is taken on every launch if no snapshot exists for today.
- A daily snapshot is taken at the configured time while the app is running.
- After every snapshot the retention policy keeps the 14 most recent files and deletes older ones. The retention count is configurable (see `Setting` `backup.retentionDays`).

### Manual backup

- Open **Settings → Backup**.
- Click **Backup now**. A new `shop-YYYY-MM-DD.db` snapshot is written to `<userData>/backups/`.

### Restore from a backup

- Open **Settings → Backup**.
- Click **Restore from snapshot**.
- Pick a `.db` file from `<userData>/backups/` (or any path).
- Confirm. The app copies the snapshot over `shop.db`, reopens the database, replays any journal entries newer than the snapshot, then reloads the UI. The current database is preserved as a safety copy before the swap.

You can also keep your own off-machine copies by simply copying the snapshot files out of `<userData>/backups/` to external storage. They are standalone SQLite databases.

## Printer configuration

The app prints receipts through a three-stage chain:

1. **ESC/POS** to a thermal printer (USB, serial, or network) — the primary path.
2. **HTML** via Electron's `webContents.print()` — fallback when ESC/POS is unavailable.
3. **PDF** to `<userData>/receipts/INV-XXXXXX.pdf` — last-resort fallback if both above fail.

To configure the printer:

1. Open **Settings → Printer** (Admin only).
2. Choose the connection kind: **USB**, **Serial**, or **Network**.
3. Enter the target:
   - USB: the device path or printer name (e.g. `/dev/usb/lp0` on Linux, the printer name on Windows).
   - Serial: the serial port (e.g. `COM3` on Windows, `/dev/ttyUSB0` on Linux).
   - Network: `host:port` (e.g. `192.168.1.50:9100`).
4. Click **Test print** to verify. A short test receipt is sent through the chain.
5. Save.

Printing happens after the sale is committed to the database. A jammed or offline printer never causes lost sales — the chain falls through to HTML or PDF and the sale stays committed.

## Troubleshooting

### Printer is offline or test print fails

- Verify the printer is powered on and the cable or network connection is live.
- Confirm the connection kind and target match exactly. For network printers, ping `host` first to confirm reachability.
- The receipt for the most recent sale is still in `<userData>/receipts/INV-XXXXXX.pdf` if the chain fell through to PDF — open it and reprint manually if needed.
- Check `<userData>/logs/` for the printer adapter error message.
- For USB printers on Linux, confirm your user has read/write permission on the device path (e.g. `lp` group membership).

### "integrity_check failure" prompt on launch

This happens when SQLite's `PRAGMA integrity_check` reports corruption on startup. The app refuses to open the main window until the database is healthy. You will see a recovery prompt with two choices:

- **Restore from latest snapshot** — the app finds the most recent `shop-YYYY-MM-DD.db` in `<userData>/backups/`, copies it over `shop.db`, replays journal entries newer than the snapshot, and continues. This is the recommended choice.
- **Cancel** — the app exits without making changes. Use this if you want to inspect `shop.db` manually before letting the app touch it.

If recovery from the latest snapshot also fails, try an older snapshot from `<userData>/backups/` by manually copying it over `<userData>/shop.db` while the app is closed, then relaunching.

### Migration failure on launch

If `prisma migrate deploy` fails on the migration progress screen, the app shows the migration name and the error and offers the same recovery flow as the integrity failure path. The most common cause is a corrupted database; restoring from the latest snapshot resolves it.

### "Initial Admin Setup" screen appears again unexpectedly

The setup screen only appears when no Admin user exists in `users`. If it reappears after you have already created one, your `shop.db` was likely replaced or wiped. Restore from a snapshot in `<userData>/backups/` before creating a new Admin to avoid losing the rest of your data.

## Runtime non-prerequisites

The application is fully self-contained. The only operating-system-level prerequisite is the supported desktop OS itself. Specifically, the target machine does **not** need any of the following:

- **No Node.js installation.** The Electron runtime is bundled inside the installer.
- **No Prisma CLI.** The Prisma client and migration engine ship inside the app; migrations run via the bundled `prisma migrate deploy` invocation, not a system-installed CLI.
- **No SQLite CLI or DB Browser.** The SQLite engine is the `better-sqlite3` native binary bundled in the app's resources. There is no `sqlite3` executable involved.
- **No ODBC drivers.** Nothing connects through ODBC.
- **No system services.** No background daemon, no Windows service, no `launchd` agent, no `systemd` unit. The app is a normal desktop application.
- **No internet connection.** Every V1 module operates fully offline. There are no outbound network calls for license checks, telemetry, updates, or feature gates.

If your machine has a supported desktop OS and enough disk space for the installer plus the database, that is enough.

## For developers

The instructions above are for end users. The instructions below are for working on the source.

### Prerequisites for development

- Node.js 20 LTS (see `.nvmrc`)
- npm 10+
- Build tools for native modules on your OS (Visual Studio Build Tools on Windows, Xcode Command Line Tools on macOS, `build-essential` on Linux)

### Clone and install

```bash
git clone <repo-url> core-retail-erp
cd core-retail-erp
npm install
```

`npm install` runs `electron-builder`'s rebuild step against `better-sqlite3` and the Prisma engines for your local OS and Electron version.

### Develop

```bash
npm run dev
```

Starts the renderer dev server, builds main and preload, and launches Electron with hot reload.

### Database tasks

```bash
npm run prisma:generate   # regenerate Prisma client
npm run prisma:format     # format prisma/schema.prisma
npm run prisma:seed       # seed roles + default settings into a fresh DB
npm run db:template       # rebuild resources/shop.db.template (used by the installer)
```

### Build

```bash
npm run typecheck   # type-check main, preload, renderer projects
npm run lint        # ESLint
npm run build       # produce dist/main, dist/preload, dist/renderer
```

### Package installers

```bash
npm run dist          # all targets configured for the current host OS
npm run dist:win      # Windows NSIS .exe
npm run dist:mac      # macOS DMG (x64 + arm64)
npm run dist:linux    # Linux AppImage
```

Output lands in `release/`. Because `better-sqlite3` is a native module, each installer must be produced on its target OS so the bundled binary matches the runtime ABI.

### Test

```bash
npm test                  # all tiers (unit + integration + property + e2e)
npm run test:unit         # Vitest unit
npm run test:integration  # Vitest integration (real SQLite via Prisma)
npm run test:property     # Vitest + fast-check property suite
npm run test:e2e          # Playwright against the packaged Electron app
```

The full pre-release pipeline is:

```bash
npm run build:full        # typecheck + lint + unit + build + dist
```

## Architecture and design

The full design and requirements specifications live under `.kiro/specs/core-retail-erp/`:

- `requirements.md` — V1 acceptance criteria.
- `design.md` — architecture, transaction boundaries, schema, error envelope, RBAC matrix, pagination, backup and recovery flows, formal correctness properties.
- `tasks.md` — implementation plan, phase by phase.

The four architectural decisions everything else hangs from:

1. **Single-writer main process.** The renderer never touches SQLite directly; every cross-process call goes through a typed IPC contract with auth, RBAC, and audit middleware.
2. **One transaction per business operation.** Sales and purchases each commit as one Prisma `$transaction` covering the parent row, line items, payments, inventory movements, and journal entry.
3. **Ledger-of-record for inventory.** `inventory_movements` is the source of truth; `inventory.on_hand` is a cache that must equal the sum of deltas at every commit boundary.
4. **Append-only journals.** `journal_entries` and `audit_logs` are written but never updated or deleted. Recovery is "restore latest snapshot, replay journal forward."

## License

TBD.
