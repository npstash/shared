// config/hosts.ini: the deny-list and the allow-list in one file.
//   [deny]   hosts that the facade blocks; deny wins over allow
//   [allow]  hosts that the facade allows; the default allow provider adds each opened host
// Each section has one pattern on each line (see patterns.js). After each write, the lines of
// each section are sorted and unique. Comment lines at the top of the file stay.
import fs from 'node:fs';
import { formatIni, readIni, writeFileAtomic } from '../ini.js';

const HEADER = [
  '# Hosts of the browser tool facades, for all facades. Deny wins over allow.',
  '# Patterns: * (each host), *.example.com (subdomains), example.com (exact), 192.168.1.* (IPv4).',
  '# Move a line between the sections to change the list. The facade keeps each section sorted.',
];

export class HostsFile {
  constructor(file) {
    this.file = file;
    this.mtime = null;
    this.deny = [];
    this.allow = [];
  }

  // Read the file again if it changed. A missing file is created with "[allow] *".
  load() {
    if (!fs.existsSync(this.file)) this.write([], ['*']);
    const mtime = fs.statSync(this.file).mtimeMs;
    if (mtime === this.mtime) return;
    const ini = readIni(this.file);
    this.header = ini.header;
    this.deny = (ini.sections.get('deny') ?? []).map((line) => line.key);
    this.allow = (ini.sections.get('allow') ?? []).map((line) => line.key);
    this.mtime = mtime;
  }

  write(deny, allow) {
    const sorted = (lines) => [...new Set(lines)].sort();
    const header = this.header?.length ? this.header : HEADER;
    writeFileAtomic(this.file, formatIni(header, [['deny', sorted(deny)], ['allow', sorted(allow)]]));
    this.mtime = null;
  }

  // Add a line to [allow]. Read the file first: an other session can have changed it.
  addAllowed(host) {
    this.mtime = null;
    this.load();
    if (this.allow.includes(host)) return false;
    this.write(this.deny, [...this.allow, host]);
    this.load();
    return true;
  }
}
