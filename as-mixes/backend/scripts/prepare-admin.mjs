import { mkdir, copyFile } from 'node:fs/promises';
const target = new URL('../admin/assets/', import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(new URL('../../dist/assets/styles.css', import.meta.url), new URL('site.css', target));
console.log('Admin uses the existing site stylesheet.');
