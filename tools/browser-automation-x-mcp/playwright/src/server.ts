#!/usr/bin/env node
// Entry point: the MCP server on stdio.
// --config-dir DIR gives the config folder. The server takes no other argument. See README.md.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loggerOptions, processEnv, takeConfigDir, tmpDirForChromium } from './config.ts';
import { errorMessage } from '../../src/json.ts';
import { FileLogger } from '../../src/logger.ts';

const logger = new FileLogger(loggerOptions());

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

process.on('uncaughtException', (error) => {
  logger.open();
  logger.error('uncaught_error', { message: error.message, stack: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (error: unknown) => {
  logger.error('rejection_error', { message: errorMessage(error), stack: stackOf(error) });
});

try {
  const { configDir } = takeConfigDir(process.argv.slice(2));
  // Playwright reads the folder of the browsers and the temp folder from the environment.
  // Thus set them before Playwright loads.
  const tmpDir = await tmpDirForChromium();
  Object.assign(process.env, processEnv(process.env, tmpDir));
  const { startServer } = await import('./mcp-server.ts');
  const mcp = await startServer({
    configDir,
    logger,
    tmpDir,
    serverTransport: new StdioServerTransport(),
    onClose: () => process.exit(0),
  });
  // The stdio transport does not report the end of stdin. The client closes stdin to stop the server.
  process.stdin.on('end', () => { void mcp.close('stdin closed'); });
  process.on('SIGINT', () => { void mcp.close('SIGINT'); });
  process.on('SIGTERM', () => { void mcp.close('SIGTERM'); });
} catch (error) {
  logger.open();
  logger.error('start_failed', { message: errorMessage(error), stack: stackOf(error) });
  process.stderr.write(`browser-automation-x-mcp: ${errorMessage(error)}\n`);
  process.exit(1);
}
