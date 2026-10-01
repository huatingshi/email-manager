# Mail Collector

Mail Collector is a local Outlook / Microsoft Graph mail receiver for checking many mailboxes at once.

Each mailbox keeps only its latest inbox message locally. Older mail is fetched from Outlook on demand. Nothing polls Microsoft in the background: mail is read when you click 读取 / 刷新.

## Features

- Three-pane layout: groups (接收器) | one row per mailbox with its latest message | reading pane.
- Import account lines in this format (client_id and refresh_token may be in either order):

  ```text
  email | password | refresh_token | client_id
  ```

- Read all mailboxes, one group, or a single mailbox, with live progress.
- Reading pane with the full message as plain text or in its original HTML styling (sandboxed), a list of the links it contains, and older inbox / junk mail on demand.
- Search by mailbox, sender, subject or preview text; filter by unread, failed, or receive time; sort by newest mail, address, or import order.
- Readable error messages for expired or revoked tokens, plus bulk removal of failed mailboxes.
- Keyboard: `↑` / `↓` (or `j` / `k`) move through the list, `/` or `Ctrl+K` search, `Esc` leaves search.
- Light and dark themes follow the system setting.

## Data and security

- Account data lives in `.data/` (ignored by Git). Sensitive fields are encrypted with AES-256-GCM using `.data/master.key`. The key sits next to the data, so anyone who copies the whole `.data/` folder can decrypt it; keep that folder private.
- `state.json` is written atomically, and each start saves a known-good copy as `state.backup.json`. If `state.json` is ever damaged, the server keeps the damaged file as `state.corrupt-<time>.json` and restores from the backup.
- The API only listens on `127.0.0.1` and rejects requests addressed to other host names.
- Marking a message as read only changes local state; Outlook's own read status is untouched.

## Start

### Recommended

Double-click:

```text
start.bat
```

The launcher checks Node.js (20.19+ or 22.12+), installs dependencies on first run, starts the API and web app, then opens the browser.

### Command Line

```bash
npm install
npm run dev
```

Frontend: `http://127.0.0.1:5173`

Backend: `http://127.0.0.1:8797`

## Optional Desktop Shortcut

Double-click `create-shortcut.bat` to create a Windows desktop shortcut named `Mail Collector`.

## Configuration

Environment variables:

- `PORT`: API port, default `8797`
- `FRONTEND_PORT`: web app port, default `5173`
- `DATA_DIR`: data folder, default `.data` in the project root
- `REQUEST_TIMEOUT_MS`: Microsoft API request timeout, default `15000`
- `SYNC_CONCURRENCY`: mailboxes read in parallel, default `8`
- `GRAPH_SCOPE`: Microsoft Graph scope, default `https://graph.microsoft.com/Mail.Read`
