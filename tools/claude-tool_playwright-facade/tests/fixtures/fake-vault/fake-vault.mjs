// Test double of shared/tools/auth/run.sh: "list" and "get NAME --secret KEY" on vault.json.
// FAKE_VAULT_LOG: a file that gets the arguments of each call, one JSON line each.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.env.FAKE_VAULT_LOG) fs.appendFileSync(process.env.FAKE_VAULT_LOG, JSON.stringify(args) + '\n');
const options = {};
while (args[0]?.startsWith('--')) options[args.shift()] = args.shift();
const vault = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault.json'), 'utf8'));
const [command, name, flag, secret] = args;

if (command === 'list') {
  for (const [system, entry] of Object.entries(vault)) {
    process.stdout.write(`${system}\t${entry.url ?? '-'}\t${Object.keys(entry.credentials).join(',') || '-'}\n`);
  }
} else if (command === 'get' && flag === '--secret' && vault[name]?.credentials[secret] !== undefined) {
  process.stdout.write(`${vault[name].credentials[secret]}\n`);
} else {
  process.stderr.write(`fake vault: no ${secret} in ${name}\n`);
  process.exit(2);
}
