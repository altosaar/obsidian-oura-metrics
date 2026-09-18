// Copy the built plugin into a local Obsidian vault for testing.
//
// Vault location comes from the OBSIDIAN_VAULT env var, or a gitignored `.vault-path`
// file at the repo root (one line: the absolute path to your vault). We deliberately do
// NOT commit any vault path — this repo is public-bound.
//
// If the gitignored `.env` sets OURA_CLIENT_ID, it is written into the plugin's saved
// settings (data.json) so it needn't be pasted by hand. Nothing else is read from `.env`:
// the client secret stays out of the vault, since the plugin's flow doesn't use it.
//
// Usage:  npm run install:vault   (runs the build first)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveVault() {
	const fromEnv = process.env.OBSIDIAN_VAULT?.trim();
	if (fromEnv) return fromEnv;
	const pathFile = join(repoRoot, '.vault-path');
	if (existsSync(pathFile)) {
		const p = readFileSync(pathFile, 'utf8').trim();
		if (p) return p;
	}
	console.error(
		'No vault configured. Set OBSIDIAN_VAULT=/path/to/vault, or create a .vault-path\n' +
			'file at the repo root containing the absolute path to your vault.',
	);
	process.exit(1);
}

/** One key from a dotenv file: `KEY=value`, optionally quoted; `#` lines are comments. */
function readEnvValue(path, key) {
	if (!existsSync(path)) return undefined;
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (match?.[1] !== key) continue;
		const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
		return value || undefined;
	}
	return undefined;
}

const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
const vault = resolveVault();
if (!existsSync(join(vault, '.obsidian'))) {
	console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
	process.exit(1);
}

const dest = join(vault, '.obsidian', 'plugins', manifest.id);
mkdirSync(dest, { recursive: true });
for (const file of ['manifest.json', 'main.js', 'styles.css']) {
	copyFileSync(join(repoRoot, file), join(dest, file));
}
console.log(`Installed "${manifest.name}" (${manifest.id}) → ${dest}`);

const clientId = readEnvValue(join(repoRoot, '.env'), 'OURA_CLIENT_ID');
if (clientId) {
	// Merge rather than overwrite: data.json also holds the access token and every other setting.
	const dataPath = join(dest, 'data.json');
	const data = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : {};
	if (data.clientId === clientId) {
		console.log('Client ID from .env already set.');
	} else {
		data.clientId = clientId;
		writeFileSync(dataPath, JSON.stringify(data, null, 2));
		console.log('Set the client ID from .env in the plugin settings.');
	}
}
console.log('Reload Obsidian (or "Reload app without saving") to pick up the change.');
