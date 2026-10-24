# Windows preview acceptance

10/10/2026. Converoom 0.2.0 is the Windows V1.1 preview. It is not full V1/V1.1 certification. The public [requirement matrix](REQUIREMENT_MATRIX.md) preserves all 80 requirements and the remaining gates. The full implementation specification is local-only.

## Agent and installation expansion evidence

The expansion adds Antigravity, Kiro, Qoder and Grok Build to MCP registration, diagnostics, tool schemas, UI selection and participant-owned connections. All eight products support MCP participation; six have managed native routes. The four new managed profiles use official ACP entry points and native authentication. Coding sessions implement separately approved, bounded workspace file and terminal callbacks; discussion keeps those capabilities disabled. The Windows bundle adds pinned Node, the compiled production closure, missing Git/Tailscale installation, supported native npm clients, launchers and guided MCP/browser onboarding. See [agent setup](AGENT_SUPPORT.md) and [Windows installation](WINDOWS_INSTALL.md).

On Windows x64 and Node 24.21.0, all 275 natural tests in 35 files passed with one local worker in 287.86 seconds. Typecheck, lint and compiled CLI/UI builds pass. Default two-worker local reruns hit Windows fixture startup/cleanup timing and file locks; the affected 31 authority/workspace cases also passed together. CI retains its normal configuration. Protocol fixtures cover native argv, scoped MCP injection, public-session filtering, Kiro consent metadata, one-time permission allow/deny, protocol mismatch, auth/quota failures, cancellation, coding callbacks, allocated terminal resources, junction denial, UTF-8 byte limits and descendant termination. Installer regressions cover prerequisite reuse/failure, locked data, digest/path validation, legitimate dependency filenames and literal Windows argv. The actual PowerShell 5.1 entry point is exercised without an agent selection. Eight polling identities pass local and remote stdio behaviour; participant-local acceptance and execution approval remain separate.

All four desktop/360 px browser flows passed in 1.6 minutes at the agent expansion checkpoint, including all eight product options and Kiro/Grok managed selection, with axe and overflow checks. Screenshots were inspected. The browser tests and changed UI/runtime/server files still match that checkpoint's source hashes. OneDrive discovery used a byte-identical local test copy and the repository fixture server. The current 37-file package dry-run includes the agent/installer guides and scripts and excludes private paths. The release manifest covers 28 assets. Exact source CI and the extracted-bundle smoke run separately; local fixture results do not establish remote or live vendor acceptance.

Antigravity's normal CLI is available on this machine, but its separate official ACP server and the Kiro/Qoder/Grok native executables were not found. Actual vendor MCP loading, account entitlement, coding, permission/cancel/recovery/quota behaviour and the existing two-Windows pilot remain pending. No vendor credential inspection or inference ran for this expansion.

## Published V1.1 local evidence

The 0.2.0 implementation passes 191 natural Vitest tests in 33 files under Node 24.21.0 on Windows x64. The latest source-status check on 10/10/2026 passed in 106.04 seconds. Publication preparation reran type checking, lint, compiled CLI/UI builds and all four desktop/mobile browser flows successfully. One independent read-only review found five actionable issues. Red/green regressions cover managed consent/requester withdrawal, exact remote sender/budget binding, public read receipts, interrupted OAuth setup and identity recovery. A shutdown regression exposed an intermediate cancellation-state error; that was fixed before the complete natural gate passed.

P0 through P5 are locally implemented: membership, confirmation, per-owner consent, private PKCE transport, participant-local approval, bounded public projections, immutable reviewed artefacts, resources/prompts and shared UI. P6 has the local package evidence below; its external acceptance remains pending. TLS fixtures use an intentionally public test certificate/key with trust limited to the fixture client. Production TLS verification remains enabled. No installed Tailscale, firewall, public endpoint or system certificate trust change was performed.

All four final desktop/360 px browser flows pass, including independent invite/confirm, real fixture OAuth, local grant denial with zero inference, artefact review, automatic removal and same-identity recovery. Axe, keyboard/focus and overflow checks pass; screenshots were inspected. This is automated fixture evidence, not a manual accessibility audit.

Local packed Windows checks pass setup, preserved configuration, credential rotation, compiled MCP, private backup creation, stopped partial repair, bootstrap-cache loss, stable-path restart, 0.1.0 to 0.2.0 upgrade and downgrade with history retained, incomplete shared setup rejection, dedicated loopback UI/private-route isolation, unchanged live runtime on configuration mismatch, owned disconnect and read-only history restore. All 19 stable assets match their manifest. Offline npx setup also passes. These use the same Windows machine, not fresh users or a registry release. The original proxy-fixture failure is retained: Node fetch ignored a manually supplied Host header; raw HTTP accurately models the proxy boundary and passes.

The documentation refresh rebuilds and repacks 0.2.0. Its 18 runtime/skill assets and seven recorded runtime source hashes still match the earlier lifecycle-tested installation. The updated overlay README is the remaining manifest asset. The new 32-file package passes version, asset, shrinkwrap, native provenance and private-content checks; publication preparation does not count as a new fresh-user or full lifecycle run.

The final-source reference fixture on a Ryzen 9 6900HX, 15,629 MiB RAM, Windows x64 and Node 24.21.0 measures command p95 7.984 ms (100), state p95 176.187 ms (100), SSE p95 765.099 ms (20) and separate-daemon peak 247.488 MiB with 200 rooms, 100,000 events, 10,000 completed turns, 10,000 expired grants and ten ungranted requests. No inference ran. These are daemon fixture measurements; saturation remains open.

On 14/10/2026 the compiled daemon ran the SPEC reference pilot load with one headless Chrome 154 page on the same machine. The load was five seats in the live room, two claimed polling turns and 10,000 stored room events across 41 rooms, with no inference. Six fresh-daemon runs gave 144 samples of each kind, with random gaps of 0.3 to 1.5 seconds:

- Command acknowledgement, from the Post click to the command response: p95 21.2 ms. An agent's local command: p95 16.9 ms.
- The owner's own post visible: p95 91.2 ms.
- An agent's post visible in the page: p95 767.6 ms. Two samples in one run took 2.0 and 6.7 seconds; they did not recur in 72 instrumented samples, where event stream delivery was p95 683 ms and state reloads p95 55 to 70 ms. The local event stream's 750 ms poll accounts for most of this latency.
- Idle memory after 30 seconds: the daemon's working set was 94 to 149 MiB. The UI added 120 to 200 MiB over the same browser on about:blank, mostly in its renderer, although the page's JavaScript heap was about 6 MiB. The combined working set was 269 to 313 MiB (median 284), above the 300 MiB target in one run of six; the combined private working set was 170 to 228 MiB.
- No workers or services ran. The daemon's only descendant was the console host Windows attaches to a start without a terminal. The data directory held 10.6 MiB, and the daemon was serving 1.5 to 1.8 seconds after launch.

Later the same day the local event stream began sending each event as soon as the transaction that stored it commits, instead of checking every 750 ms. By then Chrome had updated to 155 and OneDrive was syncing on about two cores, so the previous build was measured again under the same conditions (three runs, 72 samples of each kind) to separate the change from the environment:

- An agent's post visible in the page: p95 43.2 ms (maximum 61.2 ms) over six runs and 144 samples, against 754.4 ms for the previous build. Event stream delivery fell from p95 723.5 ms to 8.8 ms.
- The owner's own post visible (p95 50.3 ms against 49.1 ms) and command acknowledgement (18.0 ms against 17.1 ms) did not change. Both builds reloaded state at p95 25 to 33 ms, against 55 to 70 ms in the first measurement, so the faster own-post figure comes from the environment, not the event stream.
- Idle memory did not change: the combined working set was 261 to 304 MiB (median 265) with the change and 269 to 298 MiB without it, again above 300 MiB in one run of six.

On 24 and 25/10/2026 idle memory was broken down per process and allocator under Chrome 156, driving the browser over its DevTools protocol without the network agent that Playwright enables. That agent kept every state response in the page, which inflated the earlier UI figures. The local browser then began loading one room's state at a time, instead of every room's records and the newest 1,000 events from all rooms. Three fresh-daemon runs of that build gave:

- Reference load, idle after 30 seconds: combined working set 227 to 246 MiB (median 233), combined private working set 145 to 162 MiB. The daemon used 88 to 90 MiB, against 94 to 149 MiB before; the UI added 139 to 156 MiB over the same browser on about:blank.
- A larger history built through room commands (9,990 events in 48 rooms, with 1,269 turns, 634 approvals and 1,269 directed questions): combined working set 227 to 255 MiB, against 164 to 303 MiB before the change. Each state reload fell from 2.5 MB to 34 KB, the owner's own post appeared within 54.5 ms at the 95th percentile instead of 251 ms, and an agent's within 44.7 ms instead of 320 ms.
- Reference-load latency, measured while the machine had about 1 GiB of memory free and OneDrive was syncing: command acknowledgement p95 36 ms, own post visible p95 99 ms, agent post visible p95 86 ms (maximum 218 ms).

The combined idle memory target (NFR-05) is accepted for the Windows preview on this reference machine. A 1 MiB young-generation cap for the daemon was also measured and not adopted: it saved about 6 MiB and lengthened the daemon's latency tail.

Headed browsers and other hardware are unmeasured.

The package version is 0.2.0. The real two-Windows pilot awaits the private hostname and explicit activation. Actual vendor permission/cancel/quota behaviour, three fresh-user timings, manual screen-reader/WCAG 2.2 and capacity evidence remain open. The combined idle memory target is accepted on the Windows reference machine. Verify Windows CI against the exact published commit in the [workflow runs](https://github.com/zuychin03/converoom/actions/workflows/windows-preview.yml); earlier green runs do not validate 0.2.0. macOS/Linux are unverified and excluded from preview claims. See the [Windows pilot guide](WINDOWS_SHARED_PILOT.md).

## Historical hardening checkpoints, 09/10/2026

These entries describe earlier source checkpoints. Their test counts, publication and installation limits are historical; the current implementation and acceptance boundaries are recorded above.

The later V1.1 safety prerequisites pass 97 tests in 22 files, both desktop/mobile browser flows with axe (33.8 seconds), typecheck, lint, CLI/UI build and 19 release asset digests. They retain queued work through pause, resolve native-tool permission lifetimes, add explicit own-seat polling claim/completion, make read-only history restore atomic, preserve redacted export digests and bound/index recurring event reads. Shared network access remains disabled. These prerequisite changes are local and uncommitted.

The canonical-path assertion correction was published as [49e3c4e](https://github.com/zuychin03/converoom/commit/49e3c4ea44465461de9ded987f9756181aeeb985). Its exact [Windows CI run](https://github.com/zuychin03/converoom/actions/runs/37833386261) passed all checks, including browser tests and package dry-run. That run does not validate the later V1.1 implementation.

On Windows x64 with a Ryzen 9 6900HX, 15,629 MiB RAM and Node 24.21.0, a disposable fixture with 200 rooms, 100,000 retained events, 10,000 completed turns and ten ungranted managed requests measured command p95 8.208 ms (100 samples), state p95 160.135 ms (100), SSE delivery p95 763.072 ms (20) and separate-daemon peak 238.109 MiB. No inference ran. Rendered UI latency, combined idle browser memory, saturation and real-client acceptance remain open.

The local hardening changes pass 76 natural fixture tests in 17 files, typecheck, lint and the compiled CLI/UI builds under Node 24.21.0. All 19 regenerated release asset digests match. Regressions cover mixed-case content ordering, clean CRLF apply with dirty-target protection, public environment templates, provisioning/approval/submission lifetimes, retained-work release and dispatch/submission races.

The installation token cannot issue human commands or retrieve pairing codes. Codes are printed in the original runtime terminal; interactive CLI human actions pair into an in-memory session. These transport checks do not establish isolation from unrestricted native processes running as the same OS user.

Managed Codex and Cursor sessions receive scoped Converoom MCP configuration. Real HTTP/stdio bridges pass with protocol stand-ins, including cross-room denial, generation/lease fencing, revocation and teardown. An authorised polling host can orchestrate a managed coding seat while the owner retains execution authority. Actual vendor tool loading remains unverified. No real provider inference or package installation was rerun for these changes; the published hardening baseline passed the Windows CI run linked above.

Both desktop and 360 px mobile browser lifecycle cases pass, including retained-reservation inspection/release, visible rework and automated axe checks. Screenshot inspection and an overflow assertion found and verified a fix for long paths in the mobile dialog. OneDrive reparse files prevented normal Playwright discovery on this checkout; the checks used an unchanged local test copy with the same configuration and repository-root fixture server. Manual screen-reader/WCAG 2.2 and live coding dispatch remain open.

## Historical preview evidence, 08/10/2026

- Node 24.21.0 on Windows x64 builds the compiled CLI and React UI. SQLite 3.53.4 meets the minimum version guard.
- The preview suite passed 41 tests in 14 files. It covers durable/idempotent events, human/agent separation, directed receipts, consent and exact grants, revoked senders, shutdown during initialisation, restart uncertainty, content tampering, dependency diamonds and replacement, observer restrictions, generated-output preservation, dirty cleanup, scoped fixtures, exports/backups and process-tree shutdown. Typecheck, lint and the compiled build passed at that baseline.
- Desktop and 360 px mobile browser fixtures complete pairing, room creation, agent addition, consent, turn request/approval, pause/resume and close. axe checks run on pairing, conversation, approvals, task view and room controls. This is automated accessibility evidence, not a complete manual screen-reader or WCAG 2.2 audit.
- Real subscription-backed Codex and Cursor each completed a bounded native smoke turn. In a mixed-product coding fixture, both changed separate clone files, each exact submission passed fresh independent checks, and the combined candidate passed and applied to the disposable target. No native permission prompt was emitted in that coding run; it does not establish native permission/cancellation acceptance.
- Windows Job Object fixtures verify literal argv, owned descendant termination, and termination when the runtime parent dies. They do not establish filesystem/network containment.
- Dependency audit found no known advisories. The lockfile and release manifest record dependency versions, native/source digests and licence notices. Some upstream packages provide only licence metadata and readme links; those are labelled for further review.
- The common stdio MCP corpus passes with four fixture bridge identities. This proves Converoom's contract, not installation or behaviour in all four actual vendor clients.
- The packed payload installed 159 production packages with no repository build, pnpm or native compiler step. Its isolated lifecycle passed setup, preservation of unrelated config, reconnect credential revocation, MCP room creation, JSON/Markdown export, complete bootstrap dependency-folder removal, stable-path restart with the same room, read-only history restore and owned-registration uninstall. Windows ACL inspection showed only the current user, SYSTEM and Administrators. An npm 11.8 lockfile-driven re-install reproduced an upstream SQLite compile bug, so the documented preview installation uses `--ignore-scripts` with the bundled prebuilt binaries. This is a same-machine isolated install, not fresh-machine or fresh-user certification.
- Independent review findings were reproduced and fixed. Its bounded follow-up found no remaining important issues in those fixes. Public-source and package scans found no personal instruction files, internal development plans, room data or credential-shaped production content. Functional product skills are included.

## Open V1 gates and preview limits

Actual Claude Code and OpenCode MCP acceptance remains unverified. As directed on 09/10/2026, Windows x64 is the only current verification/release target. ARM64 macOS and Linux acceptance are deferred until hardware is available, and their support is not advertised. The current CLI refuses unsupported preview platforms. Full managed permission, cooperative cancellation, provider/session recovery and quota exhaustion still require Windows live evidence.

The Windows bundle provides one-run prerequisite installation and guided local onboarding, with native login remaining in the vendor clients. A fully interactive account/setup wizard and three fresh-user onboarding timings remain open. Installer fixtures, local npm/npx, upgrade/downgrade and partial-install results are recorded separately from fresh-machine acceptance. npm registry publication has not been requested.

Capacity admission and disk/memory/CPU pressure remain open. The reference-load acknowledgement and update latency targets were met on the Windows reference machine. The combined resident-memory target is accepted on the Windows reference machine; headed browsers and other hardware are unmeasured. Source executable-mode behaviour on Windows, path-transition races, read-only private-backup restoration and adversarial resource-exhaustion acceptance need broader tests. Authority audit records now have fixture coverage for every permission, consent, policy, host, membership, connection and credential change, including pairing; release acceptance of that audit remains open.

Quarantined or uncertain work is retained for inspection. Automatic resource recycling and complete rework/reassignment recovery are not yet accepted. Private shared human memberships are implemented behind explicit setup; real multi-machine acceptance is pending. Hosted services, cloud connectors, distributed coding workers and interactive previews remain deferred.

## Reproduce local checks

With Node 24, Git and the packed Windows supervisor present:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run release:manifest
npm run bundle:windows
npm run bundle:smoke
npm pack
```

Live model checks are separate from CI. CI uses fixtures and makes no subscription inference calls. Local green checks do not establish remote CI success.
