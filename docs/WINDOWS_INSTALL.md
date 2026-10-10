# Windows installation bundle

10/10/2026. Windows 11 x64 preview. Use 64-bit Windows PowerShell 5.1 or PowerShell 7. The default installer installs Converoom, a private Node 24.21.0 runtime, missing Git and Tailscale, and Codex when missing. No existing Node, npm, repository checkout, native compiler or application build is needed.

## Install in one run

Download the `converoom-windows-x64` artefact from a successful [Windows preview workflow](https://github.com/zuychin03/converoom/actions/workflows/windows-preview.yml). Check its source commit matches the version you want. Extract the artefact and its contained `converoom-0.2.0-windows-x64.zip` into a local folder. Review this guide and `install.ps1`, then open PowerShell in the extracted bundle directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer verifies the bundle's file digests, installs missing prerequisites, copies the compiled runtime and its production dependencies to `%LOCALAPPDATA%\Converoom`, creates launchers, and adds their directories to your user PATH. It starts the local runtime, registers the selected agents' MCP servers and room skills, and opens the browser. Pair it using the code printed in the terminal. Ctrl+C stops this launch. Future terminals can use `converoom start`, `converoom onboard --products codex,cursor` or `converoom doctor`.

Git and Tailscale installation uses Windows App Installer (`winget`) with exact package IDs and the `winget` source. It may display Windows administrator approval and requires internet access. Starting this installer accepts those package/source agreements. If App Installer has been removed or is disabled, restore it from Microsoft Store before rerunning. Existing prerequisites and native agents are reused rather than upgraded. If a runtime lock exists, installation stops before changing its tools or registrations. Stop the runtime and rerun to repair or update; room data and earlier version directories are retained.

Choose the products you actually use by invoking the script from PowerShell:

```powershell
.\install.ps1 -Products codex,claude,opencode
.\install.ps1 -Products cursor,antigravity,kiro,qoder,grok
```

Missing Codex, Claude Code, OpenCode and Qoder can be installed from their official npm packages into a private per-user prefix. Vendor installation hooks are enabled because their native distributions require them. Qoder's npm route is a compatibility option; its vendor recommends the standalone installer for new installations. Missing Cursor, Antigravity, Kiro and Grok native clients currently need their vendor installation first; the bundle fails early with the relevant guide instead of claiming those clients are ready. Antigravity's separate official ACP server also needs its own vendor installation and login for managed sessions. See [agent support](AGENT_SUPPORT.md). Selecting every product is optional and does not increase the five-seat room limit.

Useful options:

| Option | Behaviour |
| --- | --- |
| `-DataDirectory C:\Apps\ConveroomData` | Keep runtime, tools and private room data in a chosen local directory. Avoid synced/network folders. |
| `-LocalOnly` | Explicit local-only installation, skips Tailscale installation/status. Default installs Tailscale. |
| `-NoStart` | Install and run diagnostics without starting Converoom or writing agent MCP registrations. Later run `converoom onboard --products ...`. |
| `-NoPath` | Leave persistent user PATH unchanged. Invoke the printed launcher path. |
| `-Products @()` | Install Converoom without selecting an agent. Choose/register products later. |

## Finish account sign-in

Software installation and account readiness are reported separately. Sign in through the Tailscale tray icon and the selected native agent client. For Codex use `codex login` and Sign in with ChatGPT. Restart clients to load their new room tools. Converoom does not collect vendor credentials, select paid API billing or start inference during installation/registration. Doctor probes versions and executable availability; it does not certify account entitlement or quota.

The default installer installs Tailscale but does not join a tailnet, change Serve/Funnel settings, open a firewall port or enable Converoom's shared listener. After native sign-in, follow the [private-room pilot guide](WINDOWS_SHARED_PILOT.md) to review the exact hostname/access policy and explicitly activate private HTTPS. Local rooms work independently of shared-room activation.

## Build and check the bundle

On a development machine with the repository's pinned dependencies and Node 24.21.0:

```powershell
npm run build
npm run release:manifest
npm run bundle:windows
npm run bundle:smoke
```

The builder downloads the exact official Node Windows ZIP and verifies its pinned SHA-256 before extracting it. The complete Node distribution and licence are included. Converoom's compiled UI, runtime, Windows supervisor, production dependency closure, prebuilt SQLite binary, skills, guides and licence notices are included. Proprietary agent binaries, Tailscale installers and credentials are downloaded through their own installation channels, not redistributed in this ZIP. `bundle.json` records every payload file digest; `.artifacts/windows-bundle/latest.json` records the archive digest and source commit. These integrity checks do not replace a trusted source or provide Converoom code signing.

Installer behaviour tests replace machine-level software installation with controlled fixtures. The extracted-bundle smoke uses the actual bundled Node/runtime, isolated user/data directories and real local MCP registration, pairing, room creation, restart and shutdown. It simulates Git/Tailscale availability and Tailscale's logged-out status. It does not establish a fresh-machine MSI install, actual vendor inference, live Tailscale connectivity or three fresh-user onboarding timings. Those acceptance gates remain open.

Sources: [Node 24.21.0 release and SHA-256](https://github.com/nodejs/nodejs.org/blob/main/apps/site/pages/en/blog/release/v24.21.0.md), [WinGet installation flags](https://learn.microsoft.com/en-us/windows/package-manager/winget/install), [Tailscale Windows installation and native login](https://tailscale.com/docs/install/windows), [Codex](https://github.com/openai/codex), [Claude Code npm installation](https://code.claude.com/docs/en/setup#install-with-npm), [OpenCode Windows installation](https://opencode.ai/docs/#windows), [Qoder installation](https://docs.qoder.com/cli/installation).
