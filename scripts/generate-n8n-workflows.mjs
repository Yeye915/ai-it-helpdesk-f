import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeLocalWorkflow } from './local-workflows.mjs';
import { writeOptimizedWorkflow } from './optimized-workflows.mjs';

const outDir = fileURLToPath(new URL('../n8n-workflows/', import.meta.url));
const all = Array.from({ length: 9 }, (_, index) => `WF${String(index + 1).padStart(2, '0')}`);
const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice(7).split(',') || all;
if (!only.length || only.some((id) => !all.includes(id))) throw new Error('Unknown workflow in --only');
await mkdir(outDir, { recursive: true });
for (const id of [...new Set(only)]) {
  if (Number(id.slice(2)) <= 6) await writeLocalWorkflow(id, outDir);
  else await writeOptimizedWorkflow(id, outDir);
}
console.log(`Generated ${new Set(only).size} workflows; WF07-WF09 each have exactly 12 nodes.`);
