// Paths and defaults of the facade. Each default keeps the files in the tool folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS_DIR = path.join(TOOL_DIR, '.local_assets');
export const PLATFORM = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
export const TMP_DIR = path.join(ASSETS_DIR, 'tmp');
export const SYSLIBS_DIR = path.join(ASSETS_DIR, 'syslibs', PLATFORM);
export const DEFAULT_BROWSER = 'chromium';
export const DEFAULT_HEADLESS = 'true';
const LIB_TRIPLETS = { x64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu' };

const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;
export const UPSTREAM_CLI = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

// Committed config files. Tests point the env variables to copies.
export function configDirs(env = process.env) {
  return {
    config: env.PLAYWRIGHT_FACADE_CONFIG_DIR || path.join(TOOL_DIR, 'config'),
    providers: path.join(TOOL_DIR, 'providers'),
    providersConfig: env.PLAYWRIGHT_FACADE_PROVIDERS_CONFIG_DIR || path.join(TOOL_DIR, 'providers'),
  };
}

// Paths of the libraries and fonts that src/setup/syslibs.js unpacks (Linux only).
export function syslibPaths() {
  const root = path.join(SYSLIBS_DIR, 'root');
  const triplet = LIB_TRIPLETS[process.arch] ?? `${process.arch}-linux-gnu`;
  const dirs = [path.join(root, 'usr', 'lib', triplet), path.join(root, 'lib', triplet)];
  return { root, libraryPath: dirs.join(':'), libraryDirs: dirs, fontsConf: path.join(SYSLIBS_DIR, 'fonts.conf') };
}

export function loggerOptions(env = process.env) {
  return {
    file: env.PLAYWRIGHT_FACADE_LOG_FILE || path.join(ASSETS_DIR, 'logs', 'playwright-facade.log'),
    level: env.PLAYWRIGHT_FACADE_LOG_LEVEL || 'info',
    secrets: env.PLAYWRIGHT_FACADE_LOG_SECRETS === '1',
  };
}

// Give the environment of the upstream server.
// Playwright MCP reads PLAYWRIGHT_MCP_* variables, and its CLI arguments override them.
// A default is set only when the user did not set the value in another way.
export function upstreamEnv(args, env = process.env, cwd = process.cwd(), tmpDir = undefined) {
  const result = { ...env };
  result.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ASSETS_DIR, 'browsers', PLATFORM);
  // Playwright puts temporary profiles into the temp folder of the OS. See tmpDirInTool().
  if (tmpDir) result.TMPDIR = result.TEMP = result.TMP = tmpDir;
  // Playwright writes a registry of the open browsers into the cache folder of the user.
  // Only Linux has a variable for this folder.
  if (process.platform === 'linux') {
    result.XDG_CACHE_HOME = path.join(ASSETS_DIR, 'cache');
    // Libraries and fonts that the host does not have. See src/setup/syslibs.js.
    const { libraryDirs, fontsConf } = syslibPaths();
    const dirs = libraryDirs.filter((dir) => fs.existsSync(dir));
    if (dirs.length) result.LD_LIBRARY_PATH = [...dirs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    if (fs.existsSync(fontsConf)) result.FONTCONFIG_FILE ??= fontsConf;
  }

  // A config file sets its own values. The env variables would override them.
  if (hasArg(args, '--config') || env.PLAYWRIGHT_MCP_CONFIG) return result;

  result.PLAYWRIGHT_MCP_BROWSER ??= DEFAULT_BROWSER;
  // Upstream opens a window if the host has a display (also WSLg). The facade runs headless.
  // PLAYWRIGHT_MCP_HEADLESS=false gives a window again.
  result.PLAYWRIGHT_MCP_HEADLESS ??= DEFAULT_HEADLESS;
  result.PLAYWRIGHT_MCP_OUTPUT_DIR ??= path.join(ASSETS_DIR, 'output');

  const ownProfile = ['--isolated', '--user-data-dir', '--cdp-endpoint', '--extension', '--endpoint']
    .some((name) => hasArg(args, name))
    || ['PLAYWRIGHT_MCP_ISOLATED', 'PLAYWRIGHT_MCP_USER_DATA_DIR', 'PLAYWRIGHT_MCP_CDP_ENDPOINT', 'PLAYWRIGHT_MCP_EXTENSION']
      .some((name) => env[name]);
  if (!ownProfile) {
    // Like upstream: one persistent profile for each browser and workspace.
    const browser = argValue(args, '--browser') ?? result.PLAYWRIGHT_MCP_BROWSER;
    const workspace = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
    result.PLAYWRIGHT_MCP_USER_DATA_DIR = path.join(ASSETS_DIR, 'profiles', `${PLATFORM}-${browser}-${workspace}`);
  }
  return result;
}

function hasArg(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(name + '='));
}

function argValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
  }
  return undefined;
}

// Give TMP_DIR if Chromium can use it, else undefined (the temp folder of the OS stays).
// Chromium makes a Unix socket in the temp folder. Some file systems cannot hold one,
// e.g. a Windows drive in WSL (/mnt/c). Then Chromium stops with SIGTRAP.
export async function tmpDirInTool() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  if (process.platform === 'win32') return TMP_DIR;
  const socket = path.join(TMP_DIR, `probe-${process.pid}.sock`);
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    return TMP_DIR;
  } catch {
    return undefined;
  } finally {
    server.close();
    fs.rmSync(socket, { force: true });
  }
}
