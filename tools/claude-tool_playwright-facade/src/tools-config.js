// Tool switches of the facade (config/tools.ini). They do not change Playwright MCP.
// Each facade tool has one line: "name = enabled" or "name = disabled".
// A disabled tool stays in the tool list, but a call to it fails with the reason.
import fs from 'node:fs';
import { formatIni, readIni, writeFileAtomic } from './ini.js';

const SECTION = 'tools';

// Tools that a web page can misuse through prompt injection. Disabled by default.
export const DANGEROUS_TOOLS = {
  browser_run_code_unsafe: 'it runs any JavaScript in the Playwright process on this computer, with access to files, programs and the network',
  browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page',
  browser_file_upload: 'it sends files from this computer to a website',
  browser_drop: 'it drops files from this computer onto a web page',
};

const HEADER = [
  '# Tool switches of the Playwright facade: "<tool> = enabled" or "<tool> = disabled".',
  '# The facade adds a line with the default value for each new tool when it starts.',
  '# A disabled tool stays in the tool list. A call to it fails with the reason.',
];

export class ToolsConfig {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger;
    this.mtime = undefined;
    this.states = new Map();
  }

  // Read the file again if it changed. Give true if it changed.
  reload() {
    let mtime;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      mtime = undefined;
    }
    if (mtime === this.mtime) return false;
    this.mtime = mtime;
    this.states = new Map();
    for (const { key, value } of readIni(this.file).sections.get(SECTION) ?? []) {
      if (value !== 'enabled' && value !== 'disabled') {
        this.logger.error('tools_config_invalid', { tool: key, value, file: this.file });
      }
      // An unknown value disables the tool: the safe side.
      this.states.set(key, value === 'enabled');
    }
    return true;
  }

  // Add a line with the default value for each tool that the file does not list.
  addMissing(names) {
    this.reload();
    const missing = names.filter((name) => !this.states.has(name));
    if (!missing.length) return;
    for (const name of missing) this.states.set(name, !(name in DANGEROUS_TOOLS));
    const lines = [...this.states.keys()].sort().map((name) => `${name} = ${this.states.get(name) ? 'enabled' : 'disabled'}`);
    const { header } = readIni(this.file);
    writeFileAtomic(this.file, formatIni(header.length ? header : HEADER, [[SECTION, lines]]));
    this.mtime = fs.statSync(this.file).mtimeMs;
    this.logger.info('tools_config_added', { tools: missing, file: this.file });
  }

  isEnabled(name) {
    this.reload();
    return this.states.get(name) !== false;
  }

  reason(name) {
    const why = DANGEROUS_TOOLS[name] ? `: ${DANGEROUS_TOOLS[name]}` : '';
    return `the facade config disables this tool${why}`;
  }

  // The tool as the client sees it: a disabled tool gets a note in its description.
  describe(tool) {
    if (this.isEnabled(tool.name)) return tool;
    return { ...tool, description: `DISABLED by the facade: ${this.reason(tool.name)}. ${tool.description ?? ''}`.trim() };
  }

  disabledResult(name) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `### Error\nThe tool ${name} is disabled: ${this.reason(name)}. `
          + `The Playwright facade did not run it. To enable it, set "${name} = enabled" in ${this.file}.`,
      }],
    };
  }
}
