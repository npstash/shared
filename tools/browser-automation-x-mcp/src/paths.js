// Paths that all facades share: the tool folder, the runtime files and the config files.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS_DIR = path.join(TOOL_DIR, '.local_assets');
export const PLATFORM = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;

// The code of the form-fill providers.
export const PROVIDERS_DIR = path.join(TOOL_DIR, 'providers-form-fill');

// The config files are in the config folder that the argument --config-dir gives, e.g.
// local/configs/browser-automation-x-mcp of the repository. The tool folder has a template of each file.
//   facade.ini            fill provider order, masks, host recording   config/facade.template.ini
//   fields.ini            form fields for each URL pattern             config/fields.template.ini
//   host-policy.ini       deny-list and allow-list of hosts            config/host-policy.template.ini
//   <facade>-tools.ini    tool switches of one facade                  <facade>/config/tools.template.ini
//   provider-<name>.ini   config of one form-fill provider             providers-form-fill/<name>/config.template.ini
export const CONFIG_TEMPLATES = {
  'facade.ini': path.join(TOOL_DIR, 'config', 'facade.template.ini'),
  'host-policy.ini': path.join(TOOL_DIR, 'config', 'host-policy.template.ini'),
  'fields.ini': path.join(TOOL_DIR, 'config', 'fields.template.ini'),
};

// The path of a config file. A missing file is first a copy of its template.
export function configFile(configDir, name, template = CONFIG_TEMPLATES[name]) {
  const file = path.join(configDir, name);
  if (!fs.existsSync(file) && template && fs.existsSync(template)) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.copyFileSync(template, file);
  }
  return file;
}
