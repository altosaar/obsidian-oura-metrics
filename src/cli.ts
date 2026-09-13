/**
 * Headless Oura summary — the same note the ribbon icon writes, without Obsidian.
 *
 * Exists so an automated weekly pipeline can produce the note unattended. It is
 * deliberately a thin shell around the very same `buildDays` and `renderNote`
 * the plugin calls: if the metric selection or the rendering ever diverged
 * between the app and the CLI, the note that reaches a model would stop being
 * the note you reviewed by eye, which is the whole basis for trusting it.
 *
 * The only thing it reimplements is the HTTP call, because Obsidian's
 * `requestUrl` does not exist here — hence the injected transport in oura.ts.
 *
 * Usage:
 *   oura-metrics --days 7 --out oura.md
 *   oura-metrics --days 28 > note.md
 *   oura-metrics --days 7 --baseline-weeks 0     # no comparison period
 *
 * `--days` is the window that gets reported day by day. Three further weeks are
 * fetched behind it and become the baseline every mean, Δ and deviation is read
 * against, so a week is compared with the weeks before it rather than with itself.
 *
 * Token resolution, first hit wins:
 *   --token <t>                     explicit
 *   $OURA_TOKEN                     environment
 *   <vault>/.obsidian/plugins/oura-metrics/data.json    what the plugin already uses
 *
 * The vault comes from --vault, $OBSIDIAN_VAULT, or the repo's .vault-path file.
 */

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	type DailyActivity,
	type DailyReadiness,
	type DailyScore,
	type SleepPeriod,
	OuraApiError,
	OuraClient,
	fetchTransport,
	isoDate,
} from './oura';
import { DEFAULT_BASELINE_WEEKS, buildDays, splitWindow } from './metrics';
import { renderNote } from './render';

const DAY_MS = 86_400_000;
const DEFAULT_THRESHOLD = 1.5;

interface Options {
	days: number;
	/** Weeks of history fetched before the window, to compare it against. 0 disables it. */
	baselineWeeks: number;
	out: string | null;
	token: string | null;
	vault: string | null;
	threshold: number;
}

function fail(message: string): never {
	process.stderr.write(`oura-metrics: ${message}\n`);
	process.exit(1);
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		days: 7,
		baselineWeeks: DEFAULT_BASELINE_WEEKS,
		out: null,
		token: null,
		vault: null,
		threshold: DEFAULT_THRESHOLD,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) fail(`${arg} needs a value`);
			return value;
		};
		switch (arg) {
			case '--days':
				options.days = Number(next());
				if (!Number.isInteger(options.days) || options.days < 1) {
					fail('--days must be a positive integer');
				}
				break;
			case '--baseline-weeks':
				options.baselineWeeks = Number(next());
				if (!Number.isInteger(options.baselineWeeks) || options.baselineWeeks < 0) {
					fail('--baseline-weeks must be a non-negative integer');
				}
				break;
			case '--out':
				options.out = next();
				break;
			case '--token':
				options.token = next();
				break;
			case '--vault':
				options.vault = next();
				break;
			case '--threshold':
				options.threshold = Number(next());
				if (!Number.isFinite(options.threshold)) fail('--threshold must be a number');
				break;
			case '-h':
			case '--help':
				process.stdout.write(
					'Usage: oura-metrics [--days 7] [--baseline-weeks 3] [--out FILE] ' +
						'[--token T] [--vault DIR] [--threshold 1.5]\n',
				);
				process.exit(0);
			// eslint-disable-next-line no-fallthrough
			default:
				fail(`unknown argument: ${arg}`);
		}
	}
	return options;
}

/** The vault path, from the flag, the environment, or the repo's .vault-path file. */
function findVault(explicit: string | null): string | null {
	if (explicit) return resolve(explicit);
	if (process.env.OBSIDIAN_VAULT) return resolve(process.env.OBSIDIAN_VAULT);
	// bin/ sits one level below the repo root, and src/ does too under tsx.
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(here, '..', '.vault-path'), join(here, '.vault-path')]) {
		try {
			const path = readFileSync(candidate, 'utf8').trim();
			if (path) return resolve(path.replace(/^~/, process.env.HOME ?? '~'));
		} catch {
			// not there; try the next
		}
	}
	return null;
}

function readToken(options: Options): string {
	if (options.token) return options.token;
	if (process.env.OURA_TOKEN) return process.env.OURA_TOKEN;

	const vault = findVault(options.vault);
	if (!vault) {
		fail(
			'no token. Pass --token, set $OURA_TOKEN, or point --vault at the vault whose ' +
				'plugin data holds one.',
		);
	}
	const dataPath = join(vault, '.obsidian', 'plugins', 'oura-metrics', 'data.json');
	let raw: string;
	try {
		raw = readFileSync(dataPath, 'utf8');
	} catch {
		fail(
			`no token, and none in ${dataPath}. Open the plugin's settings in Obsidian and ` +
				'paste a personal access token, or pass --token.',
		);
	}
	let token: unknown;
	try {
		token = (JSON.parse(raw) as { token?: unknown }).token;
	} catch {
		fail(`${dataPath} is not valid JSON`);
	}
	if (typeof token !== 'string' || !token) {
		fail(`${dataPath} holds no token — add one in the plugin's settings.`);
	}
	return token;
}

function windowLabel(days: number): string {
	if (days === 7) return '7 days';
	if (days === 14) return '2 weeks';
	if (days === 28) return '4 weeks';
	return `${days} days`;
}

function baselineLabel(weeks: number): string {
	return weeks === 1 ? 'the previous week' : `the previous ${weeks} weeks`;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const token = readToken(options);

	const now = new Date();
	// Oura's `day` is the wake day, so a night is reported on the morning it ends.
	// Reaching one day past today costs nothing and avoids clipping last night.
	const end = isoDate(new Date(now.getTime() + DAY_MS));
	// The window that gets reported day by day starts here; the fetch reaches further
	// back, and everything before this date becomes the baseline it is compared with.
	// `days - 1` because today is one of them: --days 7 means today and six before it,
	// so a "week" against three "weeks" really is 7 days against 21.
	const windowStart = isoDate(new Date(now.getTime() - (options.days - 1) * DAY_MS));
	const start = isoDate(
		new Date(now.getTime() - (options.days - 1 + options.baselineWeeks * 7) * DAY_MS),
	);

	const client = new OuraClient(token, fetchTransport);
	const [sleep, dailySleep, dailyActivity, dailyReadiness] = await Promise.all([
		client.collect<SleepPeriod>('sleep', start, end),
		client.collect<DailyScore>('daily_sleep', start, end),
		client.collect<DailyActivity>('daily_activity', start, end),
		client.collect<DailyReadiness>('daily_readiness', start, end),
	]);

	const fetched = buildDays({ sleep, dailySleep, dailyActivity, dailyReadiness }, isoDate(now));
	const { window: days, baseline } = splitWindow(fetched, windowStart);
	if (days.length === 0) {
		fail(`Oura returned no data for ${windowStart}..${end}. Is the ring syncing?`);
	}

	// No prompt template: the CLI's output is an attachment inside a larger
	// bundle that carries its own instructions, so a second set would conflict.
	const markdown = renderNote(days, {
		windowLabel: windowLabel(options.days),
		generatedAt: now,
		threshold: options.threshold,
		baseline,
		baselineLabel: baselineLabel(options.baselineWeeks),
	});

	if (options.out) {
		writeFileSync(options.out, markdown);
		process.stderr.write(
			`oura-metrics: ${days.length} days over ${baseline.length} baseline days → ${options.out}\n`,
		);
	} else {
		process.stdout.write(markdown);
	}
}

main().catch((err: unknown) => {
	if (err instanceof OuraApiError) fail(err.message);
	fail(err instanceof Error ? err.message : String(err));
});
