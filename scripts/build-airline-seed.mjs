#!/usr/bin/env node
// Regenerates services/tracking-service/seed/airlines.csv from the OpenFlights airline database.
// Data: © OpenFlights contributors, Open Database License (ODbL) 1.0 — https://openflights.org/data
//
//   node scripts/build-airline-seed.mjs                 # download from OpenFlights
//   node scripts/build-airline-seed.mjs path/to/airlines.dat
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'services', 'tracking-service', 'seed', 'airlines.csv');

/** Parses one OpenFlights CSV line (double-quoted fields, \N for null). */
function parseLine(line) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  fields.push(cur);
  return fields.map((f) => (f === '\\N' ? '' : f.trim()));
}

const csvField = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const raw = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await (await fetch(SOURCE)).text();

const byIcao = new Map();
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [id, name, , iata, icao, callsign, country, active] = parseLine(line);
  if (!/^[A-Z]{3}$/.test(icao) || !name || /^(unknown|private flight)$/i.test(name)) continue;
  const row = {
    id: Number(id),
    icao,
    iata: /^[A-Z0-9]{2}$/.test(iata) ? iata : '',
    name,
    callsign: callsign.toUpperCase(),
    country,
    active: active === 'Y',
  };
  const prev = byIcao.get(icao);
  // Several rows can share an ICAO code: prefer the active one, then the oldest entry.
  if (!prev || (row.active && !prev.active) || (row.active === prev.active && row.id < prev.id)) {
    byIcao.set(icao, row);
  }
}

const rows = [...byIcao.values()].sort((a, b) => a.icao.localeCompare(b.icao));
const lines = [
  'icao,iata,name,callsign,country,active',
  ...rows.map((r) => [r.icao, r.iata, r.name, r.callsign, r.country, r.active ? 'Y' : 'N'].map(csvField).join(',')),
];
writeFileSync(out, lines.join('\n') + '\n');
console.log(`✔ wrote ${rows.length} airlines (${rows.filter((r) => r.active).length} active) → ${path.relative(root, out)}`);
