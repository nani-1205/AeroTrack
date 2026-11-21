#!/usr/bin/env node
// Adds keys introduced by newer phases to existing local config files WITHOUT touching
// secrets or values you already set. Template (*.example.json) values fill only what is missing.
// Safe to run repeatedly. Prints key names only, never values.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
const PLACEHOLDER = 'CHANGE_ME';

/** Deep-merge: add keys from `template` missing in `target`. Arrays of route objects merge by `prefix`. */
function addMissing(target, template, trail, added) {
  for (const [key, tVal] of Object.entries(template)) {
    const here = [...trail, key].join('.');
    if (!(key in target)) {
      if (tVal === PLACEHOLDER) continue; // never invent secrets here — run setup for fresh files
      target[key] = tVal;
      added.push(here);
    } else if (key === 'routes' && Array.isArray(tVal) && Array.isArray(target[key])) {
      for (const route of tVal) {
        const existing = target[key].find((r) => r.prefix === route.prefix);
        if (!existing) {
          target[key].push(route);
          added.push(`${here}[${route.prefix}]`);
        } else {
          addMissing(existing, route, [`${here}[${route.prefix}]`], added);
        }
      }
    } else if (tVal && typeof tVal === 'object' && !Array.isArray(tVal) && typeof target[key] === 'object') {
      addMissing(target[key], tVal, [...trail, key], added);
    }
  }
}

for (const name of ['services', 'gateway']) {
  const file = path.join(configDir, `${name}.json`);
  if (!existsSync(file)) {
    console.log(`• config/${name}.json not found — run \`npm run setup\``);
    continue;
  }
  const target = JSON.parse(readFileSync(file, 'utf8'));
  const template = JSON.parse(readFileSync(path.join(configDir, `${name}.example.json`), 'utf8'));
  const added = [];
  addMissing(target, template, [], added);
  if (added.length === 0) {
    console.log(`• config/${name}.json already up to date`);
    continue;
  }
  writeFileSync(file, JSON.stringify(target, null, 2) + '\n', { mode: 0o600 });
  console.log(`✔ config/${name}.json: added ${added.join(', ')}`);
}
