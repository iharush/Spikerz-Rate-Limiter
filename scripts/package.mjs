import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

mkdirSync('output', { recursive: true });
rmSync('output/spikerz-rate-limiter.zip', { force: true });
const result = spawnSync(
  'zip',
  [
    '-r',
    'output/spikerz-rate-limiter.zip',
    'README.md',
    'DESIGN.md',
    'package.json',
    'package-lock.json',
    'tsconfig.server.json',
    'jest.config.cjs',
    '.gitignore',
    '.dockerignore',
    '.env.example',
    '.prettierrc.json',
    '.prettierignore',
    'Dockerfile',
    'docker-compose.yml',
    'apps',
    'packages',
    'infra',
    'scripts',
    'tests',
    '-x',
    '*/node_modules/*',
    '*/dist/*',
    '*/.DS_Store',
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) throw new Error('zip failed; install the zip command and retry');
