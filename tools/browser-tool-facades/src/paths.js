// Paths that all facades share: the tool folder, the runtime files and the shared config.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS_DIR = path.join(TOOL_DIR, '.local_assets');
export const PLATFORM = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;

// The shared config of the facades. Tests point the env variables to copies.
//   config           facade.ini (fill provider order, host recording), hosts.ini (host list)
//   providers        the code of the form-fill providers
//   providersConfig  the config.ini of each form-fill provider
export function sharedConfigDirs(env = process.env) {
  const providers = path.join(TOOL_DIR, 'providers-form-fill');
  return {
    config: env.BROWSER_FACADES_CONFIG_DIR || path.join(TOOL_DIR, 'config'),
    providers,
    providersConfig: env.BROWSER_FACADES_PROVIDERS_CONFIG_DIR || providers,
  };
}
