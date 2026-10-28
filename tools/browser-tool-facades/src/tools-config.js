// Tool switches of a facade (<facade>/config/tools.ini). They do not change the browser tool.
// Each facade tool has one line: "name = enabled" or "name = disabled".
// A disabled tool stays in the tool list, but a call to it fails with the reason.
import fs from 'node:fs';
import { formatIni, readIni, writeFileAtomic } from './ini.js';

const SECTION = 'tools';

const HEADER = [
  '# Tool switches of the facade: "<tool> = enabled" or "<tool> = disabled".',
  '# The facade adds a line with the default value for each new tool when it starts.',
  '# A disabled tool stays in the tool list. A call to it fails with the reason.',
];

export class ToolsConfig {
  // dangerous: { <tool>: reason } — tools that a web page can misuse through prompt injection.
  // They are disabled by default.
  constructor(file, logger, dangerous = {}) {
    this.file = file;
    this.logger = logger;
    this.dangerous = dangerous;
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
    for (const name of missing) this.states.set(name, !(name in this.dangerous));
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
    const why = this.dangerous[name] ? `: ${this.dangerous[name]}` : '';
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
          + `The facade did not run it. To enable it, set "${name} = enabled" in ${this.file}.`,
      }],
    };
  }
}
