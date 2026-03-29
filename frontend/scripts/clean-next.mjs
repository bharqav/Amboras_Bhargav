import { rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const rel of ['.next', join('node_modules', '.cache')]) {
  try {
    rmSync(join(root, rel), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
console.log('Removed .next (and node_modules/.cache if present).');
