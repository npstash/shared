#!/usr/bin/env node
// Entry point: the MCP server on stdio.
// --config-dir DIR gives the config folder. The server takes no other argument. See README.md.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loggerOptions, processEnv, takeConfigDir, tmpDirForChromium } from './config.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger(loggerOptions());

process.on('uncaughtException', (error) => {
  logger.open();
  logger.error('uncaught_error', { message: error.message, stack: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  logger.error('rejection_error', { message: String(error?.message ?? error), stack: error?.stack });
});

try {
  const { configDir } = takeConfigDir(process.argv.slice(2));
  // Playwright reads the folder of the browsers and the temp folder from the environment.
  // Thus set them before Playwright loads.
  const tmpDir = await tmpDirForChromium();
  Object.assign(process.env, processEnv(process.env, tmpDir));
  const { startServer } = await import('./mcp-server.js');
  const mcp = await startServer({
    configDir,
    logger,
    tmpDir,
    serverTransport: new StdioServerTransport(),
    onClose: () => process.exit(0),
  });
  // The stdio transport does not report the end of stdin. The client closes stdin to stop the server.
  process.stdin.on('end', () => mcp.close('stdin closed'));
  process.on('SIGINT', () => mcp.close('SIGINT'));
  process.on('SIGTERM', () => mcp.close('SIGTERM'));
} catch (error) {
  logger.open();
  logger.error('start_failed', { message: error.message, stack: error.stack });
  process.stderr.write(`browser-automation-x-mcp: ${error.message}\n`);
  process.exit(1);
}
