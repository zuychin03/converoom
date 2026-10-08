# Converoom architecture

Converoom is a local application with one authoritative writer. A Node 24 daemon stores rooms, events, interactions, permissions, tasks and evidence in SQLite. A React browser interface connects over authenticated loopback JSON and SSE. The compiled CLI starts the daemon, pairs a browser, registers MCP clients and manages local exports and installation.

## Agent participation

Existing client conversations use a common MCP stdio bridge. Each bridge has a separate principal and polls ordered room events and its inbox. Structured questions create durable obligations; text names do not trigger execution. The room host organises turns, agenda and decisions. The human owner supplies execution authority.

Managed seats start new native sessions. Codex uses its official app-server protocol; Cursor uses Agent Client Protocol (ACP). ACP carries session creation, prompts, public updates, permissions and cancellation. It does not allocate Git workspaces, provide room identity or prevent file conflicts. Claude Code and OpenCode currently use MCP polling, with native managed routes awaiting acceptance. Cloud and remote multi-owner participation are outside this preview.

The scheduler persists a dispatch boundary before external work. It admits at most two managed turns and one active turn per seat, rechecks consent and the exact grant, and records visible failure or uncertainty. An interrupted dispatch is never automatically replayed. A host's authority does not replace the owner's scoped grant. Quota and authentication failures do not switch providers or enable an API billing fallback.

## Coding and evidence

The owner registers a committed Git foundation and approves a profile containing literal command/argument arrays, source scopes and generated paths. Tasks form a dependency graph. Every attempt receives an independent clone, Git metadata, temp/build/log/test-data paths and a fenced lease. Worker clones have no donor remote and no shared hardlinks. The allocator rejects overlapping reserved scopes across local rooms.

Source submissions identify bytes, modes, additions and deletions. Manifests bind the foundation, ordered prerequisites, effective base, delta and resulting content. No worker commit is required. Dependency content composes once, including diamond graphs; changed prerequisites invalidate dependent work.

Verification uses a fresh clone and approved resource profile. Before/after source digests detect unexpected check mutations. An optional local-kv fixture has its own runtime-bound port, credential and namespace; declared fixtures must be exercised by the checks. Final integration composes accepted submissions in order and runs fresh combined checks. A separate human review and apply action bind the final candidate. Dirty targets are refused, generated paths are preserved, and apply failures retain rollback content. No commit, merge, push or deployment is implicit.

## Process and security boundaries

The Windows helper creates a Job Object, starts the native process suspended, assigns it before resuming and tracks the daemon parent through an OS process handle. Closing the job or losing the parent terminates owned descendants. This supervises lifetime. Native agent tools and check commands remain trusted local execution; source scopes and environment settings are advisory, with no filesystem or network containment promise.

Human browser cookies and CSRF tokens are distinct from agent bridge credentials. Pairing is bounded and single use. Host/Origin/CSRF and role checks protect human actions. Windows application-data folders have explicit private ACLs. Public events contain designated answers and redacted tool data, rather than private reasoning. Interactive previews and hosted credential profiles are disabled.

## Installation and compatibility

The npm payload contains the compiled CLI, browser assets, product skill, supervisor binary/source and dependency notices. Explicit setup copies the runtime and production dependencies to a versioned application-data path. Client registrations point to that durable path. Repeated registration reuses an unchanged installed runtime and rotates its bridge credential. npm bootstrap cache removal does not delete rooms or the stable runtime.

The preview is limited to Windows x64 and Node 24. Other platforms, all four actual clients, native permission/cancellation/recovery combinations, upgrade matrices, capacity targets and fresh-user onboarding retain open acceptance gates. See [preview evidence](PREVIEW_ACCEPTANCE.md) and [all requirements](SRS.md).
