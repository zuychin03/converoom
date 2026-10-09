# Windows V1.1 private-room pilot

10/10/2026. Package 0.2.0, Windows 11 x64, Node 24.21.0. The real two-machine pilot is pending. Local tests use an isolated TLS fixture and protocol stand-ins; they do not prove vendor acceptance or an installed Tailscale proxy.

## Host setup

Install the exact local tarball using the README instructions. Keep room data in a local directory outside OneDrive or network folders. Before activation, both participants review tailnet membership, access rules, HTTPS and the actual host name. Use a dedicated shared listener:

```powershell
converoom start --shared-origin https://HOST.TAILNET.ts.net --shared-port 43323
```

Replace the example origin with the exact private HTTPS origin. The normal local control URL and pairing code are printed separately. Shared access remains unavailable outside loopback until the owner explicitly configures the proxy. The later activation command is:

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:43323
tailscale serve status
```

Serve routes privately within the tailnet and terminates HTTPS. Confirm its exact target is the dedicated shared listener. Do not use Funnel or forward the local control port. See the official [Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve). No activation command has been run by this implementation session.

Pair the host's local browser, create a discussion room and open Members. Create an invitation, then send its private room address (`https://HOST.TAILNET.ts.net/shared`), room ID and one-use code to the intended participant. Codes expire after ten minutes and are displayed once. Confirm their displayed owner identity and generation out of band before selecting Confirm participant.

## Participant setup

On the second Windows machine, open the private shared address and redeem the invitation. Wait for confirmation. Start and pair a separate local Converoom runtime. In its Connections view, enter the exact private origin, room ID and product, then open the approval link in the browser already holding shared membership. Review bridge access and allow the exact room. The fixed callback is `127.0.0.1:50181`; a conflicting listener causes a visible setup failure.

Use the displayed `converoom connect PRODUCT --remote-connection ID` command for your own stdio MCP registration. Vendor sign-in remains in the vendor client. Claude Code/OpenCode polling stays manual. Codex/Cursor managed discussion is a separate optional local action with explicit turn/time bounds. In the shared Members view, configure who may request your agent and their budget.

A host request becomes an incoming proposal in your local Connections view. Inspect its prompt, public context, requester, digest, deadline and budget. Decline it or accept the exact proposal, then separately grant or deny execution in local Approvals. Acceptance alone does not start inference. A room owner cannot grant execution on the participant machine. Coding and shell profiles are unavailable through the shared listener.

## Recovery and removal

Local disconnect fences local proposals and removes room credentials. It does not prove server-side revocation or process stop. The room owner removes membership separately, which advances generation, invalidates access and closes streams. Uncertain work stays available for inspection; do not resend a consequential operation merely because its acknowledgement was lost.

After browser-session expiry or loss, ask the host to select Recover identity for your existing member. Redeem that bound code with Recover my existing identity selected, then confirm the same identity with the host. History and owner identity are retained. Old sessions and agent seats are withdrawn; reconnect products and choose fresh consent. A pending OAuth page is invalidated after participant-daemon restart, so disconnect it and prepare a new connection.

Stop Converoom before changing shared origin/port, upgrading, downgrading or repairing a partial install. Setup retains version directories and room history. `disconnect` removes the owned product registration; full CLI upgrade/recover/uninstall commands remain open V1 requirements.

## Evidence to collect on the real machines

Record the exact tarball SHA-256, OS/Node/Tailscale and vendor versions, canonical private origin, participant identities and agreed inference limits. Do not record tokens, invitation codes or vendor credentials.

Exercise invitation and confirmation, both directions of public discussion, artefact review, exact denial with zero inference, bounded approval, actual vendor MCP loading, permission prompts, cooperative cancellation, disconnect/reconnect, removal during delivery and native work, quota/auth failure and retained uncertainty. Verify old credentials and private routes fail from the second device. Preserve public outputs separately from private reasoning and label each actual or fixture result.

Time three fresh-user onboarding sessions against the ten-minute target. Measure acknowledgement, rendered update latency, combined idle browser memory and capacity on the actual Windows devices. Complete manual keyboard/screen-reader/WCAG 2.2 checks. Verify the [Windows CI result](https://github.com/zuychin03/converoom/actions/workflows/windows-preview.yml) for the exact source commit being tested. These receipts remain acceptance gates; a local fixture pass cannot replace them.
