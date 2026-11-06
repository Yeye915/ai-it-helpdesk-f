import nextEnv from '@next/env';
import { fileURLToPath } from 'node:url';

export function loadEnvironment() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  nextEnv.loadEnvConfig(root);
}
