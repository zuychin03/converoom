## What changed

<!-- What this pull request does and why. Link the issue if there is one. -->

## How I checked it

- [ ] `npm run typecheck`, `npm run lint` and `npm run build`
- [ ] `npm run release:manifest`, then `npm test`
- [ ] `npm run test:e2e`, if the UI or a browser flow changed
- [ ] Checked with a real agent client: <!-- which one and version, or "fixtures only" -->

<!-- Add screenshots for UI changes, at desktop width and at 360 px. -->

## Data and compatibility

- [ ] No change to stored data, the MCP tool contract or the release manifest
- [ ] Stored records change shape: `user_version` is bumped and migrated in `packages/store`
- [ ] The MCP tool contract changes: the room skill and the tool schemas say the same
- [ ] README or packaged docs changed: the release manifest is regenerated
