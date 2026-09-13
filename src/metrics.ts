/**
 * Derive the reported metrics from raw Oura documents.
 *
 * The note reports a small, fixed set of scalars and nothing else — every
 * additional field is context an LLM has to wade through:
 *
 *   - sleep: total time and its variability, efficiency, onset latency,
 *     stage proportions, midsleep clock time
 *   - nocturnal heart rate, HRV (RMSSD) and respiratory rate
 *   - skin-temperature deviation
 *   - activity: active MET minutes and within-day variability
 *
 * Intra-night and intra-day time series are *not* reported. They are reduced to
 * scalars here (stage percentages, activity CV) — an LLM reads a 288-point
 * series poorly, but reads one number per night well.
 */

import type { DailyActivity, DailyReadiness, DailyScore, SleepPeriod } from './oura';

/** One night + the following day, reduced to the reported scalars. */
export interface DayMetrics {
	date: string;
	// Sleep
	totalSleepH: number | null;
	efficiency: number | null;
	latencyMin: number | null;
	deepPct: number | null;
	remPct: number | null;
	lightPct: number | null;
	awakeH: number | null;
	midsleepClock: string | null;
	/** Midsleep as hours since the preceding noon — avoids midnight wraparound in stats. */
	midsleepHours: number | null;
	sleepScore: number | null;
	// Physiology
	restingHr: number | null;
	averageHr: number | null;
	hrv: number | null;
	breath: number | null;
	tempDeviation: number | null;
	// Activity
	activityScore: number | null;
	activeMetMinutes: number | null;
	/** Coefficient of variation of the day's 1-minute MET series (SD / mean). */
	activityCv: number | null;
	/**
	 * True when this row's activity is still accumulating (it is today).
	 *
	 * Last night's *sleep* is complete by morning, but the day's activity is not —
	 * a run at noon sees a third of a day. These values are shown but excluded
	 * from baselines, or every pre-bedtime run would flag a phantom collapse in
	 * activity and drag the mean the other days are compared against.
	 */
	activityPartial: boolean;
}

/** Mean, SD and n for one metric across the window. */
export interface Baseline {
	mean: number;
	sd: number;
	n: number;
}

export interface Deviation {
	metric: string;
	label: string;
	date: string;
	value: number;
	z: number;
	baseline: Baseline;
}

/** Weeks of history before the reported window that make up the comparison baseline. */
export const DEFAULT_BASELINE_WEEKS = 3;

/** One metric's reported window set against the baseline period before it. */
export interface Comparison {
	metric: string;
	label: string;
	unit: string;
	/** Mean, SD and n over the baseline period; null when it holds too few values. */
	baseline: Baseline | null;
	/** The same, over the reported window. */
	window: Baseline | null;
	/** Window mean − baseline mean, in the metric's own unit. */
	delta: number | null;
	/** `delta` expressed in baseline SDs, so it compares across metrics. */
	z: number | null;
}

/** Metrics derived from the day's activity, which is incomplete until the day ends. */
export const ACTIVITY_KEYS: ReadonlySet<keyof DayMetrics> = new Set([
	'activityScore',
	'activeMetMinutes',
	'activityCv',
]);

/** Numeric metrics eligible for baseline/deviation analysis, with display labels. */
export const TRACKED: { key: keyof DayMetrics; label: string; unit: string }[] = [
	{ key: 'totalSleepH', label: 'Total sleep', unit: 'h' },
	{ key: 'efficiency', label: 'Sleep efficiency', unit: '%' },
	{ key: 'latencyMin', label: 'Sleep latency', unit: 'min' },
	{ key: 'deepPct', label: 'Deep sleep', unit: '%' },
	{ key: 'remPct', label: 'REM sleep', unit: '%' },
	{ key: 'lightPct', label: 'Light sleep', unit: '%' },
	{ key: 'midsleepHours', label: 'Midsleep time', unit: 'h' },
	{ key: 'restingHr', label: 'Resting HR', unit: 'bpm' },
	{ key: 'hrv', label: 'HRV (RMSSD)', unit: 'ms' },
	{ key: 'breath', label: 'Respiratory rate', unit: '/min' },
	{ key: 'tempDeviation', label: 'Temperature deviation', unit: '°C' },
	{ key: 'activityCv', label: 'Within-day activity CV', unit: '' },
	{ key: 'activeMetMinutes', label: 'Active MET minutes', unit: 'min' },
];

function pct(part: number | null | undefined, whole: number | null | undefined): number | null {
	if (!part || !whole) return null;
	return (part / whole) * 100;
}

/** The night's main sleep period: the longest `long_sleep`, else the longest of any type. */
export function mainSleep(periods: SleepPeriod[]): SleepPeriod | null {
	if (periods.length === 0) return null;
	const longSleep = periods.filter((p) => p.type === 'long_sleep');
	const pool = longSleep.length > 0 ? longSleep : periods;
	return pool.reduce((best, p) =>
		(p.total_sleep_duration ?? 0) > (best.total_sleep_duration ?? 0) ? p : best,
	);
}

/**
 * The UTC offset an Oura timestamp carries, in minutes (`…-04:00` → −240).
 *
 * Returns null for a bare or malformed timestamp.
 */
export function offsetMinutes(iso: string): number | null {
	if (/Z$/.test(iso)) return 0;
	const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
	if (!m) return null;
	const sign = m[1] === '-' ? -1 : 1;
	return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Midsleep — the midpoint between falling asleep and waking.
 *
 * Computed in **the timestamp's own timezone**, not the machine's. Oura records
 * the offset the ring was in, and that is the clock that matters: a
 * night slept in Lisbon should read as its Lisbon local time regardless of where
 * the note is later generated. Using `getHours()` here would silently re-clock
 * every night when travelling or when the vault syncs to another machine.
 *
 * Returned both as a clock string and as hours since the preceding noon, because
 * a 23:50 and a 00:10 midsleep are 20 minutes apart but would look 23.7 hours
 * apart on a raw 0–24 clock, wrecking any SD computed over them.
 */
export function midsleep(period: SleepPeriod): { clock: string; hours: number } | null {
	if (!period.bedtime_start || !period.bedtime_end) return null;
	const start = Date.parse(period.bedtime_start);
	const end = Date.parse(period.bedtime_end);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

	const offset = offsetMinutes(period.bedtime_start);
	if (offset === null) return null;

	// Shift into the recording timezone, then read with UTC getters so the result
	// never depends on the host's TZ.
	const wall = new Date((start + end) / 2 + offset * 60_000);
	const pad = (n: number) => String(n).padStart(2, '0');
	const clock = `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;

	// Hours since the preceding noon: 15:00 → 3, 03:00 → 15. Monotonic across midnight.
	const raw = wall.getUTCHours() + wall.getUTCMinutes() / 60;
	const hours = raw >= 12 ? raw - 12 : raw + 12;
	return { clock, hours };
}

/** Coefficient of variation of a 1-minute MET series — within-day activity variability. */
export function activityCv(met: DailyActivity['met']): number | null {
	const items = (met?.items ?? []).filter((v): v is number => typeof v === 'number');
	if (items.length < 2) return null;
	const mean = items.reduce((a, b) => a + b, 0) / items.length;
	if (mean === 0) return null;
	const variance = items.reduce((a, b) => a + (b - mean) ** 2, 0) / (items.length - 1);
	return Math.sqrt(variance) / mean;
}

export interface Sources {
	sleep: SleepPeriod[];
	dailySleep: DailyScore[];
	dailyActivity: DailyActivity[];
	dailyReadiness: DailyReadiness[];
}

/**
 * Reduce the raw collections to one row per day, newest last.
 *
 * `today` (a `YYYY-MM-DD` local date) marks the row whose activity is still
 * accumulating; pass it so partial activity is kept out of the baselines.
 */
export function buildDays(sources: Sources, today?: string): DayMetrics[] {
	const sleepByDay = new Map<string, SleepPeriod[]>();
	for (const p of sources.sleep) {
		if (!p.day) continue;
		const forDay = sleepByDay.get(p.day);
		if (forDay) forDay.push(p);
		else sleepByDay.set(p.day, [p]);
	}
	const index = <T extends { day: string }>(rows: T[]) => new Map(rows.map((r) => [r.day, r]));
	const scoreByDay = index(sources.dailySleep);
	const activityByDay = index(sources.dailyActivity);
	const readinessByDay = index(sources.dailyReadiness);

	const days = new Set<string>([
		...sleepByDay.keys(),
		...scoreByDay.keys(),
		...activityByDay.keys(),
		...readinessByDay.keys(),
	]);

	return [...days].sort().map((date) => {
		const sleep = mainSleep(sleepByDay.get(date) ?? []);
		const activity = activityByDay.get(date);
		const readiness = readinessByDay.get(date);
		const mid = sleep ? midsleep(sleep) : null;
		const tst = sleep?.total_sleep_duration ?? null;

		const metMinutes =
			(activity?.high_activity_met_minutes ?? 0) +
			(activity?.medium_activity_met_minutes ?? 0) +
			(activity?.low_activity_met_minutes ?? 0);

		return {
			date,
			totalSleepH: tst ? tst / 3600 : null,
			efficiency: sleep?.efficiency ?? null,
			latencyMin: sleep?.latency != null ? sleep.latency / 60 : null,
			deepPct: pct(sleep?.deep_sleep_duration, tst),
			remPct: pct(sleep?.rem_sleep_duration, tst),
			lightPct: pct(sleep?.light_sleep_duration, tst),
			awakeH: sleep?.awake_time != null ? sleep.awake_time / 3600 : null,
			midsleepClock: mid?.clock ?? null,
			midsleepHours: mid?.hours ?? null,
			sleepScore: scoreByDay.get(date)?.score ?? null,
			restingHr: sleep?.lowest_heart_rate ?? null,
			averageHr: sleep?.average_heart_rate ?? null,
			hrv: sleep?.average_hrv ?? null,
			breath: sleep?.average_breath ?? null,
			tempDeviation: readiness?.temperature_deviation ?? null,
			activityScore: activity?.score ?? null,
			activeMetMinutes: activity ? metMinutes : null,
			activityCv: activity ? activityCv(activity.met) : null,
			activityPartial: today != null && date === today,
		};
	});
}

/** The days a metric may be measured over — activity drops the still-running day. */
export function eligible(days: DayMetrics[], key: keyof DayMetrics): DayMetrics[] {
	return ACTIVITY_KEYS.has(key) ? days.filter((d) => !d.activityPartial) : days;
}

/** Sample mean and SD (n−1) of the non-null values of one metric. */
export function baselineOf(days: DayMetrics[], key: keyof DayMetrics): Baseline | null {
	const values = eligible(days, key)
		.map((d) => d[key])
		.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
	if (values.length < 3) return null;
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
	return { mean, sd, n: values.length };
}

/**
 * Days sitting more than `threshold` SD from the baseline mean.
 *
 * `reference` is the period the mean and SD are read from. Pass the weeks *before*
 * the window and each day is judged against history it did not help define — the
 * usual reason for doing this is that a within-window baseline moves with the days
 * it is judging: a bad week raises its own mean until nothing in it looks unusual.
 * Left out, the window is its own reference, which is the weaker reading the note
 * falls back to when there is no history to compare against.
 */
export function deviations(
	days: DayMetrics[],
	threshold = 1.5,
	reference: DayMetrics[] = days,
): Deviation[] {
	const out: Deviation[] = [];
	for (const { key, label } of TRACKED) {
		const baseline = baselineOf(reference, key);
		if (!baseline || baseline.sd === 0) continue;
		for (const day of eligible(days, key)) {
			const value = day[key];
			if (typeof value !== 'number' || !Number.isFinite(value)) continue;
			const z = (value - baseline.mean) / baseline.sd;
			if (Math.abs(z) >= threshold) {
				out.push({ metric: String(key), label, date: day.date, value, z, baseline });
			}
		}
	}
	// Most recent first, then most extreme.
	return out.sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.z) - Math.abs(a.z));
}

/**
 * Split a fetched span into the reported window and the baseline period before it.
 *
 * `windowStart` is the first date of the reported window (`YYYY-MM-DD`); everything
 * strictly earlier becomes baseline. ISO dates sort lexically, so no parsing is needed.
 */
export function splitWindow(
	days: DayMetrics[],
	windowStart: string,
): { window: DayMetrics[]; baseline: DayMetrics[] } {
	return {
		window: days.filter((d) => d.date >= windowStart),
		baseline: days.filter((d) => d.date < windowStart),
	};
}

/**
 * Every tracked metric's reported window measured against the baseline period.
 *
 * `z` is the difference between the two means in *baseline* SDs — the reference
 * period supplies the scale, so the number means the same thing from week to week.
 * It is a day-scale effect size, not a test statistic: dividing by the standard
 * error (SD/√n) instead would declare almost every week a significant change,
 * because n is 7 and consecutive nights are correlated.
 *
 * SD is reported for both periods, not just the baseline: a week can hold its
 * mean and still scatter far more than the weeks before it.
 */
export function compareWindows(window: DayMetrics[], baseline: DayMetrics[]): Comparison[] {
	const out: Comparison[] = [];
	for (const { key, label, unit } of TRACKED) {
		const base = baselineOf(baseline, key);
		const current = baselineOf(window, key);
		if (!base && !current) continue;
		const delta = base && current ? current.mean - base.mean : null;
		const z = delta != null && base && base.sd > 0 ? delta / base.sd : null;
		out.push({ metric: String(key), label, unit, baseline: base, window: current, delta, z });
	}
	return out;
}

/**
 * Rolling SD of total sleep time over a trailing window.
 *
 * Night-to-night spread in sleep duration, which can change while the mean holds.
 */
export function rollingSleepSd(
	days: DayMetrics[],
	window = 7,
): { date: string; sd: number; n: number }[] {
	const out: { date: string; sd: number; n: number }[] = [];
	for (let i = 0; i < days.length; i++) {
		const slice = days.slice(Math.max(0, i - window + 1), i + 1);
		const values = slice
			.map((d) => d.totalSleepH)
			.filter((v): v is number => typeof v === 'number');
		if (values.length < 3) continue;
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
		out.push({ date: days[i]!.date, sd, n: values.length });
	}
	return out;
}
