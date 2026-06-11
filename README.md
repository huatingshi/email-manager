# Mail Collector

Mail Collector is a local two-page Outlook / Microsoft Graph mail receiver.

It is designed for manually checking many mailbox accounts without continuously polling in the background. Each receiver page is independent, and each mailbox keeps only its latest message in local storage.

## Features

- Import account lines in this format:

  ```text
  email | password | refresh_token | client_id
  ```

- Store sensitive fields locally with AES-256-GCM encryption.
- Use Microsoft OAuth refresh tokens to request Microsoft Graph access tokens.
- Manually read latest inbox messages per receiver page or across all pages.
- Two-page "open book" receiver layout.
- Per-page time filters:
  - Last hour
  - Last day
  - Last seven days
  - Forever
- Local read state: opening a message in this tool marks it as read locally.
- Search by subject, sender, mailbox, or preview text.
- Delete imported accounts.

## Important Security Notes

- The `.data/` directory contains encrypted local account data and is intentionally ignored by Git.
- Do not commit raw mailbox files, refresh tokens, passwords, or exported state files.
- Marking a message as read only changes the local tool state. It does not update the real Outlook mailbox read status.

## Start

### Recommended

Double-click:

```text
start.bat
```

The launcher checks Node.js, installs dependencies on first run, starts the API and web app, then opens the browser.

### Command Line

```bash
npm install
npm run dev
```

Frontend:

```text
http://127.0.0.1:5173
```

Backend:

```text
http://127.0.0.1:8787
```

## Optional Desktop Shortcut

Double-click:

```text
create-shortcut.bat
```

This creates a Windows desktop shortcut named `Mail Collector`.

## Configuration

Environment variables:

- `PORT`: API port, default `8787`
- `MAX_MESSAGES`: local maximum stored latest messages, default `100`
- `MESSAGES_PER_ACCOUNT`: messages read per account, default `1`
- `REQUEST_TIMEOUT_MS`: Microsoft API request timeout, default `15000`
- `SYNC_CONCURRENCY`: concurrent account reads, default `8`
- `GRAPH_SCOPE`: Microsoft Graph scope, default `https://graph.microsoft.com/Mail.Read`
