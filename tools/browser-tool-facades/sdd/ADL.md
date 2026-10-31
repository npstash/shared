# Architecture Decision Log (ADL) — browser-tool-facades

The log of the decisions that change the design. Format and rules:
[sdd-templates/templates/ADL.md](../../sdd-templates/templates/ADL.md).

## Log

- 20261024-01 Nestor ac0028971533 Make the facade a 1:1 facade of the Playwright tool
- 20261024-02 Nestor ac0028971533 Support Claude Code in VSCode, the CLI, the Desktop app and the Agent SDK
- 20261024-03 Nestor ac0028971533 Log the facade to a gitignored log file
- 20261024-04 Opus-5.5 ac0028971533 Implement the facade as a Node.js MCP stdio server that runs @playwright/mcp as a child process and forwards its tools
- 20261024-05 Opus-5.5 ac0028971533 Forward roots, progress, cancellation and tool list changes between the client and Playwright MCP
- 20261024-06 Opus-5.5 ac0028971533 Run the facade on a pinned Node.js runtime that the launcher downloads into the tool folder
- 20261024-07 Opus-5.5 ac0028971533 Use Chromium as the default browser and install it into the tool folder
- 20261024-08 Opus-5.5 ac0028971533 Keep the persistent profiles, output files and temp files in the tool folder, with one profile for each browser and workspace
- 20261024-09 Opus-5.5 ac0028971533 Keep the temp folder of the OS when the tool folder cannot hold Unix sockets
- 20261024-10 Opus-5.5 ac0028971533 Write the log as JSON Lines with one entry for each tool call and each result
- 20261024-11 Opus-5.5 ac0028971533 Redact typed text and form values in the log unless PLAYWRIGHT_FACADE_LOG_SECRETS is 1
- 20261024-12 Opus-5.5 ac0028971533 Close the browser at shutdown so that the persistent profile keeps its data
- 20261024-13 Opus-5.5 ac0028971533 Skip a test on a public page when the page is not reachable
- 20261025-01 Nestor af62c9453f22 Apply the SDD workflow to the tool
- 20261025-02 Nestor af62c9453f22 Download Chromium into the tool folder and give it the missing Linux libraries without root and without OS installs
- 20261025-03 Nestor af62c9453f22 Download only the packages of the libraries that ldd reports as missing
- 20261025-04 Nestor af62c9453f22 Download fonts into the tool folder when the host has no fonts
- 20261025-05 Nestor af62c9453f22 Keep the pinned Node.js runtime that the launcher downloads
- 20261025-06 Nestor af62c9453f22 Keep the stdio MCP proxy with the MCP SDK
- 20261025-07 Nestor af62c9453f22 Switch each facade tool in a committed config file that lists all tools, with defaults written for missing tools
- 20261025-08 Nestor af62c9453f22 Keep a disabled tool in the tool list and fail its calls with the reason
- 20261025-09 Nestor af62c9453f22 Fill form values from generic placeholders through providers in the order of the config
- 20261025-10 Nestor af62c9453f22 Give each fill provider its own folder and its own committed config file
- 20261025-11 Nestor af62c9453f22 Select the vault credential by the url of the vault system, with an optional vault path and sub-vault in the config
- 20261025-12 Nestor af62c9453f22 Give the INI provider an [all] section and sections for host patterns
- 20261025-13 Nestor af62c9453f22 Ask the user through MCP elicitation for the fields that the ask provider config lists
- 20261025-14 Nestor af62c9453f22 Keep the deny-list and the allow-list in one committed file with two sections
- 20261025-15 Nestor af62c9453f22 Block denied hosts in the facade only, not in Playwright MCP
- 20261025-16 Nestor af62c9453f22 Record each opened host in the allow-list unless the config turns recording off
- 20261025-17 Opus-5.5 af62c9453f22 Disable browser_run_code_unsafe, browser_evaluate, browser_file_upload and browser_drop by default
- 20261025-18 Opus-5.5 af62c9453f22 Write placeholders as {{name}} in browser_type text, browser_fill_form values and browser_select_option values
- 20261025-19 Opus-5.5 af62c9453f22 Stop the whole call when one placeholder has no value
- 20261025-20 Opus-5.5 af62c9453f22 Add the facade tool fill_values_list that gives the placeholder names for the current page
- 20261025-21 Opus-5.5 af62c9453f22 Replace each filled value with its placeholder in each result for the time of the session
- 20261025-22 Opus-5.5 af62c9453f22 Give the vault system whose url is the longest prefix of the page URL when more systems match the host
- 20261025-23 Opus-5.5 af62c9453f22 Give the most specific INI section: exact host, then longer pattern, then [all]
- 20261025-24 Opus-5.5 af62c9453f22 Keep the answers of the ask provider for the session only and stop the call when the user declines
- 20261025-25 Opus-5.5 af62c9453f22 Match host patterns as *, *.domain for subdomains only, exact hosts and IPv4 octet wildcards
- 20261025-26 Opus-5.5 af62c9453f22 Keep each hosts.ini section sorted and unique and keep the header comments
- 20261025-27 Opus-5.5 af62c9453f22 Check the target URL before a navigation and the page URL after each call, and open about:blank for a blocked page
- 20261025-28 Opus-5.5 af62c9453f22 Use private apt package lists in the tool folder when the host has none, and delete them after the download
- 20261026-01 Nestor 6c9479e96b5f Run the browser headless by default; PLAYWRIGHT_MCP_HEADLESS=false gives a window
- 20261028-01 Nestor 14e8c70de325 Hold facades for more browser tools in this tool; plan a facade for the browser of the Claude desktop app
- 20261028-02 Nestor 14e8c70de325 Give each facade its own folder and share the form-fill providers among all facades
- 20261028-03 Opus-5.5 14e8c70de325 Share config/facade.ini, config/hosts.ini, the launcher, the runtime and the core code among all facades; keep tools.ini, the dangerous tools and the fill arguments in each facade
- 20261028-04 Opus-5.5 14e8c70de325 Select the facade with the first argument of run.sh / run.bat
- 20261031-03 Opus-5.5 6852177487b8 Remove the sub-vault option of the vault provider; the vault tool has no sub-vaults
