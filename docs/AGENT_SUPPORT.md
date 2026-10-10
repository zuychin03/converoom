# Agent support

10/10/2026. The Windows x64 preview accepts eight products through its common MCP bridge. Six products have managed native adapters. Antigravity, Kiro, Qoder and Grok Build are implemented with protocol fixture coverage; actual vendor installation, entitlement and permission/cancellation/quota acceptance remain unverified. Product support does not increase the five-seat room limit.

| CLI product ID | Existing conversation | Managed launch | Authentication |
| --- | --- | --- | --- |
| `codex` | MCP polling | `codex app-server --stdio` | Native ChatGPT account, checked through app-server |
| `cursor` | MCP polling | `agent acp` | Native Cursor login |
| `claude` | MCP polling | Deferred | Claude Code owns its login |
| `opencode` | MCP polling | Deferred | OpenCode owns its provider/login |
| `antigravity` | MCP polling | Official `agy_acp_server` | Advertised `oauth-personal` method, Google Account |
| `kiro` | MCP polling | `kiro-cli acp --agent-engine=v3 --auth-method=cli` | CLI-owned native Kiro login |
| `qoder` | MCP polling | `qoder --acp` | Cached native Qoder login |
| `grok` | MCP polling | `grok --no-auto-update agent stdio` | Advertised `cached_token` method, headless native login |

The new launch contracts follow [Google's ACP integration](https://antigravity.google/docs/ide/extensions/zed/), the [official ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json), [Kiro v3 ACP](https://kiro.dev/docs/cli/v3/acp-migration/), [Qoder ACP](https://docs.qoder.com/cli/acp) and [Grok Build headless scripting](https://docs.x.ai/build/cli/headless-scripting). The registry supplies Google's binary separately from `agy`; Converoom bundles neither the server nor a community authentication adapter.

## Connect an existing conversation

Install the vendor's native client and sign in through that client. Start Converoom, then register the products you use:

```sh
converoom connect antigravity
converoom connect kiro
converoom connect qoder
converoom connect grok
```

Restart the client's MCP connection. The bundled room skill explains room creation, participation, directed replies and polling turn completion. An idle conversation reads durable pending work when it next runs. The registration does not grant automatic execution or attach Converoom to an arbitrary existing chat.

Connect preserves neighbouring settings and servers. Reconnect rotates the Converoom bridge credential. `converoom disconnect PRODUCT` removes its registration and unchanged owned skill. Use `--config PATH` and `--skills-dir PATH` for explicit locations; when only `--config` is supplied, the skill is installed beside that config in `skills/converoom-room`.

| Product | Default MCP config, relative to home | Default skill directory, relative to home |
| --- | --- | --- |
| Antigravity | `.gemini/config/mcp_config.json` | `.gemini/antigravity-cli/skills/converoom-room` |
| Kiro | `.kiro/settings/mcp.json` | `.kiro/skills/converoom-room` |
| Qoder | `.qoder/settings.json` | `.qoder/skills/converoom-room` |
| Grok Build | `.grok/config.toml` | `.grok/skills/converoom-room` |

Antigravity's standalone IDE uses a separate skill directory. To install the room skill there on PowerShell:

```powershell
converoom connect antigravity --skills-dir "$env:USERPROFILE/.gemini/config/skills/converoom-room"
```

These locations follow [Antigravity MCP](https://antigravity.google/docs/mcp?tab=cli) and [skills](https://antigravity.google/docs/skills?tab=ide), [Kiro MCP](https://kiro.dev/docs/mcp/), [Qoder MCP](https://docs.qoder.com/cli/mcp-servers) and [Grok MCP](https://docs.x.ai/build/features/mcp-servers). Grok uses TOML; the other new registrations use `mcpServers` in JSON. Only the Converoom stdio entry is written, with its stable runtime path and product identity.

## Run a managed session

Run `converoom doctor`, add the product as a new managed seat in the paired UI, enable turn requests and approve a bounded turn. Managed sessions receive an ephemeral room/seat/turn-scoped Converoom MCP server through ACP `session/new`. Credentials are revoked when the turn ends. Discussion and coding use the existing owner approval and workspace flows. Shared discussion requires independent participant-local acceptance and execution approval.

Doctor checks native executable/version availability without starting inference, logging in or reading vendor credential files. Its `installed` field describes the normal CLI; `managedInstalled` checks the managed executable. Capabilities remain declared until a real session establishes them. Installation does not establish entitlement, quota or live acceptance.

Antigravity requires the official ACP server on PATH. If installed elsewhere, set its absolute executable path before starting the daemon:

```powershell
$env:CONVEROOM_ANTIGRAVITY_ACP = 'C:/Tools/antigravity-acp/agy_acp_server.exe'
```

Keep the complete vendor distribution together, including its helper executable. Authenticate that ACP installation through Google's own integration before a Converoom turn; the CLI and ACP server can have separate login state. Managed authentication selects only an advertised Google personal OAuth method. Grok selects only an advertised cached native token and rejects API-only authentication. Kiro v3 owns authentication in its CLI; Qoder uses its native cached login. Missing authentication or quota failure stops the turn with preserved work and an explicit repair path.

## Boundaries and acceptance

ACP negotiates the supported protocol version, resolves one-time permission options, preserves Kiro consent metadata and waits for the prompt response to settle cancellation. Only text marked as public agent messages for the active session is returned. Private thought chunks, tool output and other sessions' messages are excluded. Public output is bounded to 1 MiB of UTF-8 bytes. Converoom uses a vendor's ask/plan mode where advertised, but this is advisory and does not create a read-only filesystem boundary.

Managed coding sessions advertise client filesystem and terminal callbacks, including those described in Qoder's ACP contract. Each read, write and terminal creation requires its own owner approval. Paths are checked against the canonical assigned workspace, including symlink/junction resolution, and checked again after approval. Writes bind the content digest and size in the approval. Text files are limited to 1 MiB. Terminals use literal argv, retain at most 1 MiB of output, allow at most four open handles and stop after five minutes or at turn completion/cancellation. Terminal output truncation preserves UTF-8 character boundaries. Discussion sessions do not advertise these callbacks. These client checks do not contain vendor-owned native tools or eliminate filesystem races from other trusted local processes.

The Windows supervisor launches literal argument arrays and terminates owned process trees. API-key environment variables for the supported vendors, including Qoder's personal access token, are removed from managed processes. Vendor configuration and account extra-usage settings remain vendor-owned; select a native account profile before launching. Converoom cannot certify billing or containment from protocol fixtures and never retries a failed turn through an API or another provider.

Local tests cover all eight MCP identities and the five ACP products' launch arguments, public-message filtering, one-time allow/deny, Kiro metadata, cooperative cancellation, incompatible protocol rejection and auth/quota failure. Coding callback fixtures cover approved file/terminal work, denied writes, foreign-session/outside-workspace/junction rejection, UTF-8 limits and owned descendant shutdown. Managed wire fixtures exercise the real scoped MCP bridge for Codex and all five ACP products. The new products still need pinned vendor/version/Windows runs for MCP loading, discussion, coding, permissions, cancellation, account recovery and quota handling. See [preview acceptance](PREVIEW_ACCEPTANCE.md) for the retained release gates.
