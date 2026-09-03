#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

export function runSaturdayDrill(options = {}) {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };

  const args = [
    '--filter',
    '@uttily/core',
    'test',
    'src/integration/saturday-drill.integration.test.ts',
    ...(options.extraArgs ?? []),
  ];

  return spawnSync('pnpm', args, {
    stdio: options.stdio ?? 'inherit',
    env,
  });
}

if (process.argv[1] && process.argv[1].endsWith('saturday-drill.mjs')) {
  console.log('🚲 Lancement de la simulation Drill "Samedi Type" (Lot 21-S1)...');
  const result = runSaturdayDrill();
  process.exit(result.status ?? 0);
}
