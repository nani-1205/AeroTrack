#!/usr/bin/env node
// One-time local setup:
//   1. config/services.json + config/gateway.json from the *.example.json templates,
//      with every "CHANGE_ME" replaced by a random secret (existing files are NEVER overwritten).
//   2. RSA key pair for JWT signing in config/keys/ (skipped if present).
//   3. .env for docker-compose, derived from config/services.json.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncComposeEnv } from './sync-compose-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configDir = path.join(root, 'config');
const PLACEHOLDER = 'CHANGE_ME';

const secret = (bytes = 24) => randomBytes(bytes).toString('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });

/** Recursively replace every placeholder string with a fresh random secret. */
function fillPlaceholders(node) {
  if (Array.isArray(node)) return node.map(fillPlaceholders);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillPlaceholders(v)]));
  }
  return node === PLACEHOLDER ? secret() : node;
}

let generatedAdminPassword = null;

// --- 1a. services.json -------------------------------------------------------
const servicesPath = path.join(configDir, 'services.json');
if (existsSync(servicesPath)) {
  console.log('• config/services.json exists — leaving it untouched');
} else {
  const services = fillPlaceholders(readJson(path.join(configDir, 'services.example.json')));
  generatedAdminPassword = services.auth.admin.bootstrapPassword;
  writeJson(servicesPath, services);
  console.log('✔ created config/services.json');
}
const services = readJson(servicesPath);

// --- 1b. gateway.json (shares redis password + internal token with services.json) ---
const gatewayPath = path.join(configDir, 'gateway.json');
if (existsSync(gatewayPath)) {
  console.log('• config/gateway.json exists — leaving it untouched');
} else {
  const gateway = readJson(path.join(configDir, 'gateway.example.json'));
  gateway.redis = { ...gateway.redis, ...services.shared.redis };
  gateway.internalToken = services.shared.internalToken;
  gateway.jwt.issuer = services.shared.jwt.issuer;
  gateway.jwt.userAudience = services.shared.jwt.userAudience;
  gateway.jwt.adminAudience = services.shared.jwt.adminAudience;
  writeJson(gatewayPath, fillPlaceholders(gateway));
  console.log('✔ created config/gateway.json');
}

// --- 2. JWT signing keys -----------------------------------------------------
const privPath = path.resolve(configDir, services.auth.jwtPrivateKeyPath);
const pubPath = path.resolve(configDir, services.auth.jwtPublicKeyPath);
if (existsSync(privPath) && existsSync(pubPath)) {
  console.log('• JWT keys exist — leaving them untouched');
} else {
  mkdirSync(path.dirname(privPath), { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(privPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath, publicKey);
  console.log(`✔ generated JWT key pair in ${path.relative(root, path.dirname(privPath))}/`);
}

// --- 3. docker-compose .env --------------------------------------------------
syncComposeEnv();

if (generatedAdminPassword) {
  console.log('\nBootstrap admin credentials (shown once — also stored in config/services.json):');
  console.log(`  username: ${services.auth.admin.bootstrapUsername}`);
  console.log(`  password: ${generatedAdminPassword}`);
}
console.log('\nNext: add your GitHub OAuth app clientId/clientSecret to config/services.json → auth.github');
