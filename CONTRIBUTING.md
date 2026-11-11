# Contributing to Converoom

Thanks for helping. Converoom is a Windows preview maintained by one person, so small, focused pull requests get reviewed fastest. For anything large, open an issue first so we can agree on the approach before you build it.

## Before you start

- Windows 11 x64 is the only platform Converoom is built, tested and released for. macOS and Linux support is deferred until those platforms can be tested, so changes for them can't be verified or merged yet.
- Use Node 24.14 or later, and Git. Node 26.13.0 is pinned as a dev dependency, so npm scripts run on it.
- Pull requests target `develop`.
- Converoom stays local. It runs on loopback, never needs a publicly reachable endpoint, never bundles vendor binaries or credentials, and has no model API-key fallback. Changes that go against these won't be merged.

## Set up and run the checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm run release:manifest
npm test
npx playwright install chromium
npm run test:e2e
```

- Build before `npm test`, because some tests start the compiled `dist/cli.js`.
- Run `npm run release:manifest` after every build. Tests that connect or upgrade compare the installed copy against `RELEASE_MANIFEST.json`, and a stale manifest makes them slow or time out. The script also rewrites `THIRD_PARTY_NOTICES.md`. Commit both files if they change.
- The full suite takes a few minutes. Keep the checkout out of synced folders such as OneDrive, which can make file-heavy tests time out.
- CI runs these checks on Node 24 and 26 for every push and pull request, plus `npm run pack:check` and a Windows bundle smoke test. See [windows-preview.yml](.github/workflows/windows-preview.yml).

## Where things live

- `apps/cli`, `apps/daemon` and `apps/ui`: the command line, the loopback daemon and the browser UI.
- `packages/`: room logic (`core`), the SQLite store, coding workspaces, agent adapters, the MCP bridge, the shared-room client (`remote`) and shared types. Shared interfaces are in `packages/shared/src/contracts.ts`.
- `packages/plugin-content`: the room skill that `converoom connect` registers.
- `native/supervisor`: the Rust Job Object helper.

[Architecture](docs/ARCHITECTURE.md) explains how they fit together, and [agent support](docs/AGENT_SUPPORT.md) covers each product's adapter.

## Easy to miss

- **Stored data.** If you change a stored record's shape, bump `user_version` in `packages/store/src/index.ts` and migrate there. Older versions refuse a newer store rather than misread it.
- **Redacted fields.** HTTP responses pass through `redactTransport` (`packages/store/src/index.ts`), which drops any field whose name contains token, secret, password, credential, API key, thinking, reasoning, authorization, cookie or CSRF. Don't name a response field like that, and cover new responses with a transport test.
- **Human-only commands.** A command for the owner that isn't an MCP tool must be added to `humanCommands` in `apps/daemon/src/server.ts`, or the browser gets `unknown_command`.
- **Vendor fixtures.** Agent protocols are tested against `tests/fixtures/managed-vendor.mjs`, which fakes every vendor. A fixture pass doesn't prove a vendor works live, so say in your pull request whether you checked a real client.
- **Packaged docs.** The README and the guides in `docs/` ship in the npm package and are hashed into the release manifest. Regenerate it after editing them.

## Pull requests

- Keep each pull request to one change, with tests for new behaviour and for the bug you fixed.
- Say what changed, why, and how you checked it. Add screenshots for UI changes, at desktop width and at 360 px.
- Describe user-visible changes in the pull request. The changelog is written at release time.
- Never commit room data, exports, backups, pairing codes, invitation links or credentials, even from test runs.

## Licence

Converoom is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contributions are licensed under the same terms, as section 5 of the licence describes.
