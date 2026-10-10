// Offline heuristic scan. Never prints matched values or reads local secret files.
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const credentials = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:re_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,})\b/;
const publicEmails = new Set(['contact@asmixes.com', 'you@yourband.com']);
let count = 0;
function inspect(directory, website) {
  for (const name of readdirSync(directory)) {
    const filename = path.join(directory, name), stat = lstatSync(filename);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Linked artifact rejected.');
    if (/^(?:\.env|\.dev\.vars|node_modules$|\.git$|\.wrangler$|uploads$)/i.test(name) || /\.(?:pem|key|p12|pfx|mp3|wav|flac|aiff?|ogg|m4a|aac)$/i.test(name) || (website && name === 'backend')) throw new Error('Private artifact filename rejected.');
    if (stat.isDirectory()) { inspect(filename, website); continue; }
    const text = readFileSync(filename, 'utf8');
    if (credentials.test(text) || text.includes('hello@example.com')) throw new Error('Credential or obsolete contact placeholder detected.');
    for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
      if (!publicEmails.has(email)) throw new Error('Unexpected email address in artifact.');
    }
    count++;
  }
}
for (const [relative, website] of [['../../dist', true], ['../build/fallback/site', true], ['../build/public', false], ['../build/admin', false], ['../build/fallback/worker', false]]) {
  inspect(fileURLToPath(new URL(relative, import.meta.url)), website);
}
console.log(`Artifact scan passed (${count} files): no detected credential patterns, private email addresses, audio or environment files.`);
