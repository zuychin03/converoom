# Security policy

## Supported versions

Converoom is a preview. Security fixes go into the latest release, published to npm as `@converoom/cli@preview`, and into `develop`. Older versions don't get separate fixes.

## Reporting a vulnerability

Please report vulnerabilities privately. Don't open a public issue, discussion or pull request.

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include what's affected, the steps to reproduce it, the impact you expect, and the output of `converoom version`.

This is a small project maintained in spare time, so a reply may take a few days. You'll hear back once the report has been looked at, and again when a fix is ready. Please keep the details private until then.

## Scope

In scope:

- The loopback daemon, browser UI and pairing: another program issuing owner commands without the one-use code, or a code working twice.
- Approvals and grants: an agent taking a turn, executing or applying work without the owner's grant, or a room host approving another machine's work.
- Credentials: bridge credentials or shared-room tokens reaching data files, exports, backups, logs or HTTP responses.
- Shared rooms: invitations, OAuth sign-in, recovery codes and member isolation on the private HTTPS listener.
- Coding workspaces: clones, checks, apply or branch export escaping their scope, changing a dirty target, or pushing.
- Installation and upgrades: a tampered runtime passing the release manifest check.

Out of scope:

- What an agent's own native tools do. The Windows Job Object helper supervises process lifetime. It is not a filesystem or network sandbox, and source scopes are advisory for native tools.
- Other programs running as you. They can read Windows Credential Manager and your data folder.
- Claude Code, Codex, Cursor and the other agent clients, and their sign-in. Report those to the vendor.
- Exposing Converoom on a public address, which isn't supported.

## Keeping your installation safe

- Install with `--ignore-scripts`, and check the published package with `npm audit signatures`.
- Keep the data folder local, out of synced or network folders, and keep exports and backups private.
- Leave shared access off unless you need it, and only serve it through the private HTTPS setup in the [Windows pilot guide](docs/WINDOWS_SHARED_PILOT.md).
