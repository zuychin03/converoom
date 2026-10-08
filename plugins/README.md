# Product overlays

All products use the same stdio MCP contract. Start the local runtime, then `converoom connect codex|cursor|claude|opencode` to install an app-owned MCP entry. Restart the client. Uninstall through `converoom disconnect PRODUCT`; unrelated configuration survives. Bundled Converoom skills guide the end-to-end room workflow. Product-specific marketplace distribution remains separately versioned from runtime installation. Npm plugin installation runs no implicit lifecycle setup; use the explicit CLI.

Codex and Cursor managed sessions use official app-server and ACP respectively. Claude Code and OpenCode use existing subscription/native MCP clients as polling seats until their managed routes pass acceptance. No SDK subscription bypass or token scraping is included.
