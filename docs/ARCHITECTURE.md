# Converoom architecture

Converoom 0.2.0 is a Windows V1.1 preview with one authoritative writer per room. A Node 24 daemon stores rooms, events, interactions, permissions, tasks and evidence in SQLite. A React browser interface connects over authenticated loopback JSON and SSE. The compiled CLI starts the daemon, pairs a browser, registers MCP clients and manages local exports and installation. Private shared discussion uses a separate opt-in listener and participant-owned local bridges.

## Agent participation

Existing client conversations use a common MCP stdio bridge. Each bridge has a separate principal and polls ordered room events and its inbox. Structured questions create durable obligations; text names do not trigger execution. The room host organises turns, agenda and decisions. The human owner supplies execution authority.

Managed seats start new native sessions. Codex uses its official app-server protocol; Cursor uses Agent Client Protocol (ACP). ACP carries session creation, prompts, public updates, permissions and cancellation. It does not allocate Git workspaces, provide room identity or prevent file conflicts. Claude Code and OpenCode use manual MCP polling; their managed adapters remain deferred. Shared multi-owner discussion is implemented behind explicit setup, with real two-machine acceptance pending. Cloud connectors and distributed coding remain deferred.

The scheduler persists a dispatch boundary before external work. It admits at most two managed turns and one active turn per seat, rechecks consent and the exact grant, and records visible failure or uncertainty. An interrupted dispatch is never automatically replayed. A host's authority does not replace the owner's scoped grant. Quota and authentication failures do not switch providers or enable an API billing fallback.

## Private shared discussion

The host keeps the local control server separate from a dedicated shared loopback listener. Explicit Tailscale Serve setup supplies the configured private HTTPS origin. Shared HTTP/MCP routes enforce exact Host/Origin, authentication, membership generation and policy version. They cannot invoke local coding, repository, shell/profile, backup or complete owner-state routes. Tailscale, firewall and system certificate trust activation remain owner actions outside the local fixture checks.

One-use invitations create pending human memberships; the inviter confirms the displayed identity before room access becomes active. Each participant owns their agent seats, allowed requesters and turn/time budgets. Membership revocation advances generation, withdraws old seats, invalidates credentials and closes affected streams while retaining history. Browser identity recovery uses a bound owner-issued invitation and fresh confirmation, followed by agent reconnection and new consent.

The participant's local daemon establishes an audience-bound PKCE OAuth connection through the pinned MCP SDK. Existing conversations retain the stdio bridge. Codex/Cursor can separately enable bounded local managed discussion. Each incoming proposal requires exact local acceptance and an independent execution grant; the host cannot grant native execution on another machine. Requester, consent and budget are rechecked through admission and publication. Ambiguous claims, publication and refresh remain uncertain without automatic consequential replay. An interrupted OAuth setup must be prepared again.

Shared browser state, event pages, SSE, resources/prompts and exports reuse one authorised public projection, bounded to 512 KiB with explicit omission metadata. Only human-reviewed immutable UTF-8 text/Markdown artefacts are published, with exact digest and provenance, at most 1 MiB each, 10 MiB and 100 artefacts per room. Content is fetched separately and never executed. Shared Markdown exports are cursor-based public history pages containing JSON blocks; a readable transcript remains an open requirement.

## Coding and evidence

The owner registers a committed Git foundation and approves a profile containing literal command/argument arrays, source scopes and generated paths. Tasks form a dependency graph. Every attempt receives an independent clone, Git metadata, temp/build/log/test-data paths and a fenced lease. Worker clones have no donor remote and no shared hardlinks. The allocator rejects overlapping reserved scopes across local rooms.

Source submissions identify bytes, modes, additions and deletions. Manifests bind the foundation, ordered prerequisites, effective base, delta and resulting content. No worker commit is required. Dependency content composes once, including diamond graphs; changed prerequisites invalidate dependent work.

Verification uses a fresh clone and approved resource profile. Before/after source digests detect unexpected check mutations. An optional local-kv fixture has its own runtime-bound port, credential and namespace; declared fixtures must be exercised by the checks. Final integration composes accepted submissions in order and runs fresh combined checks. A separate human review and apply action bind the final candidate. Dirty targets are refused, generated paths are preserved, and apply failures retain rollback content. No commit, merge, push or deployment is implicit.

## Process and security boundaries

The Windows helper creates a Job Object, starts the native process suspended, assigns it before resuming and tracks the daemon parent through an OS process handle. Closing the job or losing the parent terminates owned descendants. This supervises lifetime. Native agent tools and check commands remain trusted local execution; source scopes and environment settings are advisory, with no filesystem or network containment promise.

Human browser cookies and CSRF tokens are distinct from agent bridge credentials. The installation token cannot issue human commands or read pairing codes. Rotation prints a short-lived, single-use code in the original runtime terminal; interactive CLI human commands exchange it for an in-memory session. Managed MCP credentials are limited to the assigned room, seat and active turn, with attempt generation and lease checks, and are revoked on teardown. Host/Origin/CSRF and role checks protect human actions. Windows application-data folders have explicit private ACLs. These transport checks do not isolate unrestricted native processes running as the same OS user. Public events contain designated answers and redacted tool data, rather than private reasoning. Interactive previews and hosted credential profiles are disabled.

## Installation and compatibility

The npm payload contains the compiled CLI, browser assets, product skill, supervisor binary/source and dependency notices. Explicit setup copies the runtime and production dependencies to a versioned application-data path. Client registrations point to that durable path. Repeated registration reuses an unchanged installed runtime and rotates its bridge credential. npm bootstrap cache removal does not delete rooms or the stable runtime.

P0 through P5 are locally implemented. P6 package fixtures cover setup, 0.1.0/0.2.0 upgrade and downgrade, stopped partial repair, credential rotation, bootstrap-cache loss, owned disconnect and read-only history restore on one Windows machine. Private backup creation is implemented; full private-backup restore and dedicated upgrade/recover/uninstall commands remain open.

The preview is limited to Windows x64 and Node 24. The real two-Windows/Tailscale pilot, actual Claude Code/OpenCode participation, current managed vendor tool loading, permission/cancellation/recovery/quota combinations, fresh-machine/user onboarding, manual accessibility and broader capacity/exhaustion checks retain open acceptance gates. Native execution remains trusted local, including processes running as the same OS user. See [preview evidence](PREVIEW_ACCEPTANCE.md), [all requirements](REQUIREMENT_MATRIX.md) and the [Windows pilot guide](WINDOWS_SHARED_PILOT.md).
