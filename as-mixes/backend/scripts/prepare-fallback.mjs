// Offline only. Copies the current reviewed website, never local secrets or audio.
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function prepareFallback() {
  const backend = fileURLToPath(new URL('../', import.meta.url));
  const source = path.resolve(backend, '../dist');
  const output = path.join(backend, 'build/fallback');
  function inspect(directory, root = directory, files = []) {
    for (const name of readdirSync(directory)) {
      const filename = path.join(directory, name), stat = lstatSync(filename);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) || /^(?:\.env|\.dev\.vars|backend$|node_modules$|\.git$|\.wrangler$|uploads$)/i.test(name) || /\.(?:pem|key|p12|pfx|mp3|wav|flac|aiff?|ogg|m4a|aac)$/i.test(name)) throw new Error('Unsafe fallback input.');
      if (stat.isDirectory()) inspect(filename, root, files);
      else files.push(path.relative(root, filename));
    }
    return files.sort();
  }
  const sourceFiles = inspect(source);
  mkdirSync(output, { recursive: true });
  cpSync(source, path.join(output, 'site'), { recursive: true });
  if (JSON.stringify(inspect(path.join(output, 'site'))) !== JSON.stringify(sourceFiles)) throw new Error('Stale fallback files detected; use a clean reviewed checkout.');
  const htmlPath = path.join(output, 'site/index.html');
  writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace("Send your project details directly through this form. I'll get back to you by email.", 'Please email contact@asmixes.com directly. The contact form is temporarily unavailable.'));
  const configPath = path.join(output, 'site/assets/portfolio-config.js');
  const config = readFileSync(configPath, 'utf8');
  if (!/turnstileSiteKey:\s*'[^']+'/.test(config)) throw new Error('Expected public site key.');
  writeFileSync(configPath, config.replace(/turnstileSiteKey:\s*'[^']+'/, 'turnstileSiteKey: null'));
  const wrangler = JSON.parse(readFileSync(path.join(backend, 'wrangler.public.jsonc'), 'utf8'));
  wrangler.main = '../../src/fallback.mjs';
  for (const database of wrangler.d1_databases) database.migrations_dir = '../../migrations';
  writeFileSync(path.join(output, 'wrangler.json'), JSON.stringify(wrangler, null, 2) + '\n');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareFallback();
  console.log('Offline fallback prepared in build/fallback; nothing deployed.');
}
