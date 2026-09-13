/** Render derived metrics as the markdown note that gets pasted into an LLM. */

import {
	type Baseline,
	type DayMetrics,
	TRACKED,
	baselineOf,
	compareWindows,
	deviations,
	eligible,
	rollingSleepSd,
} from './metrics';

const DASH = '—';

function num(value: number | null | undefined, digits = 1): string {
	return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : DASH;
}

function signed(value: number, digits = 1): string {
	return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function table(headers: string[], aligns: string[], rows: string[][]): string {
	return [
		`| ${headers.join(' | ')} |`,
		`|${aligns.join('|')}|`,
		...rows.map((r) => `| ${r.join(' | ')} |`),
	].join('\n');
}

export interface RenderOptions {
	windowLabel: string;
	generatedAt: Date;
	/** SD threshold for flagging a day as deviating from the baseline. */
	threshold: number;
	/**
	 * The days *before* the window, which become the baseline every figure is read
	 * against. Left out (or too thin), the window falls back to being its own baseline.
	 */
	baseline?: DayMetrics[];
	/** How the baseline period is named in prose, e.g. `the previous 3 weeks`. */
	baselineLabel?: string;
	/** Optional user prompt template, already substituted, placed above everything. */
	prompt?: string;
}

/** Below this many baseline days there is nothing worth comparing against. */
const MIN_BASELINE_DAYS = 3;

/** Most single-day flags to list, newest first, before the table stops earning its length. */
const MAX_DEVIATION_ROWS = 30;

export function renderNote(days: DayMetrics[], options: RenderOptions): string {
	const { windowLabel, generatedAt, threshold, prompt } = options;
	const baseline = options.baseline ?? [];
	const comparing = baseline.length >= MIN_BASELINE_DAYS;
	const baselineLabel = options.baselineLabel ?? 'the previous weeks';
	const parts: string[] = [];

	if (prompt) parts.push(prompt.trim(), '\n---\n');

	parts.push(`# Oura metrics — last ${windowLabel}`);
	parts.push(
		`_generated ${generatedAt.toLocaleString()} · ${days.length} day${days.length === 1 ? '' : 's'}` +
			(comparing
				? `, against ${baselineLabel} (${baseline.length} days with data, ${span(baseline)})`
				: '') +
			'_',
	);

	if (days.length === 0) {
		parts.push(
			'\nNo Oura data in this window. If the ring synced recently, try a longer window.',
		);
		return parts.join('\n\n');
	}

	parts.push(sleepTable(days));
	parts.push(physiologyTable(days));
	parts.push(
		comparing
			? comparisonTable(days, baseline, windowLabel, baselineLabel)
			: baselineTable(days),
	);
	parts.push(variabilitySection(days, baseline, baselineLabel));
	parts.push(deviationSection(days, threshold, comparing ? baseline : days, comparing ? baselineLabel : null));
	parts.push(caveats(days, comparing ? baseline : null, baselineLabel));

	return parts.filter(Boolean).join('\n\n');
}

/** `2026-08-01 … 2026-08-21`, or the single date when a period is one day long. */
function span(days: DayMetrics[]): string {
	const first = days[0]?.date ?? DASH;
	const last = days.at(-1)?.date ?? DASH;
	return first === last ? first : `${first} … ${last}`;
}

function sleepTable(days: DayMetrics[]): string {
	const rows = days.map((d) => [
		d.date,
		num(d.totalSleepH, 2),
		num(d.efficiency, 0),
		num(d.latencyMin, 0),
		num(d.deepPct, 0),
		num(d.remPct, 0),
		num(d.lightPct, 0),
		d.midsleepClock ?? DASH,
		num(d.sleepScore, 0),
	]);
	return [
		'## Sleep',
		'',
		'_Stage percentages are of total sleep time, not time in bed._',
		'',
		table(
			['Date', 'Sleep h', 'Eff %', 'Latency min', 'Deep %', 'REM %', 'Light %', 'Midsleep', 'Score'],
			['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:'],
			rows,
		),
	].join('\n');
}

function physiologyTable(days: DayMetrics[]): string {
	const partial = days.some((d) => d.activityPartial);
	const rows = days.map((d) => [
		d.date + (d.activityPartial ? ' \\*' : ''),
		num(d.restingHr, 0),
		num(d.averageHr, 0),
		num(d.hrv, 0),
		num(d.breath, 1),
		num(d.tempDeviation, 2),
		num(d.activityScore, 0),
		num(d.activeMetMinutes, 0),
		num(d.activityCv, 2),
	]);
	return [
		'## Physiology and activity',
		'',
		'_HR and HRV are nocturnal. Activity CV is the coefficient of variation of the day’s' +
			' 1-minute MET series (full 24 h, sleep included) — a within-day variability scalar._',
		'',
		table(
			['Date', 'Resting HR', 'Avg HR', 'HRV ms', 'Breath', 'Temp Δ°C', 'Act score', 'Active MET min', 'Act CV'],
			['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:'],
			rows,
		),
		partial
			? '\n\\* Today — activity is still accumulating, so its activity columns are shown but' +
				' excluded from the baselines below. The sleep row for the same date is complete.'
			: '',
	].join('\n');
}

/**
 * The reported window set against the baseline period before it — the main read.
 *
 * Both periods get a mean *and* an SD, because a week can hold its average and
 * still scatter: a change in variability only shows up in the spread.
 */
function comparisonTable(
	days: DayMetrics[],
	baseline: DayMetrics[],
	windowLabel: string,
	baselineLabel: string,
): string {
	const rows = compareWindows(days, baseline).map((c) => [
		c.label,
		c.unit || DASH,
		num(c.window?.mean, 2),
		num(c.window?.sd, 2),
		num(c.baseline?.mean, 2),
		num(c.baseline?.sd, 2),
		c.delta == null ? DASH : signed(c.delta, 2),
		c.z == null ? DASH : signed(c.z, 2),
	]);
	if (rows.length === 0) return '';

	return [
		`## Last ${windowLabel} vs ${baselineLabel}`,
		'',
		`_Baseline is ${baselineLabel} — the days before this window, so nothing in the window` +
			' helped set the mean it is judged against. Δ is the change in the metric’s own unit;' +
			' z is that change in baseline SDs, which is what makes metrics comparable to each' +
			' other. The two SD columns are the same comparison for *variability*: a week can hold' +
			' its mean and still scatter. A metric with fewer than three baseline values is left out._',
		'',
		table(
			['Metric', 'Unit', 'Week mean', 'Week SD', 'Baseline mean', 'Baseline SD', 'Δ', 'z'],
			['---', '---', '---:', '---:', '---:', '---:', '---:', '---:'],
			rows,
		),
	].join('\n');
}

/** Fallback for a note with no history behind it: the window is its own baseline. */
function baselineTable(days: DayMetrics[]): string {
	const rows: string[][] = [];
	for (const { key, label, unit } of TRACKED) {
		const baseline = baselineOf(days, key);
		if (!baseline) continue;
		// Same eligibility as the baseline itself, so "latest" never reports a
		// still-accumulating activity figure against a baseline that excluded it.
		const latest = [...eligible(days, key)].reverse().find((d) => typeof d[key] === 'number');
		const value = latest ? (latest[key] as number) : null;
		const z = value != null && baseline.sd > 0 ? (value - baseline.mean) / baseline.sd : null;
		rows.push([
			label,
			unit || DASH,
			num(baseline.mean, 2),
			num(baseline.sd, 2),
			num(value, 2),
			z == null ? DASH : signed(z, 2),
		]);
	}
	if (rows.length === 0) return '';
	return [
		'## Baseline for this window',
		'',
		'_Mean and SD across the window itself. “Latest” is the most recent non-empty day._',
		'',
		table(
			['Metric', 'Unit', 'Mean', 'SD', 'Latest', 'z'],
			['---', '---', '---:', '---:', '---:', '---:'],
			rows,
		),
	].join('\n');
}

/**
 * The 7-night rolling SD of sleep duration across the window.
 *
 * Rolled over the baseline *and* the window, so the window's first night already has
 * seven real nights behind it rather than a window that ramps up from three. Only the
 * window's own rows are printed; the baseline's collapse into one reference number,
 * counting only the entries with a full seven nights in them.
 */
function variabilitySection(
	days: DayMetrics[],
	baseline: DayMetrics[],
	baselineLabel: string,
): string {
	const rolling = rollingSleepSd([...baseline, ...days], 7);
	if (rolling.length === 0) return '';

	const windowStart = days[0]?.date ?? '';
	const inWindow = rolling.filter((r) => r.date >= windowStart);
	const rows = (inWindow.length > 0 ? inWindow : rolling.slice(-7)).map((r) => [
		r.date,
		num(r.sd, 2),
	]);

	const prior = rolling.filter((r) => r.date < windowStart && r.n >= 7).map((r) => r.sd);
	const priorMean =
		prior.length > 0 ? prior.reduce((a, b) => a + b, 0) / prior.length : null;

	return [
		'## Sleep-duration variability (7-night rolling SD)',
		'',
		'_Night-to-night spread in sleep duration over the trailing seven nights. It can rise' +
			' while mean sleep stays flat._',
		'',
		table(['Date', 'Rolling SD h'], ['---', '---:'], rows),
		priorMean == null
			? ''
			: `\n_The same rolling SD averaged ${num(priorMean, 2)} h across ${baselineLabel}._`,
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * The window's individual days that sit beyond the threshold.
 *
 * `reference` is where the mean and SD come from — the baseline period when there is
 * one, the window itself when there is not. `baselineLabel` is null in that second
 * case, and the prose says so rather than implying a reference period that isn't there.
 */
function deviationSection(
	days: DayMetrics[],
	threshold: number,
	reference: DayMetrics[],
	baselineLabel: string | null,
): string {
	const flagged = deviations(days, threshold, reference);
	const against = baselineLabel ?? 'this window’s own mean';
	const header = `## Deviations beyond ±${threshold} SD of baseline`;

	if (flagged.length === 0) {
		return `${header}\n\nNone. Every tracked metric stayed within ±${threshold} SD of ${against}.`;
	}

	// A real baseline flags far more days than a self-referential one did, and a long
	// window times thirteen metrics can run to hundreds of rows. Newest first, so the
	// truncation drops the oldest days — the table is for what happened lately.
	const shown = flagged.slice(0, MAX_DEVIATION_ROWS);
	const rows = shown.map((d) => [
		d.date,
		d.label,
		num(d.value, 2),
		num(d.baseline.mean, 2),
		signed(d.z, 2),
		d.z > 0 ? 'above' : 'below',
	]);
	return [
		header,
		'',
		`_Single days in this window, each against the mean and SD of ${against}._`,
		'',
		table(
			['Date', 'Metric', 'Value', 'Baseline mean', 'z', 'Direction'],
			['---', '---', '---:', '---:', '---:', '---'],
			rows,
		),
		flagged.length > shown.length
			? `\n_${flagged.length - shown.length} earlier flagged day-metrics not listed._`
			: '',
	]
		.filter(Boolean)
		.join('\n');
}

function caveats(
	days: DayMetrics[],
	baseline: DayMetrics[] | null,
	baselineLabel: string,
): string {
	const lines = [
		'## How to read this',
		'',
		baseline
			? `- Everything here is measured against **${baselineLabel}**. That is a real reference` +
				' period rather than the window judging itself, but it inherits whatever those weeks' +
				' were: if they were already unusual, this week reads as normal.'
			: '- Deviations are measured against **this window’s own mean**, not a prior reference' +
				' period. A personal baseline needs 2–4 weeks of data to mean much; a short window,' +
				' or one extreme day, distorts the mean each day is compared against.',
		'- A z of ±1 is one baseline day’s worth of spread, so a *weekly mean* moving that far is' +
			' a large shift — seven nights average most of the noise out. Read ±0.5 as visible and' +
			' ±1 as pronounced, and read the direction of several metrics together before either.',
		'- With thirteen metrics, one of them crossing a threshold is expected by chance.' +
			' Several moving together is stronger evidence of change than any single flag.',
		'- Absolute values matter less than change from personal baseline; population norms are' +
			' largely irrelevant here.',
		'- Sleep stages from a consumer ring are estimates, so treat stage percentages as trend' +
			' indicators rather than measurements.',
	];
	const thin = baseline ? baseline.length : days.length;
	if (thin < 14) {
		const what = baseline ? 'baseline' : 'data';
		lines.splice(
			1,
			0,
			'',
			`> **Only ${thin} day${thin === 1 ? '' : 's'} of ${what} here.** That is below what any` +
				' baseline-deviation reading needs. Treat the numbers as descriptive only.',
		);
	}
	return lines.join('\n');
}
