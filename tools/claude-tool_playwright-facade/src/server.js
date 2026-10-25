#!/usr/bin/env node
// Entry point: the Playwright facade as an MCP server on stdio.
// Each argument goes to Playwright MCP without a change. See README.md.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loggerOptions } from './config.js';
import { startFacade } from './facade.js';
import { createLogger } from './logger.js';

const args = process.argv.slice(2);
const logger = createLogger(loggerOptions());

process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', { message: error.message, stack: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandled_rejection', { message: String(error?.message ?? error), stack: error?.stack });
});

try {
  const facade = await startFacade({
    args,
    logger,
    serverTransport: new StdioServerTransport(),
    // Without Playwright MCP the facade has no tools. Stop, so that the client shows the failure.
    onClose: (reason) => process.exit(reason === 'upstream closed' ? 1 : 0),
  });
  // The stdio transport does not report the end of stdin. The client closes stdin to stop the server.
  process.stdin.on('end', () => facade.close('stdin closed'));
  process.on('SIGINT', () => facade.close('SIGINT'));
  process.on('SIGTERM', () => facade.close('SIGTERM'));
} catch (error) {
  logger.error('start_failed', { message: error.message, stack: error.stack });
  process.stderr.write(`playwright-facade: ${error.message}\n`);
  process.exit(1);
}
