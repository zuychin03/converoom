# Changelog

## Unreleased

Managed turns that time out, lose their native process or are cancelled without the vendor confirming it are now recorded as uncertain rather than failed, because the agent may already have acted. A turn is recorded as failed only when it never started, for example when the vendor refuses the request over quota or sign-in. It is also failed when the vendor reports its own final outcome or the room refuses its answer. Codex cancellation is now confirmed the same way as the ACP products, including a cancel sent while the turn was still starting. Uncertain turns keep their reason in the UI, and a coding worker's reservation can be released once its process stop is confirmed.

Polling claims now have a lifetime. A claimed turn that is not completed within its turn time budget, or a cancellation the agent does not acknowledge within a minute, becomes uncertain and frees its active-turn slot instead of blocking dispatch until restart. Participant daemons report failed local turns, pass host cancellation to the local session and acknowledge it, and end native work early enough to publish within the host's claim budget. The shared listener now rate-limits each authenticated principal separately, so one participant or anonymous traffic cannot exhaust another's budget, and a rate-limited or unreachable poll no longer cancels accepted local work.

Managed turns no longer start once the room's message budget is used up; they are cancelled with a visible reason, as the time budget already was. If the room refuses an answer after a turn has started, the turn fails with that reason and keeps a redacted copy of the answer, up to 1 MiB, in its turn record for the owner to read. The copy is not added to room history or shared with other members.

A participant's local room for managed remote discussion no longer stops accepting proposals 90 minutes after it was enabled. It stays bounded by the connection's turn budget, per-turn time and the approval of each turn, and rooms created by earlier versions are repaired when the daemon restarts.

Read commands no longer store their results under a client key. Exports and shared artefact reads run again each time, so repeating one with the same key returns current, integrity-checked data, and the database no longer grows with every export. Read results stored by earlier versions are removed at startup.

Shared artefacts accept ordinary technical Markdown, such as "metadata:", generic types like `Map<string, number>`, autolinks, comments and inert formatting tags. Script-capable elements, event and style attributes, and script or data links (including entity-encoded ones) are still refused. The check now runs in linear time; the previous pattern could stall the daemon for minutes on a crafted 1 MiB upload.

Remote turn proposals now carry the shared room's title, objective and latest public conversation, and the local managed prompt no longer substitutes the local proxy room's objective. Participant connections no longer read room history on every poll, halving their steady request load. The browser apps follow an update that arrives during a refresh with one more refresh instead of waiting up to 12 seconds. The local listener rate-limits each agent credential and browser session separately, so one busy agent cannot exhaust the others' allowance.

Stored command results now expire. Repeating a command with the same client key returns the stored result for at least a week; after that it runs again. Expiry runs at startup and hourly in batches of 1,000 results, so a large backlog never stalls the daemon. Results stored by earlier versions expire a week after upgrade. The database format is unchanged, so earlier versions can still open it. Token exchange and renewal on the shared listener are now rate-limited per credential holder, so anonymous traffic cannot block them. A participant whose renewal is rate-limited keeps its credential and retries instead of needing to reconnect.

Workspace commands such as repository registration, task claims and submissions keep their recorded outcomes for the same week. A failed workspace command no longer blocks its client key permanently; after a week the key runs again. A command interrupted mid-run still blocks its key until the work is inspected. Owners can now list interrupted commands with `converoom interrupted`, including when each started and which repository, task or attempt it named. After checking the work, `converoom interrupted-clear ID` lets the key run again. A command still running in the daemon cannot be cleared, and clearing one that belongs to a room is recorded in that room. The Work view lists them under Interrupted commands, with an Inspect and clear action.

Added a Windows installation bundle with a checksum-pinned Node runtime, compiled app, production dependencies, SQLite/supervisor prebuilds and licence notices. One installer installs missing Git and Tailscale plus selected supported native clients, creates durable launchers and starts guided local MCP/skill registration. Account sign-in and shared HTTPS activation remain explicit. CI builds and smoke-tests the extracted bundle before making it available as an artefact.

Added Antigravity, Kiro, Qoder and Grok Build across MCP registration, room schemas, product selection, diagnostics and participant-local connections. Added managed ACP profiles using official native entry points and native authentication, with scoped room tools, one-time approvals and cancellation. Grok API-only authentication is rejected; Antigravity requires Google's separate ACP server. Live acceptance for the new vendors remains pending.

Managed ACP coding supports approved file read/write and literal-argv terminals in the assigned workspace. Client operations check canonical paths, bind writes to content digests, bound file/output size and stop owned terminals on completion or cancellation. Discussion sessions keep these capabilities disabled.

Fixed ACP replies accepting other sessions' public messages. ACP adapters now check the negotiated protocol version, retain Kiro consent metadata, bound public output and reject overlapping prompts. Native processes also clear the new vendors' API-key environment variables. Added agent setup documentation and protocol/configuration regressions.

## 0.2.0 (Windows V1.1 preview, 10/10/2026)

Updated architecture, setup and progress documentation for the implemented P0 through P5 workflow, P6 package evidence and remaining acceptance gates. Documented the separate shared listener, participant-owned execution approval, recovery and actual environment/CLI configuration.

Added confirmed human memberships, independent owner consent, a separate opt-in private HTTPS/MCP listener, PKCE participant connections and participant-local execution approval. Added scoped shared browser state, streams, structured MCP results, resources/prompts, immutable reviewed text artefacts and bounded public Markdown exports. Members, Connections and Artefacts support invitation, denial, revocation, identity recovery and reconnect at desktop and mobile widths.

Managed turns recheck requester membership and exact consent before startup, during execution and before publishing. Participant admission binds the accepted sender and budget. Shared message reads update public receipts. Interrupted OAuth setup becomes visibly uncertain; expired browser sessions recover through a bound owner-issued code. Partial installation repair preserves an active runtime's payload.

Local Windows fixtures and package checks provide preview evidence only. The real two-Windows/Tailscale pilot, actual vendor permission/cancel/quota observations, fresh users, manual accessibility and exact new remote CI remain pending. No registry publication or deployment occurred.

Queued turns and approvals survive pause/resume. Vendor approvals resolve at their callback deadline, and polling agents can explicitly claim and complete their own turns. Restore validates and imports history atomically; redacted exports retain valid digests. Indexed history queries and bounded event streams reduce recurring scans. Windows canonical-path assertions account for short-path aliases. V1.1 private shared-room work follows the approved design; verification and release scope remain Windows x64 only.

Fixed mixed-case workspace digests, supported CRLF apply, public environment templates and approval/submission lifetimes. Added safe retained-reservation release, per-turn scoped managed MCP tools and polling-host coding orchestration. Removed installation-token access to human commands and pairing codes. Updated public requirement links and fixed mobile dialog path wrapping. Live vendor/platform acceptance remains open.

## 0.1.0 (V1 preview, 08/10/2026)

Initial local room runtime, native Codex/Cursor adapters, shared MCP tools, browser approvals, durable events/outbox states, independent coding clones, immutable submissions, fresh verification and combined candidates. Windows process supervisor and local fixture broker. Release acceptance remains in progress.
