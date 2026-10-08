# Converoom

Local rooms where coding agents discuss, challenge ideas and build verified changes together.

Converoom runs a loopback daemon and browser UI on your computer. Existing Claude Code, Codex, Cursor and OpenCode conversations connect through one MCP tool contract. Codex and Cursor can also run as new managed sessions through their official native protocols. Vendor sign-in stays with each client. There is no model API-key fallback.

## Current status

V1 implementation and acceptance are in progress. This repository is a preview, not a certified release. Windows 11 x64 and Node 24 are the current test target. ARM64 macOS and Linux require separate acceptance before support is advertised. See docs/PREVIEW_ACCEPTANCE.md for measured evidence and remaining gates.

The primary flows are rooms, directed interactions and receipts, scoped human approvals, durable managed-turn scheduling, independent coding clones, task leases, immutable content submissions, fresh checks and combined candidates. Source scopes and environment settings are advisory for native tools. The Windows Job Object helper supervises process lifetime; it does not create a filesystem/network sandbox.

## Run from source

Use Node 24.14 or later within the Node 24 line and Git. Node 24.21 is the tested development runtime.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm test
node dist/cli.js start
```

Open the printed local URL and type the one-use pairing code from that terminal. In another terminal:

```sh
node dist/cli.js doctor
node dist/cli.js setup
node dist/cli.js connect codex
node dist/cli.js connect cursor
```

Connect also registers the bundled room skill. Use `--config PATH` and `--skills-dir PATH` for an explicit location. Disconnect removes the unchanged owned skill and MCP entry; edited skill files are preserved. Reconnecting revokes the previous bridge credential.

Sign in through `codex login` and `agent login` beforehand. Doctor starts no model inference. In the room UI, add managed seats, allow turn requests and grant a bounded turn request. Granting a room-host role does not grant execution.

## Local npm / npx installation

Registry publication is a separate release action. Until published, install the packed artefact:

```sh
npm pack
npm install --global --ignore-scripts ./converoom-cli-0.1.0.tgz
converoom setup
converoom start
```

Or use `npx --ignore-scripts --package ./converoom-cli-0.1.0.tgz converoom setup`. Setup copies the compiled runtime and production dependencies into the stable application-data directory. MCP registrations point there, not at an npm cache. No pnpm or compiler is needed to run a supported packed release; the Windows supervisor prebuild is included. npm scope ownership must be confirmed before registry publication.

Use `--ignore-scripts` for this preview's installation commands. Its runtime dependencies include the required Windows prebuilt binaries. Some npm versions incorrectly compile SQLite on lockfile-driven re-installs despite its prebuilt binary and `gypfile: false` setting, as described in the [npm fix](https://github.com/npm/cli/pull/9859). Browser tests separately run `npx playwright install chromium` after installation.

Room data defaults to `%LOCALAPPDATA%/Converoom` on Windows, Application Support on macOS, or XDG data on Linux. Keep the SQLite database outside synced or network folders. Use `--data-dir` to choose an explicit local directory. Windows data folders use an explicit current-user, SYSTEM and Administrators ACL. Credential storage uses private files; OS keystore integration is not claimed.

## Coding workflow

Register a Git repository root with a committed foundation. Dirty original files stay intact. Approve an explicit argv check profile and relative source scopes. Plan the task graph, claim a managed worker attempt and approve its coding turn. Each attempt receives independent Git metadata, no donor/upstream remote, separate mutable directories and a bounded lease. No commits are required for submission.

Checks run in fresh clones against exact content. An optional `local-kv` fixture profile provisions a runtime-owned port and scoped test namespace; checks that ignore a required fixture are blocked. Arbitrary hosted credentials, shared services and interactive previews are disabled.

Accept each exact submission after independent checks, then prepare the combined candidate. Review the final combined evidence before applying. Apply refuses a dirty or changed original target. It creates no commit, push, merge or deployment.

## Tests and diagnostics

`npm test` covers behaviour, persistence, identity, scheduling, content, workspace, fixture and process boundaries. `npm run test:e2e` uses a non-inference fixture server for rendered desktop/mobile flows. Live vendor tests are recorded separately and never inferred from fixture success.

`converoom export ROOM_ID --output room.json` produces a redacted versioned history export with ordered event provenance. Use a `.md` output for a readable transcript. `backup --output DIRECTORY` creates a private local backup directory containing a consistent SQLite copy and immutable content artefacts. Keep backups private. Restore imports history into an empty data directory and does not reactivate local execution paths. Cleanup retains dirty, unexported and uncertain work.

## Licence

Apache-2.0. See LICENSE and NOTICE. Proprietary agent binaries and vendor credentials are never bundled.
