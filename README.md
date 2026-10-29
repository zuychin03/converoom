# Converoom

Local rooms where coding agents discuss, challenge ideas and build verified changes together.

Converoom runs a loopback daemon and browser UI on your computer. Existing Claude Code, Codex, Cursor, OpenCode, Antigravity, Kiro, Qoder and Grok Build conversations connect through one MCP tool contract. Codex, Cursor and the four new products have managed native adapters. Vendor sign-in stays with each client. There is no model API-key fallback.

## Current status

The 0.2.0 Windows V1.1 preview adds private shared discussion and review. Safety prerequisites, membership, private transport, participant-local consent, scoped artefacts and the complete browser workflow are locally implemented (P0 through P5). P6 has local package evidence; the real two-Windows pilot, live-client acceptance, fresh-user onboarding and manual accessibility remain pending. This is a preview, not full V1/V1.1 acceptance.

Shared access is disabled by default and requires explicit private HTTPS setup. Windows 11 x64 and Node 24 are the only verification and release target. macOS and Linux support is deferred until those platforms can be tested. See the [architecture](docs/ARCHITECTURE.md), [preview evidence](docs/PREVIEW_ACCEPTANCE.md), [requirement matrix](docs/REQUIREMENT_MATRIX.md) and [Windows pilot guide](docs/WINDOWS_SHARED_PILOT.md).

The new agent adapters have local protocol fixture coverage. Live vendor acceptance is pending. See [agent setup and capabilities](docs/AGENT_SUPPORT.md) for each native launch, config path and authentication requirement. Antigravity needs Google's separate official ACP server; its normal `agy` CLI is sufficient for MCP participation.

The primary flows are rooms, directed interactions and receipts, scoped human approvals, durable managed-turn scheduling, independent coding clones, task leases, immutable content submissions, fresh checks and combined candidates. When a room's message, turn or time budget is used up, it stops taking new turns and records a handoff of what is still open. Each room has a lifecycle (draft, active, pausing, paused, then completed, cancelled or archived) and, separately, a phase from deliberation through owner review to execution, verification and handoff. Only you approve a proposed decision or send it back, and approving it grants no execution. An agent can wake a managed agent by asking it a question, one turn at a time, and you still grant each of those turns. You can also approve a round-robin speaking plan once, and the room runs it within its budgets. Source scopes and environment settings are advisory for native tools. The Windows Job Object helper supervises process lifetime; it does not create a filesystem/network sandbox.

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
node dist/cli.js connect antigravity
node dist/cli.js connect kiro
node dist/cli.js connect qoder
node dist/cli.js connect grok
```

`converoom doctor --discover` checks which agents are installed and ready, and `converoom onboard --auto` connects every installed agent that is not yet connected; the Work page offers the same. See [agent support](docs/AGENT_SUPPORT.md). The Work page also lists room templates: built-in ones and any you save from a room, each filling its roles from the agents found ready. Each managed seat can be given its own model and effort, which the agent must offer before a turn is sent. Connect also registers the bundled room skill. Use `--config PATH` and `--skills-dir PATH` for an explicit location. Disconnect removes the unchanged owned skill and MCP entry; edited skill files are preserved. Reconnecting revokes the previous bridge credential.

Sign in through your native vendor client beforehand. Doctor starts no model inference and distinguishes the normal CLI from the managed executable. It also reports whether each product's Converoom registration points at this data directory, whether its saved bridge credential is still active and whether auto-start is on. `converoom connect PRODUCT --auto-start` lets that product's agents start Converoom in its own window when it is not running; see [agent support](docs/AGENT_SUPPORT.md). In the room UI, add managed seats, allow turn requests and grant a bounded turn request. Granting a room-host role does not grant execution.

## Local npm / npx installation

For a fresh Windows machine, use the [one-run Windows bundle](docs/WINDOWS_INSTALL.md). It includes the pinned Node runtime and production dependencies. The installer installs missing Git, Tailscale and the selected supported native agents, creates launchers, registers MCP/skills and opens the local room UI. Account sign-in remains in Tailscale and the vendor clients. Shared HTTPS activation is explicit.

Registry publication is a separate release action. Until published, install the packed artefact:

```sh
npm pack
npm install --global --ignore-scripts ./converoom-cli-0.2.0.tgz
converoom setup
converoom start
```

Or use `npx --ignore-scripts --package ./converoom-cli-0.2.0.tgz converoom setup`. Setup copies the compiled runtime and production dependencies into the stable application-data directory. MCP registrations point there, not at an npm cache. No pnpm or compiler is needed to run a supported packed release; the Windows supervisor prebuild is included. npm scope ownership must be confirmed before registry publication.

### Upgrade, recover and uninstall

Stop the runtime before any of these. Converoom records which installed version is active, and a different package never changes it on its own: `start`, `setup`, `connect` and `onboard` stop and say which version is installed. Run the newer package's `converoom upgrade`. It backs up the room store and artefacts under `backups`, installs the new runtime, points every connected product at it without issuing new credentials and refreshes room skills you have not edited. The previous version stays installed. Downgrades are refused.

`converoom recover` finishes an interrupted upgrade, clears the files a crashed runtime left, repairs the active runtime's files and points stale registrations back at it. `converoom recover --rollback` returns to the version used before the last upgrade. If that upgrade changed the room store's format, rollback also needs `--confirm`: it restores the pre-upgrade backup and keeps the newer store aside.

`converoom uninstall` lists what it would remove and changes nothing. `converoom uninstall --confirm` revokes Converoom's bridge credentials and removes its MCP entries, unedited room skills, runtime files, launchers and PATH entry. Room data, backups, the bundle's Node and agent CLIs, and your other settings stay. To delete room data too, add `--delete-data` followed by the data folder's path; this is refused while retained coding work remains. Remove an npm installation afterwards with `npm uninstall --global @converoom/cli`.

Use `--ignore-scripts` for this preview's installation commands. Its runtime dependencies include the required Windows prebuilt binaries. Some npm versions incorrectly compile SQLite on lockfile-driven re-installs despite its prebuilt binary and `gypfile: false` setting, as described in the [npm fix](https://github.com/npm/cli/pull/9859). Browser tests separately run `npx playwright install chromium` after installation.

Room data defaults to `%LOCALAPPDATA%/Converoom` on Windows. Keep the SQLite database outside synced or network folders. Use `--data-dir` or set `CONVEROOM_DATA_DIR` before starting to choose an explicit local directory; the CLI does not load `.env` files. Set the local listener port with `--port`, using `0` for automatic allocation. Windows data folders use an explicit current-user, SYSTEM and Administrators ACL. Saved agent bridge credentials and shared-room connection tokens are kept in Windows Credential Manager, and their files in the data folder hold only a reference, so copies, backups and synced files of the data folder contain no credentials. Programs running as you can still read Credential Manager, so this does not separate Converoom from them. If Credential Manager is unavailable in the session, or `CONVEROOM_CREDENTIAL_STORE=file` is set, credentials stay in the private files and `converoom start` and `converoom doctor` say so. Existing files move into Credential Manager the next time the runtime starts. The runtime's control token stays in `runtime.json`; it is created at each start and stops working when the runtime stops.

## Private shared discussion

Use the Windows pilot guide for explicit Tailscale Serve setup on the dedicated shared listener. Share an expiring one-use invitation, then confirm the participant's displayed identity. Membership grants public room access. Each owner chooses allowed requesters and budgets for their own agents.

Participants connect their local Converoom bridge through PKCE OAuth. All eight products can use polling; the six managed products can separately enable bounded local managed discussion. Every incoming managed proposal requires exact local acceptance and a separate execution grant. The room host cannot approve another machine's native work. Ambiguous delivery is retained for inspection without automatic consequential retries.

Members, Connections and Artefacts expose these steps. Shared content is plain text or Markdown with explicit digest review and immutable provenance, bounded to 1 MiB per artefact and 10 MiB per room. Shared exports are readable transcript pages of the public history, with a cursor for the next page. Remote coding, shell/profile execution, repository access and private backups remain on each owner's local control server.

After browser session expiry, ask the host for a recovery code bound to your existing member. Recovery preserves your identity and history, invalidates old credentials and agent registrations, and requires fresh confirmation and consent. A pending OAuth page becomes uncertain after daemon restart; disconnect that setup and prepare a fresh connection.

## Coding workflow

Register a Git repository root with a committed foundation. Dirty original files stay intact. Approve an explicit argv check profile and relative source scopes. Plan the task graph, claim a managed worker attempt and approve its coding turn. Each attempt receives independent Git metadata, no donor/upstream remote, separate mutable directories and a bounded lease. No commits are required for submission.

Checks run in fresh clones against exact content. An optional `local-kv` fixture profile provisions a runtime-owned port and scoped test namespace; checks that ignore a required fixture are blocked. Arbitrary hosted credentials, shared services and interactive previews are disabled.

Accept each exact submission after independent checks, then prepare the combined candidate. Review the final combined evidence before applying. Apply refuses a dirty or changed original target. It creates no commit, push, merge or deployment.

Every attempt, combined candidate and check keeps its clone until you clean it up. `converoom cleanup`, or Workspace cleanup in the Work view, previews every clone with its size and either that it can be removed or why it is kept. A clone can be removed once its work is submitted or recorded and the room has been exported since; a released attempt also needs 7 days to pass and no unsubmitted changes. Dirty, unexported and uncertain work is always kept. `converoom cleanup --confirm CODE` removes only what that preview listed, and nothing if anything changed since.

## Tests and diagnostics

`npm test` covers behaviour, persistence, identity, scheduling, content, workspace, fixture, agent protocols and Windows installation boundaries. See the [preview evidence](docs/PREVIEW_ACCEPTANCE.md) for recorded counts and limitations. `npm run test:e2e` runs four non-inference desktop/mobile flows for solo rooms and shared consent, review, denial, revocation and recovery. Live vendor tests are recorded separately and never inferred from fixture success. Windows CI checks the exact source commit; local checks and earlier CI runs do not validate a later revision.

`converoom export ROOM_ID --output room.json` produces a redacted versioned history export with ordered event provenance. A `.md` output is a readable transcript of the same history: every numbered event in order, with names, approvals and digests, and the JSON export's digest for matching the two. Message, agenda and decision text appears in fenced blocks, so recorded text cannot pass for transcript structure. Only the JSON export can be restored. `backup --output DIRECTORY` creates a private local backup directory containing a consistent SQLite copy and immutable content artefacts. Export, backup and cleanup require an interactive terminal: enter the one-use code printed in the terminal running `converoom start`. `converoom pair` also prints its new code in that original terminal. The installation token in `runtime.json` cannot issue human commands or retrieve codes. Keep backups private. Restore imports history into an empty data directory and does not reactivate local execution paths. Cleanup retains dirty, unexported and uncertain work.

## Licence

Apache-2.0. See LICENSE and NOTICE. Proprietary agent binaries and vendor credentials are never bundled.
