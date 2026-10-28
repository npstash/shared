// Give Chromium the libraries and fonts that the host does not have. Linux only.
// It downloads Ubuntu packages and unpacks them into the tool folder. No root, no OS install.
// Usage: node playwright/src/setup/syslibs.js            (run.sh calls it after the browser install)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYSLIBS_DIR, syslibPaths } from '../config.js';

// Maximum number of download rounds. Each round fetches the packages of the missing libraries.
const SYSLIBS_ROUNDS = 10;

// Libraries whose package name does not follow the Debian rule (see packageCandidates()).
const EXCEPTIONS = {
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
};

const FONT_PACKAGES = ['fonts-liberation', 'fonts-dejavu-core', 'fonts-noto-color-emoji'];
const FONT_DIRS = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts'), path.join(os.homedir(), '.fonts')];
const FONT_FILE = /\.(ttf|otf|ttc|pfb|pcf(\.gz)?)$/i;

// Give the package names for a soname, the t64 variant first (Ubuntu 24.04 and later).
// Debian rule: lib<name>.so.<version> → lib<name><version>, with "-" if <name> ends with a digit.
export function packageCandidates(soname) {
  const base = EXCEPTIONS[soname] ?? debianName(soname);
  return base ? [`${base}t64`, base] : [];
}

function debianName(soname) {
  const match = soname.match(/^(lib[^/]+?)\.so(?:\.(.+))?$/);
  if (!match) return undefined;
  const name = match[1].toLowerCase().replace(/_/g, '-');
  const version = match[2];
  if (!version) return name;
  return /\d$/.test(name) ? `${name}-${version}` : `${name}${version}`;
}

// Parse the output of ldd. Give the sonames that are "not found".
export function parseLdd(text) {
  return [...text.matchAll(/^\s*(\S+) => not found/gm)].map((match) => match[1]);
}

// The browser binaries and the libraries beside them.
function browserFiles(browsersPath) {
  const files = [];
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

function missingLibraries(files, libraryPath) {
  const missing = new Set();
  const env = { ...process.env, LD_LIBRARY_PATH: [libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  for (const file of files) {
    const result = spawnSync('ldd', [file], { env, encoding: 'utf8' });
    for (const soname of parseLdd(result.stdout ?? '')) missing.add(soname);
  }
  return [...missing].sort();
}

function hasSystemFonts() {
  const stack = FONT_DIRS.filter((dir) => fs.existsSync(dir));
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (FONT_FILE.test(entry.name)) return true;
    }
  }
  return false;
}

// apt with the system package lists, or with private lists when the system has none.
class Apt {
  constructor(dir, privateLists = false) {
    this.dir = dir;
    this.options = [];
    if (privateLists) this.usePrivateLists();
  }

  run(command, args, cwd) {
    return spawnSync(command, [...this.options, ...args], { cwd, encoding: 'utf8' });
  }

  exists(pkg) {
    const result = this.run('apt-cache', ['show', '--no-all-versions', pkg]);
    return result.status === 0 && /^Package: /m.test(result.stdout);
  }

  // Make private package lists. Needs no root: apt writes only into this folder.
  usePrivateLists() {
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
  pick(candidates) {
    const found = candidates.find((pkg) => this.exists(pkg));
    if (found || this.options.length) return found;
    this.usePrivateLists();
    return candidates.find((pkg) => this.exists(pkg));
  }

  download(packages, debDir) {
    fs.mkdirSync(debDir, { recursive: true });
    const result = this.run('apt-get', ['download', ...packages], debDir);
    if (result.status !== 0) throw new Error(`apt-get download ${packages.join(' ')} failed:\n${result.stderr}`);
  }
}

function extractAll(debDir, root, done) {
  for (const file of fs.readdirSync(debDir).filter((name) => name.endsWith('.deb'))) {
    if (done.has(file)) continue;
    execFileSync('dpkg-deb', ['-x', path.join(debDir, file), root]);
    done.add(file);
  }
}

function writeFontsConf(file, root) {
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- Made by playwright/src/setup/syslibs.js: the system config, if any, and the fonts of the tool folder. -->
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${path.join(root, 'usr', 'share', 'fonts')}</dir>
  <cachedir>${path.join(path.dirname(file), 'fontcache')}</cachedir>
</fontconfig>
`;
  fs.writeFileSync(file, conf);
}

function log(message) {
  process.stderr.write(`syslibs: ${message}\n`);
}

export function provideSystemLibraries({ browsersPath, forceFonts = false, privateLists = false }) {
  if (process.platform !== 'linux') return;
  const { root, libraryPath, fontsConf } = syslibPaths();
  const debDir = path.join(SYSLIBS_DIR, 'deb');
  const apt = new Apt(SYSLIBS_DIR, privateLists);
  const extracted = new Set();
  const files = browserFiles(browsersPath);

  for (let round = 1; ; round++) {
    const missing = missingLibraries(files, libraryPath);
    if (!missing.length) break;
    if (round > SYSLIBS_ROUNDS) throw new Error(`libraries still missing after ${SYSLIBS_ROUNDS} rounds: ${missing.join(' ')}`);
    const packages = new Map();
    const unknown = [];
    for (const soname of missing) {
      const pkg = apt.pick(packageCandidates(soname));
      if (pkg) packages.set(pkg, soname);
      else unknown.push(soname);
    }
    if (unknown.length) throw new Error(`no package found for: ${unknown.join(' ')}. Add it to EXCEPTIONS in playwright/src/setup/syslibs.js.`);
    log(`round ${round}: ${missing.length} libraries missing; download ${[...packages.keys()].join(' ')}`);
    const before = extracted.size;
    apt.download([...packages.keys()], debDir);
    extractAll(debDir, root, extracted);
    if (extracted.size === before) throw new Error(`no progress; still missing: ${missing.join(' ')}`);
  }

  if (forceFonts || !hasSystemFonts()) {
    log(`no system fonts; download ${FONT_PACKAGES.join(' ')}`);
    apt.download(FONT_PACKAGES.map((pkg) => apt.pick([pkg])).filter(Boolean), debDir);
    extractAll(debDir, root, extracted);
    writeFontsConf(fontsConf, root);
  }
  // The private package lists are only for the download (about 300 MB). Delete them.
  fs.rmSync(path.join(SYSLIBS_DIR, 'apt'), { recursive: true, force: true });
  log(extracted.size ? `ready: ${extracted.size} packages in ${root}` : 'ready: the host has all libraries');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    provideSystemLibraries({
      browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
      // Test switches: act as a host without fonts, or without apt package lists.
      forceFonts: process.env.PLAYWRIGHT_FACADE_FORCE_FONTS === '1',
      privateLists: process.env.PLAYWRIGHT_FACADE_PRIVATE_APT === '1',
    });
  } catch (error) {
    log(error.message);
    process.exit(1);
  }
}
