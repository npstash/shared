// Paths and defaults of the server. Each default keeps the files in the tool folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from '../../src/logger.ts';
import { isLogLevel } from '../../src/logger.ts';
import { ASSETS_DIR, PLATFORM, TOOL_DIR } from '../../src/paths.ts';

export const PLAYWRIGHT_DIR: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TMP_DIR: string = path.join(ASSETS_DIR, 'tmp');
export const REPO_TMP_DIR: string = path.join(repoRoot(TOOL_DIR), '.local_assets', 'tmp');
export const SYSLIBS_DIR: string = path.join(ASSETS_DIR, 'syslibs', PLATFORM);
// The storage-state files of the lanes (see storage-state.js): one for each workspace.
export const STATE_DIR: string = ASSETS_DIR;
const LIB_TRIPLETS: Readonly<Record<string, string>> = { x64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu' };

export type Env = Readonly<Record<string, string | undefined>>;
export type RenderMode = 'HEADED' | 'HEADED_INVISIBLE' | 'HEADLESS';

export interface SyslibPaths {
  readonly root: string;
  readonly libraryPath: string;
  readonly libraryDirs: readonly string[];
  readonly fontsConf: string;
}

export interface LoggerSettings {
  readonly dir: string;
  readonly level: LogLevel;
  readonly secrets: boolean;
}


// Read the arguments. The server takes only --config-dir DIR. A relative path is relative to cwd.
// Each other argument is an error.
export function takeConfigDir(args: readonly string[], cwd: string = process.cwd()): { configDir: string } {
  let configDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--config-dir' && i + 1 < args.length) configDir = args[++i];
    else if (arg.startsWith('--config-dir=')) configDir = arg.slice('--config-dir='.length);
    else throw new Error(`unknown argument ${arg}. The server takes only --config-dir DIR.`);
  }
  if (!configDir) throw new Error('give the config folder with --config-dir DIR, e.g. --config-dir local/configs/browser-automation-x-mcp');
  return { configDir: path.resolve(cwd, configDir) };
}

// Paths of the libraries and fonts that playwright/src/setup/syslibs.js unpacks (Linux only).
export function syslibPaths(): SyslibPaths {
  const root = path.join(SYSLIBS_DIR, 'root');
  const triplet = LIB_TRIPLETS[process.arch] ?? `${process.arch}-linux-gnu`;
  const dirs = [path.join(root, 'usr', 'lib', triplet), path.join(root, 'lib', triplet)];
  return { root, libraryPath: dirs.join(':'), libraryDirs: dirs, fontsConf: path.join(SYSLIBS_DIR, 'fonts.conf') };
}

export function loggerOptions(env: Env = process.env): LoggerSettings {
  const level = env.BROWSER_AUTOMATION_X_MCP_LOG_LEVEL || 'info';
  return {
    dir: env.BROWSER_AUTOMATION_X_MCP_LOG_DIR || path.join(ASSETS_DIR, 'logs'),
    level: isLogLevel(level) ? level : 'info',
    secrets: env.BROWSER_AUTOMATION_X_MCP_LOG_SECRETS === '1',
  };
}

// The storage-state file of the workspace cwd: storage-state-<hash of cwd>.json.
// BROWSER_AUTOMATION_X_MCP_STORAGE_STATE gives an other file, e.g. for the tests.
export function stateFile(env: Env = process.env, cwd: string = process.cwd()): string {
  if (env.BROWSER_AUTOMATION_X_MCP_STORAGE_STATE) return env.BROWSER_AUTOMATION_X_MCP_STORAGE_STATE;
  const workspace = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return path.join(STATE_DIR, `storage-state-${workspace}.json`);
}

// The output files go to the workspace: the agent reads them.
export function outputDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.local_assets', 'browser-automation-x-mcp', 'output');
}

// The variables of Playwright MCP in env. The server does not use them.
export function ignoredVariables(env: Env = process.env): string[] {
  return Object.keys(env).filter((key) => key.startsWith('PLAYWRIGHT_MCP_')).sort();
}

// Give the variables that the server process needs before it loads Playwright.
// A default is set only when the user did not set the value in another way.
export function processEnv(env: Env = process.env, tmpDir: string | undefined = undefined): Record<string, string> {
  const result: Record<string, string> = {};
  result.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(ASSETS_DIR, 'browsers', PLATFORM);
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
    if (fs.existsSync(fontsConf)) result.FONTCONFIG_FILE = env.FONTCONFIG_FILE ?? fontsConf;
  }
  return result;
}

export const RENDER_MODES: readonly string[] = ['DEFAULT', 'HEADED_INVISIBLE', 'HEADED', 'HEADLESS'];

// Give the render mode of the browser: 'HEADED', 'HEADED_INVISIBLE' (headed on Xvfb) or 'HEADLESS'.
// RENDER_MODE selects it. HEADLESS comes only from the setting, never from a fallback.
// DEFAULT gives HEADED_INVISIBLE on WSL and on Linux without a display, else HEADED.
// HEADED without a display gives HEADED_INVISIBLE. Stop with an error if Xvfb is necessary and the
// OS has none.
export function renderMode(env: Env = process.env, platform: NodeJS.Platform = process.platform, wsl: boolean = isWsl(env, platform)): RenderMode {
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

export function isWsl(env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// The first folder with .git above the tool folder: the root of its repository. In a submodule,
// this is the root of the submodule, e.g. shared/.
function repoRoot(dir: string): string {
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
export async function tmpDirForChromium(candidates: readonly string[] = [TMP_DIR, REPO_TMP_DIR]): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const first = candidates[0];
    if (first) fs.mkdirSync(first, { recursive: true });
    return first;
  }
  for (const dir of [...new Set(candidates)]) {
    if (dir.length + CHROMIUM_SOCKET_SUFFIX > MAX_SOCKET_PATH) continue;
    if (await holdsSocket(dir)) return dir;
  }
  return undefined;
}

async function holdsSocket(dir: string): Promise<boolean> {
  fs.mkdirSync(dir, { recursive: true });
  const socket = path.join(dir, `probe-${process.pid}.sock`);
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    server.close();
    fs.rmSync(socket, { force: true });
  }
}
