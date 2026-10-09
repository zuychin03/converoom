# Windows preview acceptance

10/10/2026. Converoom 0.2.0 is the Windows V1.1 preview. It is not full V1/V1.1 certification. The public [requirement matrix](REQUIREMENT_MATRIX.md) preserves all 80 requirements and the remaining gates. The full implementation specification is local-only.

## Current V1.1 local evidence

The 0.2.0 implementation passes 191 natural Vitest tests in 33 files under Node 24.21.0 on Windows x64. The latest source-status check on 10/10/2026 passed in 106.04 seconds. Publication preparation reran type checking, lint, compiled CLI/UI builds and all four desktop/mobile browser flows successfully. One independent read-only review found five actionable issues. Red/green regressions cover managed consent/requester withdrawal, exact remote sender/budget binding, public read receipts, interrupted OAuth setup and identity recovery. A shutdown regression exposed an intermediate cancellation-state error; that was fixed before the complete natural gate passed.

P0 through P5 are locally implemented: membership, confirmation, per-owner consent, private PKCE transport, participant-local approval, bounded public projections, immutable reviewed artefacts, resources/prompts and shared UI. P6 has the local package evidence below; its external acceptance remains pending. TLS fixtures use an intentionally public test certificate/key with trust limited to the fixture client. Production TLS verification remains enabled. No installed Tailscale, firewall, public endpoint or system certificate trust change was performed.

All four final desktop/360 px browser flows pass, including independent invite/confirm, real fixture OAuth, local grant denial with zero inference, artefact review, automatic removal and same-identity recovery. Axe, keyboard/focus and overflow checks pass; screenshots were inspected. This is automated fixture evidence, not a manual accessibility audit.

Local packed Windows checks pass setup, preserved configuration, credential rotation, compiled MCP, private backup creation, stopped partial repair, bootstrap-cache loss, stable-path restart, 0.1.0 to 0.2.0 upgrade and downgrade with history retained, incomplete shared setup rejection, dedicated loopback UI/private-route isolation, unchanged live runtime on configuration mismatch, owned disconnect and read-only history restore. All 19 stable assets match their manifest. Offline npx setup also passes. These use the same Windows machine, not fresh users or a registry release. The original proxy-fixture failure is retained: Node fetch ignored a manually supplied Host header; raw HTTP accurately models the proxy boundary and passes.

The documentation refresh rebuilds and repacks 0.2.0. Its 18 runtime/skill assets and seven recorded runtime source hashes still match the earlier lifecycle-tested installation. The updated overlay README is the remaining manifest asset. The new 32-file package passes version, asset, shrinkwrap, native provenance and private-content checks; publication preparation does not count as a new fresh-user or full lifecycle run.

The final-source reference fixture on a Ryzen 9 6900HX, 15,629 MiB RAM, Windows x64 and Node 24.21.0 measures command p95 7.984 ms (100), state p95 176.187 ms (100), SSE p95 765.099 ms (20) and separate-daemon peak 247.488 MiB with 200 rooms, 100,000 events, 10,000 completed turns, 10,000 expired grants and ten ungranted requests. No inference ran. These are daemon fixture measurements; rendered latency, combined idle browser memory and saturation remain open.

The package version is 0.2.0. The real two-Windows pilot awaits the private hostname and explicit activation. Actual vendor permission/cancel/quota behaviour, three fresh-user timings, manual screen-reader/WCAG 2.2 and rendered-latency/combined-memory/capacity evidence remain open. Verify Windows CI against the exact published commit in the [workflow runs](https://github.com/zuychin03/converoom/actions/workflows/windows-preview.yml); earlier green runs do not validate 0.2.0. macOS/Linux are unverified and excluded from preview claims. See the [Windows pilot guide](WINDOWS_SHARED_PILOT.md).

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

Setup is an explicit guided command sequence, with native login remaining in the vendor client. A fully interactive setup wizard and three fresh-user onboarding timings remain open. Local npm/npx, upgrade/downgrade and partial-install fixture results are recorded separately from fresh-machine acceptance. npm registry publication has not been requested.

Capacity admission, disk/memory/CPU pressure, reference-load acknowledgement/update latency and combined resident-memory targets remain open. Source executable-mode behaviour on Windows, path-transition races, read-only private-backup restoration, complete authority audit coverage and adversarial resource-exhaustion acceptance need broader tests.

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
npm pack
```

Live model checks are separate from CI. CI uses fixtures and makes no subscription inference calls. Local green checks do not establish remote CI success.
