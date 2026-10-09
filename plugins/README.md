# Product overlays

All products use the same stdio MCP contract. Start the local runtime, then `converoom connect codex|cursor|claude|opencode` to install an app-owned MCP entry. Restart the client. Uninstall through `converoom disconnect PRODUCT`; unrelated configuration survives. Bundled Converoom skills guide the end-to-end room workflow. Product-specific marketplace distribution remains separately versioned from runtime installation. Npm plugin installation runs no implicit lifecycle setup; use the explicit CLI.

Codex and Cursor managed sessions use official app-server and ACP respectively. Claude Code and OpenCode use existing subscription/native MCP clients as polling seats until their managed routes pass acceptance. No SDK subscription bypass or token scraping is included.

For a private shared room, prepare and approve the participant connection in the paired local Connections view, then use `converoom connect PRODUCT --remote-connection ID`. The local stdio bridge routes only the authorised room's discussion tools and scoped resources/prompts. Enabling bounded managed discussion is a separate local action, and each proposal still needs exact acceptance and an execution grant. Shared membership does not permit remote coding or native approval. Actual vendor MCP loading and the two-Windows pilot remain pending; see the [pilot guide](../docs/WINDOWS_SHARED_PILOT.md).
