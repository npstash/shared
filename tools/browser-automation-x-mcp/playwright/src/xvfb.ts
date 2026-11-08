// Xvfb: a virtual display for a headed browser on a Linux host without a display.
// playwright/src/setup/syslibs.js unpacks Xvfb into the tool folder. No root.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syslibPaths } from './config.ts';
import { errorMessage } from '../../src/json.ts';
import type { Logger } from '../../src/logger.ts';
import { ASSETS_DIR } from '../../src/paths.ts';

// A running Xvfb.
export interface XvfbDisplay {
  // The display, e.g. ":99".
  readonly display: string;
  // Stop Xvfb.
  stop(): void;
}

// Starts a virtual display for the lanes.
export interface DisplayStarter {
  start(): Promise<XvfbDisplay>;
}

export interface XvfbPaths {
  readonly usr: string;
  readonly binary: string;
  readonly xkbcomp: string;
  readonly xkbDir: string;
  readonly libraryPath: string;
}

// The PID and the start time of a process.
interface ProcessId {
  readonly pid: number | undefined;
  readonly start: string | undefined;
}

// The record of one Xvfb in XVFB_DIR.
interface XvfbRecord {
  readonly display: string;
  readonly server?: ProcessId;
  readonly xvfb?: ProcessId;
}

export interface StartOptions {
  readonly logger: Logger;
  readonly timeout?: number;
}

export const XVFB_SCREEN: string = '1920x1080x24';
export const XVFB_START_TIMEOUT: number = 10000;
// The first display number, as in xvfb-run. Lower numbers belong to real displays, e.g. WSLg :0.
export const XVFB_FIRST_DISPLAY: number = 99;
export const XVFB_DISPLAY_TRIES: number = 20;
export const XVFB_PACKAGES: readonly string[] = ['xvfb', 'xserver-common', 'x11-xkb-utils', 'xkb-data'];
// One file for each running Xvfb: <display number>.json with the PID and start time of the server
// and of Xvfb. It finds the Xvfb of a server that stopped without a cleanup (e.g. SIGKILL).
export const XVFB_DIR: string = path.join(ASSETS_DIR, 'xvfb');
// setpriv (util-linux) sets the parent-death signal: the kernel kills Xvfb when the server stops.
const SETPRIV: string | undefined = ['/usr/bin/setpriv', '/bin/setpriv'].find((file) => fs.existsSync(file));

// Xvfb runs "<XkbBinDirectory>/xkbcomp". The package sets /usr/bin, and the tool folder has no
// file there. The patch sets ./bin. Xvfb starts in <root>/usr, thus it finds <root>/usr/bin/xkbcomp.
const XKB_BIN_DIR: Buffer = Buffer.from('\0/usr/bin\0');
const XKB_BIN_DIR_PATCHED: Buffer = Buffer.from('\0./bin\0\0\0\0');

export function xvfbPaths(): XvfbPaths {
  const { root, libraryPath } = syslibPaths();
  const usr = path.join(root, 'usr');
  return { usr, binary: path.join(usr, 'bin', 'Xvfb'), xkbcomp: path.join(usr, 'bin', 'xkbcomp'), xkbDir: path.join(usr, 'share', 'X11', 'xkb'), libraryPath };
}

// Give the binary with the patched path of xkbcomp. A binary that has the patch stays the same.
// Stop with an error if the binary does not have the path exactly one time.
export function patchXkbBinDir(binary: Buffer): Buffer {
  const count = occurrences(binary, XKB_BIN_DIR);
  if (count === 0 && occurrences(binary, XKB_BIN_DIR_PATCHED) === 1) return binary;
  if (count !== 1) throw new Error(`Xvfb has the path /usr/bin ${count} times, not 1. The patch of the xkbcomp path is not possible.`);
  const index = binary.indexOf(XKB_BIN_DIR);
  return Buffer.concat([binary.subarray(0, index), XKB_BIN_DIR_PATCHED, binary.subarray(index + XKB_BIN_DIR.length)]);
}

function occurrences(buffer: Buffer, part: Buffer): number {
  let count = 0;
  for (let index = buffer.indexOf(part); index !== -1; index = buffer.indexOf(part, index + 1)) count++;
  return count;
}

// Start Xvfb. Give the display (e.g. ":99") and a function that stops Xvfb.
// Xvfb listens only on the abstract socket of Linux: a folder /tmp/.X11-unix of an other user
// (e.g. WSLg) does not stop it. A display that has a socket or a lock file is skipped.
export async function startXvfb({ logger, timeout = XVFB_START_TIMEOUT }: StartOptions): Promise<XvfbDisplay> {
  if (process.platform !== 'linux') throw new Error('Xvfb needs Linux.');
  const paths = xvfbPaths();
  if (!fs.existsSync(paths.binary)) throw new Error(`Xvfb is not in ${paths.binary}. Run "run.sh install".`);
  const errors: string[] = [];
  for (let number = XVFB_FIRST_DISPLAY, tries = 0; tries < XVFB_DISPLAY_TRIES; number++) {
    if (displayInUse(number)) continue;
    tries++;
    try {
      return await startOn(number, paths, logger, timeout);
    } catch (error) {
      // An other process can take the display at the same time. Try the next one.
      errors.push(errorMessage(error));
    }
  }
  throw new Error(`Xvfb did not start on ${XVFB_DISPLAY_TRIES} displays from :${XVFB_FIRST_DISPLAY}.\n${errors.at(-1) ?? ''}`);
}

// Kill the Xvfb of each server that does not run. Keep the Xvfb of the servers that run.
// A PID with an other start time is an other process. Kill only the Xvfb of the tool folder.
export function cleanStaleXvfb(logger: Logger): void {
  if (process.platform !== 'linux' || !fs.existsSync(XVFB_DIR)) return;
  const binary = realPath(xvfbPaths().binary);
  for (const name of fs.readdirSync(XVFB_DIR).filter((file) => file.endsWith('.json'))) {
    const file = path.join(XVFB_DIR, name);
    let entry: XvfbRecord | undefined;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8')) as XvfbRecord;
    } catch {
      entry = undefined;
    }
    if (entry && isRunning(entry.server)) continue;
    const xvfb = entry?.xvfb;
    if (entry && xvfb?.pid && isRunning(xvfb) && realPath(`/proc/${xvfb.pid}/exe`) === binary) {
      try {
        process.kill(xvfb.pid, 'SIGKILL');
      } catch {
        // It stopped after the check.
      }
      logger.info('xvfb_stale_killed', { display: entry.display, pid: xvfb.pid, server: entry.server?.pid });
    }
    fs.rmSync(file, { force: true });
  }
}

// Give the start time of a process (field 22 of /proc/<pid>/stat), or undefined.
export function processStart(pid: number | undefined): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

function isRunning(proc: ProcessId | undefined): boolean {
  return Boolean(proc?.pid) && processStart(proc?.pid) === proc?.start;
}

function realPath(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

function displayInUse(number: number): boolean {
  const socket = `/tmp/.X11-unix/X${number}`;
  if (fs.existsSync(socket) || fs.existsSync(`/tmp/.X${number}-lock`)) return true;
  try {
    return fs.readFileSync('/proc/net/unix', 'utf8').split('\n').some((line) => line.endsWith(` @${socket}`));
  } catch {
    return false;
  }
}

async function startOn(number: number, paths: XvfbPaths, logger: Logger, timeout: number): Promise<XvfbDisplay> {
  // With a display number, -displayfd writes the number when Xvfb is ready.
  const xvfbArgs = ['./bin/Xvfb', `:${number}`, '-displayfd', '3', '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp', '-nolisten', 'unix', '-xkbdir', paths.xkbDir];
  if (!SETPRIV) logger.info('xvfb_no_setpriv', { message: 'setpriv is not installed. After a SIGKILL of the server, the next server start kills Xvfb.' });
  // setpriv runs Xvfb with exec: the PID stays the same.
  const [command = '', ...args] = SETPRIV ? [SETPRIV, '--pdeathsig', 'KILL', '--', ...xvfbArgs] : xvfbArgs;
  const child = spawn(command, args, {
    cwd: paths.usr,
    env: { ...process.env, LD_LIBRARY_PATH: [paths.libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', (text: string) => {
    for (const line of text.split('\n').filter(Boolean)) {
      stderr.push(line);
      logger.debug('xvfb_stderr', { line });
    }
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => fail(`Xvfb did not start on :${number} in ${timeout} ms.`), timeout);
    function fail(message: string): void {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(`${message}\n${stderr.slice(-10).join('\n')}`));
    }
    const ready = child.stdio[3] as NodeJS.ReadableStream | null;
    ready?.setEncoding('utf8');
    ready?.on('data', (text: string) => {
      output += text;
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve();
    });
    child.once('error', (error) => fail(`Xvfb did not start: ${error.message}`));
    child.once('exit', (code, signal) => fail(`Xvfb stopped on :${number}: ${signal ?? `exit code ${code}`}.`));
  });
  const display = `:${number}`;
  const file = path.join(XVFB_DIR, `${number}.json`);
  const entry = { display, server: { pid: process.pid, start: processStart(process.pid) }, xvfb: { pid: child.pid, start: processStart(child.pid) } };
  fs.mkdirSync(XVFB_DIR, { recursive: true });
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(entry));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  logger.info('xvfb_started', { display, pid: child.pid, screen: XVFB_SCREEN, pdeathsig: Boolean(SETPRIV) });

  // Stop Xvfb also when the server process stops without close().
  const kill = (): void => {
    child.kill('SIGTERM');
    fs.rmSync(file, { force: true });
  };
  process.once('exit', kill);
  const stop = (): void => {
    process.removeListener('exit', kill);
    if (child.exitCode === null && child.signalCode === null) kill();
    else fs.rmSync(file, { force: true });
  };
  return { display, stop };
}

// Starts Xvfb for the lanes of a server.
export class XvfbStarter implements DisplayStarter {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  start(): Promise<XvfbDisplay> {
    return startXvfb({ logger: this.logger });
  }
}
