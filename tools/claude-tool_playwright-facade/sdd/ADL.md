# Architecture Decision Log (ADL) — claude-tool_playwright-facade

The log of the decisions that change the design. Format and rules:
[projects/sdd_templates/ADL.md](../../../../projects/sdd_templates/ADL.md).

## Log

- 20261024-061003-00 authored Nestor 825305953c65 Make the facade a 1:1 facade of the Playwright tool
- 20261024-061003-01 authored Nestor 825305953c65 Support Claude Code in VSCode, the CLI, the Desktop app and the Agent SDK
- 20261024-061003-02 authored Nestor 825305953c65 Log the facade to a gitignored log file
- 20261024-061003-03 generated Opus-5.5 825305953c65 Implement the facade as a Node.js MCP stdio server that runs @playwright/mcp as a child process and forwards its tools
- 20261024-061003-04 generated Opus-5.5 825305953c65 Forward roots, progress, cancellation and tool list changes between the client and Playwright MCP
- 20261024-061003-05 generated Opus-5.5 825305953c65 Run the facade on a pinned Node.js runtime that the launcher downloads into the tool folder
- 20261024-061003-06 generated Opus-5.5 825305953c65 Use Chromium as the default browser and install it into the tool folder
- 20261024-061003-07 generated Opus-5.5 825305953c65 Keep the persistent profiles, output files and temp files in the tool folder, with one profile for each browser and workspace
- 20261024-061003-08 generated Opus-5.5 825305953c65 Keep the temp folder of the OS when the tool folder cannot hold Unix sockets
- 20261024-061003-09 generated Opus-5.5 825305953c65 Write the log as JSON Lines with one entry for each tool call and each result
- 20261024-061003-10 generated Opus-5.5 825305953c65 Redact typed text and form values in the log unless PLAYWRIGHT_FACADE_LOG_SECRETS is 1
- 20261024-061003-11 generated Opus-5.5 825305953c65 Close the browser at shutdown so that the persistent profile keeps its data
- 20261024-061003-12 generated Opus-5.5 825305953c65 Skip a test on a public page when the page is not reachable
- 20261025-205943-00 authored Nestor 93411e71fd9a Apply the SDD workflow to the tool
- 20261025-205943-01 authored Nestor 93411e71fd9a Download Chromium into the tool folder and give it the missing Linux libraries without root and without OS installs
- 20261025-205943-02 authored Nestor 93411e71fd9a Download only the packages of the libraries that ldd reports as missing
- 20261025-205943-03 authored Nestor 93411e71fd9a Download fonts into the tool folder when the host has no fonts
- 20261025-205943-04 authored Nestor 93411e71fd9a Keep the pinned Node.js runtime that the launcher downloads
- 20261025-205943-05 authored Nestor 93411e71fd9a Keep the stdio MCP proxy with the MCP SDK
- 20261025-205943-06 authored Nestor 93411e71fd9a Switch each facade tool in a committed config file that lists all tools, with defaults written for missing tools
- 20261025-205943-07 authored Nestor 93411e71fd9a Keep a disabled tool in the tool list and fail its calls with the reason
- 20261025-205943-08 authored Nestor 93411e71fd9a Fill form values from generic placeholders through providers in the order of the config
- 20261025-205943-09 authored Nestor 93411e71fd9a Give each fill provider its own folder and its own committed config file
- 20261025-205943-10 authored Nestor 93411e71fd9a Select the vault credential by the url of the vault system, with an optional vault path and sub-vault in the config
- 20261025-205943-11 authored Nestor 93411e71fd9a Give the INI provider an [all] section and sections for host patterns
- 20261025-205943-12 authored Nestor 93411e71fd9a Ask the user through MCP elicitation for the fields that the ask provider config lists
- 20261025-205943-13 authored Nestor 93411e71fd9a Keep the deny-list and the allow-list in one committed file with two sections
- 20261025-205943-14 authored Nestor 93411e71fd9a Block denied hosts in the facade only, not in Playwright MCP
- 20261025-205943-15 authored Nestor 93411e71fd9a Record each opened host in the allow-list unless the config turns recording off
- 20261025-205943-16 generated Opus-5.5 93411e71fd9a Disable browser_run_code_unsafe, browser_evaluate, browser_file_upload and browser_drop by default
- 20261025-205943-17 generated Opus-5.5 93411e71fd9a Write placeholders as {{name}} in browser_type text, browser_fill_form values and browser_select_option values
- 20261025-205943-18 generated Opus-5.5 93411e71fd9a Stop the whole call when one placeholder has no value
- 20261025-205943-19 generated Opus-5.5 93411e71fd9a Add the facade tool fill_values_list that gives the placeholder names for the current page
- 20261025-205943-20 generated Opus-5.5 93411e71fd9a Replace each filled value with its placeholder in each result for the time of the session
- 20261025-205943-21 generated Opus-5.5 93411e71fd9a Give the vault system whose url is the longest prefix of the page URL when more systems match the host
- 20261025-205943-22 generated Opus-5.5 93411e71fd9a Give the most specific INI section: exact host, then longer pattern, then [all]
- 20261025-205943-23 generated Opus-5.5 93411e71fd9a Keep the answers of the ask provider for the session only and stop the call when the user declines
- 20261025-205943-24 generated Opus-5.5 93411e71fd9a Match host patterns as *, *.domain for subdomains only, exact hosts and IPv4 octet wildcards
- 20261025-205943-25 generated Opus-5.5 93411e71fd9a Keep each hosts.ini section sorted and unique and keep the header comments
- 20261025-205943-26 generated Opus-5.5 93411e71fd9a Check the target URL before a navigation and the page URL after each call, and open about:blank for a blocked page
- 20261025-205943-27 generated Opus-5.5 93411e71fd9a Use private apt package lists in the tool folder when the host has none, and delete them after the download
- 20261026-072128-00 authored Nestor 94add1b00e31 Run the browser headless by default; PLAYWRIGHT_MCP_HEADLESS=false gives a window
