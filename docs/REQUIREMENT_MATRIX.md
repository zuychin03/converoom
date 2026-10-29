# Requirement acceptance matrix

25/10/2026. All 97 requirements are retained (including V1.2 FR-55–58, FR-61–66, NFR-19, V1.3 FR-59–60, NFR-20 and V1.4 FR-40, FR-67–68, IF-09). Automated fixtures, available live vendor checks and package tests provide bounded evidence, not blanket acceptance. The full V1 gates stay open for the Windows preview. Update this matrix requirement by requirement when each full acceptance condition has evidence. The complete implementation specification is local-only.

Current release scope is Windows x64 only, as directed on 09/10/2026. macOS/Linux requirements are retained for future verification, but do not block the Windows-only preview. V1.1 private shared discussion is locally implemented in the 0.2.0 preview. Membership/owner isolation, PKCE, participant-local approvals, scoped state/streams, reviewed artefacts and recovery have fixture evidence. The real two-Windows pilot and applicable V1 gates remain open; implementation does not imply full acceptance.

The agent expansion adds Antigravity, Kiro, Qoder and Grok Build to FR-01/05/11/28/29/30/32/33. All eight MCP identities and the six managed wire profiles have local fixture coverage. This retains the existing roster/authority limits and does not close those requirements' vendor acceptance gates. See [agent support](AGENT_SUPPORT.md) for the implemented routes and pending live checks.

| ID | Release gate | Contract |
|---|---|---|
| FR-01 | Open V1 acceptance | Each target coding product shall create and participate in a room through the same core MCP schemas. |
| FR-02 | Open V1 acceptance | Room creation shall return an inspectable room app reference and roster. |
| FR-03 | Open V1 acceptance | The originating session shall remain distinct from any managed replacement or handoff. |
| FR-04 | Open V1 acceptance | A room shall have an objective, human owner, host seat, workflow, bounded roster and immutable policy version history. |
| FR-05 | Open V1 acceptance | Seats shall advertise declared, probed and tested capabilities separately. |
| FR-06 | Open V1 acceptance | Caller identity shall come from its authenticated connection. |
| FR-07 | Open V1 acceptance | Mutations shall have payload-bound idempotency keys and ordered room events. |
| FR-08 | Open V1 acceptance | Directed questions shall create durable interactions using stable recipient IDs. |
| FR-09 | Open V1 acceptance | Publication, delivery, read, response and resolution shall be separately recorded. |
| FR-10 | Open V1 acceptance; round-robin and bounded-peer policies locally implemented with fixture tests | Turn dispatch shall enforce host policy, target-owner consent, budgets and one active prompt per seat. |
| FR-11 | Open V1 acceptance | At least one mixed-product managed workflow shall be supported through tested adapters. |
| FR-12 | Open V1 acceptance | Polling seats shall retain pending work and receive bounded read/wait tools. |
| FR-13 | Open V1 acceptance | The host shall see unresolved obligations and propose a decision preserving dissent and evidence. |
| FR-14 | Open V1 acceptance | Execution and consequential actions shall require a human grant independent of agent text. |
| FR-15 | Open V1 acceptance; room states locally implemented with fixture tests | Pause, cancellation, worker stop and room close shall have distinct states. |
| FR-16 | Locally implemented with fixture tests; release acceptance open | Budget exhaustion shall stop new dispatch and produce a handoff. |
| FR-17 | Open V1 acceptance | The store and outbox shall survive runtime restart. |
| FR-18 | Open V1 acceptance | Uncertain execution shall require inspection before consequential replay. |
| FR-19 | Open V1 acceptance | Repository registration shall be human-controlled and preserve the original checkout. |
| FR-20 | Open V1 acceptance | Task plans shall have scope, acceptance criteria, prerequisites and approved execution/check profiles. |
| FR-21 | Open V1 acceptance | Task ownership shall use bounded leases and attempt-specific workspaces. |
| FR-22 | Open V1 acceptance | Coding submissions shall be immutable and content-addressed without requiring commits. |
| FR-23 | Open V1 acceptance | Dependency content shall determine the effective task base. |
| FR-24 | Open V1 acceptance | Required checks shall run independently against the exact submission/base/profile in a recorded environment. |
| FR-25 | Open V1 acceptance | Implementers shall not accept their own implementation. |
| FR-26 | Open V1 acceptance | Integration preparation shall preserve ordered accepted submissions and protected references. |
| FR-27 | Open V1 acceptance | Owners shall inspect diffs, evidence and unresolved risks before applying a candidate. |
| FR-28 | Open V1 acceptance | Adapter permissions and prompts shall have bounded, visible resolution. |
| FR-29 | Open V1 acceptance | Setup/doctor shall detect missing agents, subscription authentication, incompatible versions and disconnected MCP. |
| FR-30 | Open V1 acceptance | Plugin overlays shall preserve unrelated configuration and room semantics. |
| FR-31 | Open V1 acceptance | Export, backup and cleanup shall preserve inspectable work. |
| FR-32 | Open V1 acceptance | Tool activity shall be redacted and private reasoning shall not be broadcast. |
| FR-33 | Open V1 acceptance | Model and provider failures shall be distinct from disagreement or completion. |
| FR-34 | Future phase | Private rooms shall support several authenticated human owners and expiring invitations. |
| FR-35 | Future phase | Each owner shall independently authorise triggers and budget for their agent. |
| FR-36 | Future phase | Remote discussion membership shall confer no local execution access. |
| FR-37 | Future phase | Membership revocation shall invalidate access and queued work. |
| FR-38 | Future phase | Remote workers shall validate repository/base/dependency identity and local grants before execution. |
| FR-39 | Future phase | Remote artefact import shall validate provenance, paths, size and exact bytes before checks. |
| FR-40 | Future phase (V1.4) | Tested native push bridges shall wake an identified existing session when it receives a directed interaction. |
| FR-41 | Open V1 acceptance | Coding-worker admission shall bind a runtime-managed session to its registered workspace, content base, profile and attempt generation. |
| FR-42 | Open V1 acceptance | The allocator shall atomically reserve a ready task and its full logical resource bundle across local rooms, then provision and validate before dispatch. |
| FR-43 | Open V1 acceptance | Each attempt shall receive approved isolated mutable execution resources and a redacted environment manifest. |
| FR-44 | Open V1 acceptance | Service-dependent checks shall validate allocated endpoint ownership and readiness. |
| FR-45 | Open V1 acceptance | Test data and credentials shall be provisioned from approved local profiles with minimum required scope. |
| FR-46 | Open V1 acceptance | Expired or uncertain resources shall remain quarantined until owned-process stop, credential revocation and cleanup are confirmed. |
| FR-47 | Open V1 acceptance | Final candidate checks shall use a fresh workspace/resource bundle with evidence bound to exact content, profile and environment manifest. |
| FR-48 | Conditional, previews disabled | Preview services shall have owned lifetimes, bounded retention and tested separation from human approval credentials. |
| FR-49 | Open V1 acceptance | Every execution profile shall distinguish verified configuration from enforced containment. |
| FR-50 | Open V1 acceptance | A public open-source release shall support local npm and npx installation from versioned compiled packages. |
| FR-51 | Windows bundle locally implemented; fresh-user acceptance open | Guided setup shall detect prerequisites, select subscription profiles, register vendor tools/skills and verify a first room. |
| FR-52 | Open V1 acceptance | Runtime, plugin assets and persistent room data shall survive npm/npx bootstrap cache loss and version changes. |
| FR-53 | Open V1 acceptance | Managed V1 profiles shall use supported native subscription access, leaving vendor sign-in/credentials with their owning client. |
| FR-54 | Open V1 acceptance | Quota/auth failures shall preserve work, respect shared account allowance and avoid implicit billing/provider changes. |
| FR-55 | Future phase (V1.2) | Coding attempts shall record immutable per-turn workspace checkpoints and support rollback to a prior checkpoint within the active attempt. |
| FR-56 | Locally implemented with fixture tests; live vendor and release acceptance open | Room creation and seat configuration shall support reusable workflow templates and adapter-verified model/reasoning-effort profiles. |
| FR-57 | Future phase (V1.2) | Submission reviews shall support file and line-scoped diff annotations bound to exact content digests and rework turns. |
| FR-58 | Future phase (V1.2) | Owners shall be able to export a verified integration candidate to a new local Git branch with a redacted Markdown PR brief. |
| FR-59 | Future phase (V1.3) | An opt-in authenticated private HTTPS owner listener shall allow mobile monitoring, diff/checkpoint inspection and scoped human approvals. |
| FR-60 | Future phase (V1.3) | Owner-remote mobile sessions shall remain strictly isolated from `/shared` participant routes and local-only machine setup. |
| FR-61 | Future phase (V1.2) | When a seat exhausts quota, loses authentication or disconnects mid-session, the runtime shall support structured takeover of its open interactions, host role or in-progress coding attempt by another eligible seat. |
| FR-62 | Locally implemented with fixture tests; live vendor and release acceptance open | The runtime and CLI shall automatically discover installed agent harnesses, probe non-inference readiness and support one-action or automatic MCP/skill connection. |
| FR-63 | Future phase (V1.2) | Owners shall be able to import bounded conversation/session context from connected agent harnesses, and authorised seats to request such imports, referenced via `@context` mentions. |
| FR-64 | Future phase (V1.2) | Rooms shall support scoped sub-threads and layered context flow with pinned invariants and rolling compaction. |
| FR-65 | Future phase (V1.2) | Human owners shall be able to barge in mid-session to steer queued turns, deliver urgent directives on Converoom tool results or cooperatively interrupt-and-amend an active managed turn. |
| FR-66 | Locally implemented with fixture tests and a local smoke; release acceptance open | When the owner opts a connected product into auto-start, that product's MCP bridge shall start the local runtime on demand without exposing the pairing code to the agent. |
| FR-67 | Future phase (V1.4) | Supporting MCP clients shall be able to render an embedded room panel through the MCP Apps extension. |
| FR-68 | Future phase (V1.4) | Remote A2A service agents shall be able to join rooms as discussion and review seats. |
| NFR-01 | Measured within target on the Windows reference machine; release acceptance open | Local command acknowledgement p95 ≤500 ms and visible room update p95 ≤1 second under reference load. Measure independent samples and report hardware. |
| NFR-02 | Open V1 acceptance | Pause/revocation prevents new local dispatch within 1 second. Cooperative cancellation is separately timed; after 10 seconds without confirmation show degraded status and offer managed-worker stop. |
| NFR-03 | Open V1 acceptance | Committed acknowledged events survive process-crash fixtures. Backup/restore yields a consistent store; power-loss guarantees remain bounded by SQLite/OS/storage behaviour. |
| NFR-04 | Open V1 acceptance | Runtime restarts and presents recoverable state within 10 seconds under reference load; provider session resume may take longer and is shown separately. |
| NFR-05 | Accepted for the Windows preview on the reference machine (25/10/2026); other platforms deferred | Idle daemon plus one browser UI target ≤300 MiB combined resident memory, excluding agent processes/browser baseline. Measure on Windows for the current release and separately on future platforms before advertising their target. |
| NFR-06 | Open Windows acceptance; other platforms deferred | Windows 11 x64 is the only current release target. macOS and Linux support is deferred until verified. Every advertised managed profile passes Windows acceptance; WSL-specific support requires its own labelled evidence. |
| NFR-07 | Open V1 acceptance | Keyboard and screen-reader access across create/join/room/permissions/tasks/handoff; usable layout at 360 px and desktop width; target WCAG 2.2 AA in relevant flows. |
| NFR-08 | Open V1 acceptance | No credentials in URLs, transcripts, exports or logs. Pairing/rotation, agent-to-human impersonation, Auth/Origin/CSRF/replay fixtures pass. Credential storage is OS-protected or explicitly degraded to user-only files. Windows Credential Manager storage with a reported private-file fallback is locally implemented (F6). |
| NFR-09 | Locally implemented with fixture tests; release acceptance open | Every authority-changing action records human actor, action digest, scope, expiry and policy. Audit history cannot be rewritten through agent tools. |
| NFR-10 | Open V1 acceptance | SDKs/adapters/dependencies are pinned with checksums/lockfile and a dated compatibility matrix. Protocol version negotiation and migration/downgrade tests run before updates. |
| NFR-11 | Open V1 acceptance | Bounded queues, payloads, context packets, retries and worker concurrency hold under exhaustion/adversarial tests. No indefinite permission wait or self-trigger loop. |
| NFR-12 | Open V1 acceptance | npm/npx onboarding target ≤10 minutes with prerequisites installed/authenticated; test at least 3 fresh users, both bootstrap paths and a partial-install recovery. Record time, manual steps, failures and managed/polling outcomes. |
| NFR-13 | Open V1 acceptance | No mandatory hosted database/model service beyond users’ chosen agents. Missing optional UI/relay/push integrations degrade without blocking local room tools. |
| NFR-14 | Local V1.1 fixtures; real pilot open | TLS, principal-scoped access, rate limiting, resource revocation and authenticated reconnect pass remote multi-owner tests. No second authoritative room writer. |
| NFR-15 | Future phase | Remote reconnect deduplicates messages/artefacts and flags uncertain execution; network partitions do not authorise duplicate consequential work. |
| NFR-16 | Open V1 acceptance | Provisioning, readiness, allocation waits and cleanup have finite profile limits and visible timeout outcomes. Proposed defaults: 120-second provisioning/readiness, at most 3 approved port attempts, 5-minute resource wait and 10-minute retained preview. Cleanup timeout quarantines resources rather than treating them as released. Fault fixtures demonstrate no silent indefinite wait. These are targets to validate, not measured results. |
| NFR-17 | Open V1 acceptance | Capacity admission counts agent workers, check/service descendants, retained previews, quarantined resources and disk requirements. Start with one active coding worker on an 8 GB machine; raise limits only after target-hardware benchmarks. Configured count/disk limits block new work with diagnostics; memory/CPU pressure triggers bounded degradation. Reservations do not claim to prevent native-process resource exhaustion. |
| NFR-18 | Open V1 acceptance | Every advertised package/Node/OS/architecture combination passes packed-payload install, start, MCP exchange, bootstrap-cache loss, upgrade and uninstall acceptance. End users need no repository build, pnpm or native compiler. The default Windows bundle installs missing Git/Tailscale and may require Windows administrator approval; local-only installation can skip Tailscale. Unsupported native profiles fail before a ready claim; publication checks bind evidence to the exact package digest. |
| NFR-19 | Future phase (V1.2) | Per-turn attempt checkpoints (within a per-attempt disk budget that never evicts a checkpoint selected for rollback or takeover), imported harness session contexts, sub-threads and diff review annotations have bounded storage, digest deduplication and deterministic cleanup while preserving dirty/uncertain attempts. |
| NFR-20 | Future phase (V1.3) | The opt-in owner-remote listener enforces exact configured HTTPS Host/Origin, rejects public funnel/forwarded spoofing headers, rate-limits pairing and command mutations, and invalidates mobile sessions and SSE streams within 1 second of local revocation. |
| IF-01 | Open V1 acceptance | MCP exposes versioned tool/resource schemas, role checks and bounded payloads. Private remote authentication requires advertised-client acceptance; cloud release requires compatible OAuth and public HTTPS. |
| IF-02 | Open V1 acceptance | ACP negotiates initialise/auth/session/prompt/update/cancel and optional resume/mode support. Unsupported features return explicit capability results. |
| IF-03 | Open V1 acceptance | Native adapter modules provide equivalent prompt/cancel/event contracts with dated vendor API tests. The baseline uses no terminal keystroke injection. |
| IF-04 | Open V1 acceptance | Browser API uses authenticated JSON and resumable SSE with bounded buffering/backpressure. Large artefacts are fetched separately. |
| IF-05 | Open V1 acceptance | Git addresses human-registered repositories and immutable content/SHAs. Agent input cannot define arbitrary executables, commands or protected refs. |
| IF-06 | Locally implemented with fixture tests; release acceptance open | Versioned JSON and readable Markdown exports retain digests and source links. Imports validate version, scope, paths and size before storage. |
| IF-07 | Open V1 acceptance | Human-approved resource profiles bind executable/argv, cwd, per-process settings, credential references, resource requirements, probes and cleanup. Broker manifests are redacted and read-only. Agents select approved IDs, and every advertised profile maps allocations to actual application behaviour. |
| IF-08 | Open V1 acceptance | Versioned public CLI/bin provides guided setup, noninteractive redacted status/doctor and documented exit codes. Static vendor payloads reference a durable exact-version runtime. npx/global npm are equivalent bootstrap paths without vendor-credential changes or agent-configuration lifecycle scripts. |
| IF-09 | Future phase (V1.4) | A2A seats use agent card discovery, declared authentication and task send, get and cancel with streaming where advertised, outbound only; the embedded panel follows the MCP Apps UI resource contract; unsupported features return explicit capability results. |
