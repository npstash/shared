#!/usr/bin/env node
// Entry point: the MCP server on stdio.
// --config-dir DIR gives the config folder. Each other argument goes to Playwright MCP without a
// change. See README.md.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loggerOptions, takeConfigDir } from './config.js';
import { startServer } from './mcp-server.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger(loggerOptions());

process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', { message: error.message, stack: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandled_rejection', { message: String(error?.message ?? error), stack: error?.stack });
});

try {
  const { configDir, args } = takeConfigDir(process.argv.slice(2));
  const mcp = await startServer({
    args,
    configDir,
    logger,
    serverTransport: new StdioServerTransport(),
    // Without Playwright MCP the server has no tools. Stop, so that the client shows the failure.
    onClose: (reason) => process.exit(reason === 'upstream closed' ? 1 : 0),
  });
  // The stdio transport does not report the end of stdin. The client closes stdin to stop the server.
  process.stdin.on('end', () => mcp.close('stdin closed'));
  process.on('SIGINT', () => mcp.close('SIGINT'));
  process.on('SIGTERM', () => mcp.close('SIGTERM'));
} catch (error) {
  logger.error('start_failed', { message: error.message, stack: error.stack });
  process.stderr.write(`browser-automation-x-mcp: ${error.message}\n`);
  process.exit(1);
}
