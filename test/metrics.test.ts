import { describe, expect, it } from 'vitest';
import {
	activityCv,
	baselineOf,
	buildDays,
	compareWindows,
	deviations,
	eligible,
	mainSleep,
	midsleep,
	rollingSleepSd,
	splitWindow,
	type DayMetrics,
} from '../src/metrics';
import { renderNote } from '../src/render';

/** A night with sane defaults, overridable per test. */
function night(day: string, over: Record<string, unknown> = {}) {
	return {
		id: `sleep-${day}`,
		day,
		type: 'long_sleep',
		bedtime_start: `${day}T23:00:00.000-04:00`,
		bedtime_end: `${day}T07:00:00.000-04:00`,
		total_sleep_duration: 7 * 3600,
		time_in_bed: 8 * 3600,
		deep_sleep_duration: 1.4 * 3600,
		rem_sleep_duration: 1.75 * 3600,
		light_sleep_duration: 3.85 * 3600,
		awake_time: 1 * 3600,
		efficiency: 90,
		latency: 600,
		average_heart_rate: 55,
		lowest_heart_rate: 50,
		average_hrv: 60,
		average_breath: 14,
		...over,
	};
}

describe('mainSleep', () => {
	it('prefers long_sleep over a longer nap', () => {
		const picked = mainSleep([
			{ day: 'd', type: 'sleep', total_sleep_duration: 9 * 3600 },
			{ day: 'd', type: 'long_sleep', total_sleep_duration: 6 * 3600 },
		]);
		expect(picked?.type).toBe('long_sleep');
	});

	it('picks the longest when several long_sleep periods exist', () => {
		const picked = mainSleep([
			{ day: 'd', type: 'long_sleep', total_sleep_duration: 4 * 3600, id: 'short' },
			{ day: 'd', type: 'long_sleep', total_sleep_duration: 7 * 3600, id: 'long' },
		]);
		expect(picked?.id).toBe('long');
	});

	it('falls back to naps when there is no long_sleep', () => {
		expect(mainSleep([{ day: 'd', type: 'sleep', total_sleep_duration: 900 }])?.type).toBe('sleep');
	});

	it('returns null for no periods', () => {
		expect(mainSleep([])).toBeNull();
	});
});

describe('midsleep', () => {
	it('takes the midpoint of the sleep period', () => {
		const m = midsleep({
			day: 'd',
			bedtime_start: '2026-08-01T23:00:00.000-04:00',
			bedtime_end: '2026-08-02T07:00:00.000-04:00',
		});
		expect(m?.clock).toBe('03:00');
	});

	it('maps hours to a noon-origin scale so midnight does not wrap', () => {
		// 23:30 and 00:30 are an hour apart; on a raw 0-24 clock they look 23h apart.
		const late = midsleep({
			day: 'd',
			bedtime_start: '2026-08-01T23:00:00.000-04:00',
			bedtime_end: '2026-08-02T00:00:00.000-04:00',
		})!;
		const early = midsleep({
			day: 'd',
			bedtime_start: '2026-08-02T00:00:00.000-04:00',
			bedtime_end: '2026-08-02T01:00:00.000-04:00',
		})!;
		expect(Math.abs(late.hours - early.hours)).toBeCloseTo(1, 5);
	});

	it('reads the clock in the recording timezone, not the host timezone', () => {
		// These tests run under TZ=UTC (vitest.config.ts). A -04:00 night must still
		// report its own local clock, or travelling would silently re-clock history.
		const newYork = midsleep({
			day: 'd',
			bedtime_start: '2026-08-01T23:00:00.000-04:00',
			bedtime_end: '2026-08-02T07:00:00.000-04:00',
		})!;
		const lisbon = midsleep({
			day: 'd',
			bedtime_start: '2026-08-01T23:00:00.000+01:00',
			bedtime_end: '2026-08-02T07:00:00.000+01:00',
		})!;
		// Same wall-clock night in two zones — both read 03:00 locally.
		expect(newYork.clock).toBe('03:00');
		expect(lisbon.clock).toBe('03:00');
		expect(newYork.hours).toBeCloseTo(lisbon.hours, 5);
	});

	it('returns null when the period is malformed', () => {
		expect(midsleep({ day: 'd', bedtime_start: 'x', bedtime_end: 'y' })).toBeNull();
		expect(midsleep({ day: 'd' })).toBeNull();
	});

	it('returns null when the timestamp carries no offset', () => {
		expect(
			midsleep({ day: 'd', bedtime_start: '2026-08-01T23:00:00', bedtime_end: '2026-08-02T07:00:00' }),
		).toBeNull();
	});
});

describe('activityCv', () => {
	it('is zero for a perfectly flat day', () => {
		expect(activityCv({ interval: 60, items: [1, 1, 1, 1] })).toBe(0);
	});

	it('rises with variability', () => {
		const flat = activityCv({ interval: 60, items: [2, 2, 2, 2, 2, 2] })!;
		const spiky = activityCv({ interval: 60, items: [1, 1, 1, 1, 1, 7] })!;
		expect(spiky).toBeGreaterThan(flat);
	});

	it('ignores nulls and bails on too-few samples', () => {
		expect(activityCv({ interval: 60, items: [1, null, 1, null] })).toBe(0);
		expect(activityCv({ interval: 60, items: [1] })).toBeNull();
		expect(activityCv(null)).toBeNull();
	});
});

describe('buildDays', () => {
	const sources = {
		sleep: [night('2026-08-01'), night('2026-08-02', { total_sleep_duration: 5 * 3600 })],
		dailySleep: [
			{ day: '2026-08-01', score: 80 },
			{ day: '2026-08-02', score: 60 },
		],
		dailyActivity: [
			{
				day: '2026-08-01',
				score: 90,
				high_activity_met_minutes: 10,
				medium_activity_met_minutes: 20,
				low_activity_met_minutes: 30,
				met: { interval: 60, items: [1, 2, 3, 4] },
			},
		],
		dailyReadiness: [{ day: '2026-08-01', score: 75, temperature_deviation: 0.4 }],
	};

	it('joins the four collections on day, sorted ascending', () => {
		const days = buildDays(sources);
		expect(days.map((d) => d.date)).toEqual(['2026-08-01', '2026-08-02']);
	});

	it('expresses stage durations as a percentage of total sleep, not time in bed', () => {
		const [first] = buildDays(sources);
		// 1.4h deep of 7h slept = 20%, NOT of the 8h in bed (17.5%).
		expect(first!.deepPct).toBeCloseTo(20, 5);
		expect(first!.remPct).toBeCloseTo(25, 5);
		expect(first!.lightPct).toBeCloseTo(55, 5);
	});

	it('sums the three activity bands into active MET minutes', () => {
		expect(buildDays(sources)[0]!.activeMetMinutes).toBe(60);
	});

	it('converts durations to hours and latency to minutes', () => {
		const [first] = buildDays(sources);
		expect(first!.totalSleepH).toBeCloseTo(7, 5);
		expect(first!.latencyMin).toBeCloseTo(10, 5);
	});

	it('leaves metrics null when a collection has no row for that day', () => {
		const second = buildDays(sources)[1]!;
		expect(second.activityScore).toBeNull();
		expect(second.tempDeviation).toBeNull();
		expect(second.activityCv).toBeNull();
	});

	it('marks today as having partial activity, and only today', () => {
		const days = buildDays(sources, '2026-08-02');
		expect(days.map((d) => d.activityPartial)).toEqual([false, true]);
		expect(buildDays(sources).every((d) => !d.activityPartial)).toBe(true);
	});
});

describe('partial activity days', () => {
	/** Four settled days plus a today whose activity has barely started. */
	function build(today?: string) {
		const activity = (day: string, met: number) => ({
			day,
			score: 85,
			high_activity_met_minutes: met,
			medium_activity_met_minutes: 0,
			low_activity_met_minutes: 0,
			met: { interval: 60, items: [1, 2, 3, 4] },
		});
		return buildDays(
			{
				sleep: [],
				dailySleep: [],
				dailyReadiness: [],
				dailyActivity: [
					activity('2026-08-01', 300),
					activity('2026-08-02', 310),
					activity('2026-08-03', 290),
					activity('2026-08-04', 305),
					activity('2026-08-05', 8), // today, three hours in
				],
			},
			today,
		);
	}

	it('would flag the partial day as an outlier if it were not excluded', () => {
		expect(deviations(build(), 1.5).some((d) => d.date === '2026-08-05')).toBe(true);
	});

	it('excludes the partial day from deviations once today is known', () => {
		expect(deviations(build('2026-08-05'), 1.5)).toHaveLength(0);
	});

	it('keeps the partial day out of the activity baseline', () => {
		const withPartial = baselineOf(build(), 'activeMetMinutes')!;
		const excluded = baselineOf(build('2026-08-05'), 'activeMetMinutes')!;
		expect(excluded.n).toBe(withPartial.n - 1);
		expect(excluded.mean).toBeGreaterThan(withPartial.mean);
	});

	it('still counts the partial day for sleep metrics, which are complete by morning', () => {
		const days = buildDays(
			{
				sleep: [night('2026-08-05')],
				dailySleep: [],
				dailyActivity: [],
				dailyReadiness: [],
			},
			'2026-08-05',
		);
		expect(days[0]!.activityPartial).toBe(true);
		expect(eligible(days, 'totalSleepH')).toHaveLength(1);
		expect(eligible(days, 'activeMetMinutes')).toHaveLength(0);
	});
});

describe('baselines and deviations', () => {
	const days: DayMetrics[] = [7.5, 7.4, 7.6, 7.5, 3.0].map((h, i) => ({
		date: `2026-08-0${i + 1}`,
		totalSleepH: h,
		efficiency: null,
		latencyMin: null,
		deepPct: null,
		remPct: null,
		lightPct: null,
		awakeH: null,
		midsleepClock: null,
		midsleepHours: null,
		sleepScore: null,
		restingHr: null,
		averageHr: null,
		hrv: null,
		breath: null,
		tempDeviation: null,
		activityScore: null,
		activeMetMinutes: null,
		activityCv: null,
	}));

	it('needs at least three values before reporting a baseline', () => {
		expect(baselineOf(days.slice(0, 2), 'totalSleepH')).toBeNull();
		expect(baselineOf(days, 'totalSleepH')).not.toBeNull();
	});

	it('flags the outlier night and not the ordinary ones', () => {
		const flagged = deviations(days, 1.5);
		expect(flagged).toHaveLength(1);
		expect(flagged[0]!.date).toBe('2026-08-05');
		expect(flagged[0]!.z).toBeLessThan(0);
	});

	it('reports nothing when a metric is entirely absent', () => {
		expect(deviations(days, 1.5).some((d) => d.metric === 'hrv')).toBe(false);
	});

	it('computes a rolling sleep SD that responds to the outlier', () => {
		const rolling = rollingSleepSd(days, 7);
		expect(rolling.at(-1)!.sd).toBeGreaterThan(rolling[0]!.sd);
	});
});

describe('renderNote', () => {
	const days = buildDays({
		sleep: [night('2026-08-01')],
		dailySleep: [{ day: '2026-08-01', score: 80 }],
		dailyActivity: [],
		dailyReadiness: [],
	});

	it('renders the tables and never leaks an intra-night series', () => {
		const md = renderNote(days, {
			windowLabel: '7 days',
			generatedAt: new Date('2026-08-02T10:00:00Z'),
			threshold: 1.5,
		});
		expect(md).toContain('## Sleep');
		expect(md).toContain('## Physiology and activity');
		expect(md).toContain('2026-08-01');
		// The hypnogram/MET series must never reach the note — that was the whole point.
		expect(md).not.toMatch(/[1-4]{20,}/);
		expect(md.length).toBeLessThan(8000);
	});

	it('warns when the window is too short to read baselines from', () => {
		const md = renderNote(days, {
			windowLabel: '7 days',
			generatedAt: new Date(),
			threshold: 1.5,
		});
		expect(md).toContain('below');
		expect(md).toContain('day of data here');
	});

	it('handles an empty window without throwing', () => {
		const md = renderNote([], {
			windowLabel: '7 days',
			generatedAt: new Date(),
			threshold: 1.5,
		});
		expect(md).toContain('No Oura data');
	});

	it('places the prompt above the data', () => {
		const md = renderNote(days, {
			windowLabel: '7 days',
			generatedAt: new Date(),
			threshold: 1.5,
			prompt: 'PROMPT HERE',
		});
		expect(md.indexOf('PROMPT HERE')).toBeLessThan(md.indexOf('## Sleep'));
	});
});

/** A metrics row with everything null, so a test can set only what it is about. */
function row(date: string, over: Partial<DayMetrics> = {}): DayMetrics {
	return {
		date,
		totalSleepH: null,
		efficiency: null,
		latencyMin: null,
		deepPct: null,
		remPct: null,
		lightPct: null,
		awakeH: null,
		midsleepClock: null,
		midsleepHours: null,
		sleepScore: null,
		restingHr: null,
		averageHr: null,
		hrv: null,
		breath: null,
		tempDeviation: null,
		activityScore: null,
		activeMetMinutes: null,
		activityCv: null,
		activityPartial: false,
		...over,
	};
}

/** Four weeks: three steady baseline weeks, then a window that sleeps an hour less. */
function fourWeeks(): { window: DayMetrics[]; baseline: DayMetrics[]; all: DayMetrics[] } {
	const all: DayMetrics[] = [];
	for (let i = 0; i < 28; i++) {
		const date = `2026-08-${String(i + 1).padStart(2, '0')}`;
		// Baseline alternates 7.4/7.6 h; the last week alternates 6.4/6.6 h.
		const base = i < 21 ? 7.5 : 6.5;
		all.push(row(date, { totalSleepH: base + (i % 2 === 0 ? -0.1 : 0.1) }));
	}
	const { window, baseline } = splitWindow(all, '2026-08-22');
	return { window, baseline, all };
}

describe('splitWindow', () => {
	it('puts the start date in the window and everything earlier in the baseline', () => {
		const { window, baseline } = fourWeeks();
		expect(baseline).toHaveLength(21);
		expect(window).toHaveLength(7);
		expect(window[0]!.date).toBe('2026-08-22');
		expect(baseline.at(-1)!.date).toBe('2026-08-21');
	});

	it('leaves the baseline empty when nothing precedes the window', () => {
		const days = [row('2026-08-22'), row('2026-08-23')];
		expect(splitWindow(days, '2026-08-22').baseline).toEqual([]);
	});
});

describe('compareWindows', () => {
	it('reports the shift in the metric’s unit and in baseline SDs', () => {
		const { window, baseline } = fourWeeks();
		const sleep = compareWindows(window, baseline).find((c) => c.metric === 'totalSleepH');
		expect(sleep!.window!.mean).toBeCloseTo(6.5, 1);
		expect(sleep!.baseline!.mean).toBeCloseTo(7.5, 1);
		expect(sleep!.delta).toBeCloseTo(-1, 1);
		// Baseline SD is ~0.1 h, so an hour less sleep is a very large z.
		expect(sleep!.z).toBeLessThan(-5);
	});

	it('keeps both periods’ SD, so a change in spread is visible without a change in mean', () => {
		const baseline = Array.from({ length: 21 }, (_, i) =>
			row(`2026-08-${String(i + 1).padStart(2, '0')}`, { totalSleepH: 7.5 + (i % 2 ? 0.1 : -0.1) }),
		);
		const window = Array.from({ length: 7 }, (_, i) =>
			row(`2026-08-2${i + 2}`, { totalSleepH: 7.5 + (i % 2 ? 2 : -2) }),
		);
		const sleep = compareWindows(window, baseline).find((c) => c.metric === 'totalSleepH');
		expect(Math.abs(sleep!.delta!)).toBeLessThan(0.6);
		expect(sleep!.window!.sd).toBeGreaterThan(sleep!.baseline!.sd * 10);
	});

	it('drops a metric neither period has any data for', () => {
		const { window, baseline } = fourWeeks();
		expect(compareWindows(window, baseline).some((c) => c.metric === 'hrv')).toBe(false);
	});
});

describe('deviations against a prior baseline', () => {
	it('flags a whole shifted week that a within-window baseline would hide', () => {
		const { window, baseline } = fourWeeks();
		// Judged against itself the window is unremarkable — every night matches its neighbours.
		expect(deviations(window, 1.5)).toHaveLength(0);
		// Against the three weeks before it, every night is short.
		const flagged = deviations(window, 1.5, baseline);
		expect(flagged).toHaveLength(7);
		expect(flagged.every((d) => d.z < 0)).toBe(true);
		expect(flagged[0]!.baseline.mean).toBeCloseTo(7.5, 1);
	});

	it('is the old within-window reading when no reference is passed', () => {
		const { window } = fourWeeks();
		expect(deviations(window, 1.5)).toEqual(deviations(window, 1.5, window));
	});
});

describe('renderNote with a baseline', () => {
	it('compares the window with the baseline and lists only the window’s days', () => {
		const { window, baseline } = fourWeeks();
		const md = renderNote(window, {
			windowLabel: '7 days',
			generatedAt: new Date('2026-08-29T10:00:00Z'),
			threshold: 1.5,
			baseline,
			baselineLabel: 'the previous 3 weeks',
		});
		expect(md).toContain('## Last 7 days vs the previous 3 weeks');
		expect(md).toContain('Baseline mean');
		expect(md).toContain('2026-08-22');
		// Baseline days inform the numbers; they are never listed as rows.
		expect(md).not.toContain('2026-08-14');
		expect(md).toContain('2026-08-01 … 2026-08-21');
	});

	it('rolls the sleep-duration SD over the baseline, so the first window night has history', () => {
		const { window, baseline } = fourWeeks();
		const withBaseline = rollingSleepSd([...baseline, ...window], 7).find(
			(r) => r.date === '2026-08-22',
		);
		const without = rollingSleepSd(window, 7).find((r) => r.date === '2026-08-22');
		expect(withBaseline!.n).toBe(7);
		expect(without).toBeUndefined();
	});

	it('falls back to the window’s own mean when there is no baseline', () => {
		const { window } = fourWeeks();
		const md = renderNote(window, {
			windowLabel: '7 days',
			generatedAt: new Date('2026-08-29T10:00:00Z'),
			threshold: 1.5,
			baseline: [],
		});
		expect(md).toContain('## Baseline for this window');
		expect(md).toContain('this window’s own mean');
	});
});
