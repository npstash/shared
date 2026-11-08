// Paths of the tool folder, the runtime files and the config files.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS_DIR: string = path.join(TOOL_DIR, '.local_assets');
export const PLATFORM: string = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;

// The code of the form-fill providers.
export const PROVIDERS_DIR: string = path.join(TOOL_DIR, 'providers-form-fill');

// The config files are in the config folder that the argument --config-dir gives, e.g.
// local/configs/browser-automation-x-mcp of the repository. The tool folder has a template of each file.
//   server.json   providers and tool switches (src/server-config.ts)   config/server.template.json
//   sites.json    access, provider-config and pages of sites (src/sites.ts) config/sites.template.json
export const SERVER_CONFIG: string = 'server.json';
export const SITES_CONFIG: string = 'sites.json';
export const CONFIG_TEMPLATES: Readonly<Record<string, string>> = {
  [SERVER_CONFIG]: path.join(TOOL_DIR, 'config', 'server.template.json'),
  [SITES_CONFIG]: path.join(TOOL_DIR, 'config', 'sites.template.json'),
};

// The path of a config file. A missing file is first a copy of its template.
export function configFile(configDir: string, name: string, template: string | undefined = CONFIG_TEMPLATES[name]): string {
  const file = path.join(configDir, name);
  if (!fs.existsSync(file) && template && fs.existsSync(template)) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.copyFileSync(template, file);
  }
  return file;
}
