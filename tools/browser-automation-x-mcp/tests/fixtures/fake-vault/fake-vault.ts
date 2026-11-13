// Test double of maya/tools/auth/run.sh: "get-system NAME" and "get-secret NAME KEY" on vault.json.
// FAKE_VAULT_LOG: a file that gets the arguments of each call, one JSON line each.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.env.FAKE_VAULT_LOG) fs.appendFileSync(process.env.FAKE_VAULT_LOG, JSON.stringify(args) + '\n');
// One system of vault.json.
interface FakeSystem {
  readonly url?: string;
  readonly credentials: Record<string, string>;
}

const options: Record<string, string | undefined> = {};
while (args[0]?.startsWith('--')) options[args.shift() ?? ''] = args.shift();
const vault = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault.json'), 'utf8')) as Record<string, FakeSystem>;
const [command, name = '', secret = ''] = args;
const system = vault[name];

if (!system) {
  process.stderr.write(`error: unknown system '${name}'\n`);
  process.exit(1);
} else if (command === 'get-system') {
  process.stdout.write(`${name}\t${system.url ?? '-'}\t${Object.keys(system.credentials).join(',') || '-'}\n`);
} else if (command === 'get-secret' && system.credentials[secret] !== undefined) {
  process.stdout.write(`${system.credentials[secret]}\n`);
} else {
  process.stderr.write(`fake vault: no ${secret} in ${name}\n`);
  process.exit(2);
}
