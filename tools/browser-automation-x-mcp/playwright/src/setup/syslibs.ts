// Give Chromium the libraries and fonts that the host does not have, and Xvfb. Linux only.
// It downloads Ubuntu packages and unpacks them into the tool folder. No root, no OS install.
// Usage: node playwright/src/setup/syslibs.ts            (run.sh calls it after the browser install)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { errorMessage } from '../../../src/json.ts';
import { SYSLIBS_DIR, syslibPaths } from '../config.ts';
import { XVFB_PACKAGES, patchXkbBinDir, xvfbPaths } from '../xvfb.ts';

// Maximum number of download rounds. Each round fetches the packages of the missing libraries.
const SYSLIBS_ROUNDS: number = 10;

// Libraries whose package name does not follow the Debian rule (see packageCandidates()).
const EXCEPTIONS: Readonly<Record<string, string>> = {
  'libnssutil3.so': 'libnss3',
  'libsmime3.so': 'libnss3',
  'libssl3.so': 'libnss3',
  'libglib-2.0.so.0': 'libglib2.0-0',
  'libgobject-2.0.so.0': 'libglib2.0-0',
  'libgio-2.0.so.0': 'libglib2.0-0',
  'libgmodule-2.0.so.0': 'libglib2.0-0',
  'libatk-1.0.so.0': 'libatk1.0-0',
  'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0',
  'libatspi.so.0': 'libatspi2.0-0',
  'libharfbuzz.so.0': 'libharfbuzz0b',
  'libbrotlidec.so.1': 'libbrotli1',
  'libbrotlicommon.so.1': 'libbrotli1',
  'libz.so.1': 'zlib1g',
  'libxml2.so.2': 'libxml2',
  'libhogweed.so.6': 'libnettle8',
  'libXfont2.so.2': 'libxfont2',
};

const FONT_PACKAGES: readonly string[] = ['fonts-liberation', 'fonts-dejavu-core', 'fonts-noto-color-emoji'];
const FONT_DIRS: readonly string[] = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts'), path.join(os.homedir(), '.fonts')];
const FONT_FILE: RegExp = /\.(ttf|otf|ttc|pfb|pcf(\.gz)?)$/i;

// Give the package names for a soname, the t64 variant first (Ubuntu 24.04 and later).
// Debian rule: lib<name>.so.<version> → lib<name><version>, with "-" if <name> ends with a digit.
export function packageCandidates(soname: string): string[] {
  const base = EXCEPTIONS[soname] ?? debianName(soname);
  return base ? [`${base}t64`, base] : [];
}

function debianName(soname: string): string | undefined {
  const match = soname.match(/^(lib[^/]+?)\.so(?:\.(.+))?$/);
  if (!match) return undefined;
  const name = (match[1] ?? '').toLowerCase().replace(/_/g, '-');
  const version = match[2];
  if (!version) return name;
  return /\d$/.test(name) ? `${name}-${version}` : `${name}${version}`;
}

// Parse the output of ldd. Give the sonames that are "not found".
export function parseLdd(text: string): string[] {
  return [...text.matchAll(/^\s*(\S+) => not found/gm)].map((match) => match[1] ?? '');
}

// The browser binaries and the libraries beside them.
function browserFiles(browsersPath: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(browsersPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^chromium(_headless_shell)?-\d+$/.test(entry.name)) continue;
    const dir = path.join(browsersPath, entry.name);
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const subDir = path.join(dir, sub.name);
      for (const file of fs.readdirSync(subDir)) {
        if (file === 'chrome' || file === 'chrome-headless-shell' || /\.so(\.\d+)*$/.test(file)) files.push(path.join(subDir, file));
      }
    }
  }
  return files;
}

function missingLibraries(files: readonly string[], libraryPath: string): string[] {
  const missing = new Set<string>();
  const env = { ...process.env, LD_LIBRARY_PATH: [libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  for (const file of files) {
    const result = spawnSync('ldd', [file], { env, encoding: 'utf8' });
    for (const soname of parseLdd(result.stdout ?? '')) missing.add(soname);
  }
  return [...missing].sort();
}

function hasSystemFonts(): boolean {
  const stack = FONT_DIRS.filter((dir) => fs.existsSync(dir));
  while (stack.length) {
    const dir = stack.pop() ?? '';
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (FONT_FILE.test(entry.name)) return true;
    }
  }
  return false;
}

// apt with the system package lists, or with private lists when the system has none.
class Apt {
  private readonly dir: string;
  private options: string[];

  constructor(dir: string, privateLists: boolean = false) {
    this.dir = dir;
    this.options = [];
    if (privateLists) this.usePrivateLists();
  }

  run(command: string, args: readonly string[], cwd?: string): SpawnSyncReturns<string> {
    return spawnSync(command, [...this.options, ...args], { cwd, encoding: 'utf8' });
  }

  exists(pkg: string): boolean {
    const result = this.run('apt-cache', ['show', '--no-all-versions', pkg]);
    return result.status === 0 && /^Package: /m.test(result.stdout);
  }

  // Make private package lists. Needs no root: apt writes only into this folder.
  usePrivateLists(): boolean {
    const lists = path.join(this.dir, 'apt', 'lists');
    const cache = path.join(this.dir, 'apt', 'cache');
    fs.mkdirSync(path.join(lists, 'partial'), { recursive: true });
    fs.mkdirSync(path.join(cache, 'archives', 'partial'), { recursive: true });
    this.options = ['-o', `Dir::State::Lists=${lists}`, '-o', `Dir::Cache=${cache}`, '-o', 'Debug::NoLocking=1'];
    log('make private package lists (apt-get update)');
    const result = this.run('apt-get', ['update']);
    if (result.status !== 0) throw new Error(`apt-get update failed:\n${result.stderr}`);
    return true;
  }

  // Give the first candidate that exists. Use private lists if the system lists have none.
  pick(candidates: readonly string[]): string | undefined {
    const found = candidates.find((pkg) => this.exists(pkg));
    if (found || this.options.length) return found;
    this.usePrivateLists();
    return candidates.find((pkg) => this.exists(pkg));
  }

  download(packages: readonly string[], debDir: string): void {
    fs.mkdirSync(debDir, { recursive: true });
    const result = this.run('apt-get', ['download', ...packages], debDir);
    if (result.status !== 0) throw new Error(`apt-get download ${packages.join(' ')} failed:\n${result.stderr}`);
  }
}

function extractAll(debDir: string, root: string, done: Set<string>): void {
  for (const file of fs.readdirSync(debDir).filter((name) => name.endsWith('.deb'))) {
    if (done.has(file)) continue;
    execFileSync('dpkg-deb', ['-x', path.join(debDir, file), root]);
    done.add(file);
  }
}

function writeFontsConf(file: string, root: string): void {
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- Made by playwright/src/setup/syslibs.ts: the system config, if any, and the fonts of the tool folder. -->
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${path.join(root, 'usr', 'share', 'fonts')}</dir>
  <cachedir>${path.join(path.dirname(file), 'fontcache')}</cachedir>
</fontconfig>
`;
  fs.writeFileSync(file, conf);
}

function log(message: string): void {
  process.stderr.write(`syslibs: ${message}\n`);
}

export interface SyslibsOptions {
  readonly browsersPath: string;
  readonly forceFonts?: boolean;
  readonly privateLists?: boolean;
}

export function provideSystemLibraries({ browsersPath, forceFonts = false, privateLists = false }: SyslibsOptions): void {
  if (process.platform !== 'linux') return;
  const { root, libraryPath, fontsConf } = syslibPaths();
  const debDir = path.join(SYSLIBS_DIR, 'deb');
  const apt = new Apt(SYSLIBS_DIR, privateLists);
  const extracted = new Set<string>();
  const files = browserFiles(browsersPath);

  // Xvfb for a headed browser without a display. The ldd rounds also give its libraries.
  log(`download ${XVFB_PACKAGES.join(' ')}`);
  apt.download(XVFB_PACKAGES.map((pkg) => apt.pick([pkg]) ?? pkg), debDir);
  extractAll(debDir, root, extracted);
  const xvfb = xvfbPaths();
  fs.writeFileSync(xvfb.binary, patchXkbBinDir(fs.readFileSync(xvfb.binary)));
  files.push(xvfb.binary, xvfb.xkbcomp);

  for (let round = 1; ; round++) {
    const missing = missingLibraries(files, libraryPath);
    if (!missing.length) break;
    if (round > SYSLIBS_ROUNDS) throw new Error(`libraries still missing after ${SYSLIBS_ROUNDS} rounds: ${missing.join(' ')}`);
    const packages = new Map<string, string>();
    const unknown: string[] = [];
    for (const soname of missing) {
      const pkg = apt.pick(packageCandidates(soname));
      if (pkg) packages.set(pkg, soname);
      else unknown.push(soname);
    }
    if (unknown.length) throw new Error(`no package found for: ${unknown.join(' ')}. Add it to EXCEPTIONS in playwright/src/setup/syslibs.ts.`);
    log(`round ${round}: ${missing.length} libraries missing; download ${[...packages.keys()].join(' ')}`);
    const before = extracted.size;
    apt.download([...packages.keys()], debDir);
    extractAll(debDir, root, extracted);
    if (extracted.size === before) throw new Error(`no progress; still missing: ${missing.join(' ')}`);
  }

  if (forceFonts || !hasSystemFonts()) {
    log(`no system fonts; download ${FONT_PACKAGES.join(' ')}`);
    apt.download(FONT_PACKAGES.map((pkg) => apt.pick([pkg])).filter((pkg): pkg is string => Boolean(pkg)), debDir);
    extractAll(debDir, root, extracted);
    writeFontsConf(fontsConf, root);
  }
  // The private package lists are only for the download (about 300 MB). Delete them.
  fs.rmSync(path.join(SYSLIBS_DIR, 'apt'), { recursive: true, force: true });
  log(extracted.size ? `ready: ${extracted.size} packages in ${root}` : 'ready: the host has all libraries');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    provideSystemLibraries({
      browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
      // Test switches: act as a host without fonts, or without apt package lists.
      forceFonts: process.env.BROWSER_AUTOMATION_X_MCP_FORCE_FONTS === '1',
      privateLists: process.env.BROWSER_AUTOMATION_X_MCP_PRIVATE_APT === '1',
    });
  } catch (error) {
    log(errorMessage(error));
    process.exit(1);
  }
}
