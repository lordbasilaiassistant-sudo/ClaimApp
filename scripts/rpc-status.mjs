#!/usr/bin/env node
// scripts/rpc-status.mjs
//
// Print the current RPC provider state from scan-results/rpc-state.json:
//   - which providers are active
//   - which are auto-disabled (failed in 2+ runs)
//   - per-provider success/failure tally
//
// To recover an auto-disabled provider, edit scan-results/rpc-state.json
// (set its `disabled: false` and clear `failedRuns`), or just delete the
// file to reset everything.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { BASE_PROVIDERS } = await import(`file://${ROOT}/src/services/rpc/providers.js`);
const statePath = resolve(ROOT, 'scan-results/rpc-state.json');
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { providers: {} };

console.log('=== RPC provider status ===\n');
console.log(
  `${'name'.padEnd(20)}${'tier'.padEnd(8)}${'status'.padEnd(11)}${'ok'.padEnd(8)}${'fail-runs'.padEnd(11)}url`,
);
console.log('-'.repeat(110));

for (const provider of BASE_PROVIDERS) {
  const s = state.providers[provider.name] || {};
  const tier = provider.maxLogBlockRange >= 100_000 ? 'large' : 'small';
  const status = s.disabled ? 'DISABLED' : 'active';
  const ok = s.successRuns || 0;
  const failRuns = (s.failedRuns || []).length;
  console.log(
    `${provider.name.padEnd(20)}${tier.padEnd(8)}${status.padEnd(11)}${String(ok).padEnd(8)}${String(failRuns).padEnd(11)}${provider.url}`,
  );
}

const disabled = Object.entries(state.providers).filter(([, v]) => v.disabled);
if (disabled.length > 0) {
  console.log(`\n${disabled.length} provider(s) auto-disabled:`);
  for (const [name, v] of disabled) {
    console.log(`  ${name}  last-failure=${v.lastFailureAt}  fail-runs=${v.failedRuns.length}`);
  }
  console.log('\nTo re-enable, edit scan-results/rpc-state.json or delete it to reset all state.');
}
