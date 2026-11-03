// Paths and defaults of the server. Each default keeps the files in the tool folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, PLATFORM, TOOL_DIR } from '../../src/paths.js';

export const PLAYWRIGHT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TMP_DIR = path.join(ASSETS_DIR, 'tmp');
export const REPO_TMP_DIR = path.join(repoRoot(TOOL_DIR), '.local_assets', 'tmp');
export const SYSLIBS_DIR = path.join(ASSETS_DIR, 'syslibs', PLATFORM);
// The only browser. --browser and PLAYWRIGHT_MCP_BROWSER have no effect.
export const BROWSER = 'chromium';
const LIB_TRIPLETS = { x64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu' };

const require = createRequire(import.meta.url);
export const UPSTREAM_CLI = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

// The tool switches of the server: tools.ini in the config folder. See src/paths.js.
export const TOOLS_CONFIG = 'tools.ini';
export const TOOLS_TEMPLATE = path.join(PLAYWRIGHT_DIR, 'config', 'tools.template.ini');

// Take --config-dir DIR out of the arguments: the server uses it, Playwright MCP does not know it.
// Give { configDir, args }. A relative path is relative to cwd. The argument is necessary.
export function takeConfigDir(args, cwd = process.cwd()) {
  const rest = [];
  let configDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config-dir') configDir = args[++i];
    else if (args[i].startsWith('--config-dir=')) configDir = args[i].slice('--config-dir='.length);
    else rest.push(args[i]);
  }
  if (!configDir) throw new Error('give the config folder with --config-dir DIR, e.g. --config-dir local/configs/browser-automation-x-mcp');
  return { configDir: path.resolve(cwd, configDir), args: rest };
}

// Paths of the libraries and fonts that playwright/src/setup/syslibs.js unpacks (Linux only).
export function syslibPaths() {
  const root = path.join(SYSLIBS_DIR, 'root');
  const triplet = LIB_TRIPLETS[process.arch] ?? `${process.arch}-linux-gnu`;
  const dirs = [path.join(root, 'usr', 'lib', triplet), path.join(root, 'lib', triplet)];
  return { root, libraryPath: dirs.join(':'), libraryDirs: dirs, fontsConf: path.join(SYSLIBS_DIR, 'fonts.conf') };
}

export function loggerOptions(env = process.env) {
  return {
    file: env.BROWSER_AUTOMATION_X_MCP_LOG_FILE || path.join(ASSETS_DIR, 'logs', 'browser-automation-x-mcp.log'),
    level: env.BROWSER_AUTOMATION_X_MCP_LOG_LEVEL || 'info',
    secrets: env.BROWSER_AUTOMATION_X_MCP_LOG_SECRETS === '1',
  };
}

// Give the environment of the upstream server.
// Playwright MCP reads PLAYWRIGHT_MCP_* variables, and its CLI arguments override them.
// A default is set only when the user did not set the value in another way.
export function upstreamEnv(args, env = process.env, cwd = process.cwd(), tmpDir = undefined) {
  const result = { ...env };
  result.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ASSETS_DIR, 'browsers', PLATFORM);
  // Playwright puts temporary profiles into the temp folder of the OS. See tmpDirForChromium().
  if (tmpDir) result.TMPDIR = result.TEMP = result.TMP = tmpDir;
  // Playwright writes a registry of the open browsers into the cache folder of the user.
  // Only Linux has a variable for this folder.
  if (process.platform === 'linux') {
    result.XDG_CACHE_HOME = path.join(ASSETS_DIR, 'cache');
    // Libraries and fonts that the host does not have. See setup/syslibs.js.
    const { libraryDirs, fontsConf } = syslibPaths();
    const dirs = libraryDirs.filter((dir) => fs.existsSync(dir));
    if (dirs.length) result.LD_LIBRARY_PATH = [...dirs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    if (fs.existsSync(fontsConf)) result.FONTCONFIG_FILE ??= fontsConf;
  }

  // The env variable overrides the browser of a config file too.
  result.PLAYWRIGHT_MCP_BROWSER = BROWSER;

  // A config file sets its own values. The env variables would override them.
  if (hasArg(args, '--config') || env.PLAYWRIGHT_MCP_CONFIG) return result;

  // The output files go to the workspace: the agent reads them. The tool folder can be closed to agents.
  result.PLAYWRIGHT_MCP_OUTPUT_DIR ??= path.join(cwd, '.local_assets', 'browser-automation-x-mcp', 'output');

  const ownProfile = ['--isolated', '--user-data-dir', '--cdp-endpoint', '--extension', '--endpoint']
    .some((name) => hasArg(args, name))
    || ['PLAYWRIGHT_MCP_ISOLATED', 'PLAYWRIGHT_MCP_USER_DATA_DIR', 'PLAYWRIGHT_MCP_CDP_ENDPOINT', 'PLAYWRIGHT_MCP_EXTENSION']
      .some((name) => env[name]);
  if (!ownProfile) {
    // Like upstream: one persistent profile for each workspace.
    const workspace = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
    result.PLAYWRIGHT_MCP_USER_DATA_DIR = path.join(ASSETS_DIR, 'profiles', `${PLATFORM}-${BROWSER}-${workspace}`);
  }
  return result;
}

export const RENDER_MODES = ['DEFAULT', 'HEADED_INVISIBLE', 'HEADED', 'HEADLESS'];

// Give the render mode of the browser: 'HEADED', 'HEADED_INVISIBLE' (headed on Xvfb) or 'HEADLESS'.
// RENDER_MODE selects it. HEADLESS comes only from the setting, never from a fallback.
// DEFAULT gives HEADED_INVISIBLE on WSL and on Linux without a display, else HEADED.
// HEADED without a display gives HEADED_INVISIBLE. Stop with an error if Xvfb is necessary and the
// OS has none.
export function renderMode(env = process.env, platform = process.platform, wsl = isWsl(env, platform)) {
  const value = env.RENDER_MODE || 'DEFAULT';
  if (!RENDER_MODES.includes(value)) throw new Error(`RENDER_MODE=${value} is not known. Use ${RENDER_MODES.join(', ')}.`);
  if (value === 'HEADLESS') return 'HEADLESS';
  const noDisplay = platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  if (value === 'HEADED_INVISIBLE' || noDisplay || (value === 'DEFAULT' && wsl)) {
    if (platform !== 'linux') throw new Error(`RENDER_MODE=${value} needs Xvfb. Xvfb is available only on Linux.`);
    return 'HEADED_INVISIBLE';
  }
  return 'HEADED';
}

export function isWsl(env = process.env, platform = process.platform) {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// With these arguments, upstream connects to a browser that runs already. The render mode has no effect.
export function connectsToBrowser(args) {
  return ['--cdp-endpoint', '--extension', '--endpoint'].some((name) => hasArg(args, name));
}

// Give the arguments without --headless. The render mode replaces it.
export function withoutHeadless(args) {
  return args.filter((arg) => arg !== '--headless' && !arg.startsWith('--headless='));
}

// Give the arguments without --browser. The browser is always BROWSER.
export function withoutBrowser(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--browser') i++;
    else if (!args[i].startsWith('--browser=')) result.push(args[i]);
  }
  return result;
}

function hasArg(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(name + '='));
}

export function argValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
  }
  return undefined;
}

// The first folder with .git above the tool folder: the root of the repository.
function repoRoot(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return dir;
  }
}

// Chromium makes the Unix socket <temp folder>/org.chromium.Chromium.XXXXXX/SingletonSocket.
// A socket path has a maximum length: 107 characters on Linux, 103 on macOS.
const CHROMIUM_SOCKET_SUFFIX = '/org.chromium.Chromium.XXXXXX/SingletonSocket'.length;
const MAX_SOCKET_PATH = process.platform === 'darwin' ? 103 : 107;

// Give the first folder that can hold the socket of Chromium, else undefined (the temp folder
// of the OS stays). The candidates: TMP_DIR, then REPO_TMP_DIR. A folder fails if the socket
// path is too long, or if its file system cannot hold a socket, e.g. a Windows drive in WSL
// (/mnt/c). Without a correct folder, Chromium stops with SIGABRT or SIGTRAP.
export async function tmpDirForChromium(candidates = [TMP_DIR, REPO_TMP_DIR]) {
  if (process.platform === 'win32') {
    fs.mkdirSync(candidates[0], { recursive: true });
    return candidates[0];
  }
  for (const dir of [...new Set(candidates)]) {
    if (dir.length + CHROMIUM_SOCKET_SUFFIX > MAX_SOCKET_PATH) continue;
    if (await holdsSocket(dir)) return dir;
  }
  return undefined;
}

async function holdsSocket(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const socket = path.join(dir, `probe-${process.pid}.sock`);
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    server.close();
    fs.rmSync(socket, { force: true });
  }
}
