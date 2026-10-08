# Windows preview acceptance

09/10/2026. Converoom 0.1.0 is a Windows x64 preview. It is not full V1 certification. The public [requirement matrix](REQUIREMENT_MATRIX.md) preserves all 80 requirements and the remaining gates. The full implementation specification is local-only.

## Current local hardening evidence, 09/10/2026

The local hardening changes pass 76 natural fixture tests in 17 files, typecheck, lint and the compiled CLI/UI builds under Node 24.21.0. All 19 regenerated release asset digests match. Regressions cover mixed-case content ordering, clean CRLF apply with dirty-target protection, public environment templates, provisioning/approval/submission lifetimes, retained-work release and dispatch/submission races.

The installation token cannot issue human commands or retrieve pairing codes. Codes are printed in the original runtime terminal; interactive CLI human actions pair into an in-memory session. These transport checks do not establish isolation from unrestricted native processes running as the same OS user.

Managed Codex and Cursor sessions receive scoped Converoom MCP configuration. Real HTTP/stdio bridges pass with protocol stand-ins, including cross-room denial, generation/lease fencing, revocation and teardown. An authorised polling host can orchestrate a managed coding seat while the owner retains execution authority. Actual vendor tool loading remains unverified. No real provider inference, package installation or remote CI was rerun for these changes.

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

Actual Claude Code and OpenCode MCP acceptance, ARM64 macOS and other Node/OS combinations remain unverified. The current CLI refuses unsupported preview platforms. Full managed permission, cooperative cancellation, provider/session recovery and quota exhaustion require additional live evidence.

Setup is an explicit guided command sequence, with native login remaining in the vendor client. A fully interactive setup wizard, three fresh-user onboarding timings, both npm bootstrap paths, version upgrade/downgrade and partial-install matrices remain open. npm registry publication has not been requested.

Capacity admission, disk/memory/CPU pressure, reference-load acknowledgement/update latency and combined resident-memory targets remain open. Source executable-mode behaviour on Windows, path-transition races, read-only private-backup restoration, complete authority audit coverage and adversarial resource-exhaustion acceptance need broader tests.

Quarantined or uncertain work is retained for inspection. Automatic resource recycling and complete rework/reassignment recovery are not yet accepted. Hosted services, cloud connectors, remote owners, distributed workers and interactive previews are not enabled in this build.

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
