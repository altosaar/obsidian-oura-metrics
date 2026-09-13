/**
 * Minimal Oura Cloud API v2 client.
 *
 * The HTTP call is injected rather than imported. Inside Obsidian the plugin
 * passes `requestUrl`, which is not subject to the renderer's CORS policy and
 * works identically on mobile; the headless CLI passes `fetch`. Keeping the
 * import out of this module is what lets it be bundled for Node at all — an
 * `import ... from 'obsidian'` here would make the whole dependency chain,
 * metrics and rendering included, unloadable outside the app.
 *
 * Only the four collections that carry the metrics we report are fetched. The
 * per-collection field subset is applied when deriving metrics, not here — we
 * keep the raw documents intact so a field can be added without touching this.
 */

const BASE = 'https://api.ouraring.com/v2/usercollection';

/** The subset of a response this client reads. Both transports can supply it. */
export interface OuraResponse {
	status: number;
	json: unknown;
}

/** An HTTP GET. Must resolve for non-2xx rather than throwing — status is handled below. */
export type OuraTransport = (request: {
	url: string;
	headers: Record<string, string>;
}) => Promise<OuraResponse>;

/** `fetch`-backed transport, for Node. Obsidian supplies its own from `requestUrl`. */
export const fetchTransport: OuraTransport = async ({ url, headers }) => {
	const response = await fetch(url, { headers });
	// Read the body before checking status: the error branches below don't use it,
	// but a 4xx with a JSON body would otherwise leave the stream unconsumed.
	const text = await response.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return { status: response.status, json };
};

/** Collections we read. Each is a date-windowed, `next_token`-paginated list. */
export type Collection = 'sleep' | 'daily_sleep' | 'daily_activity' | 'daily_readiness';

/** A sleep period. Naps share this shape; `type` distinguishes them. */
export interface SleepPeriod {
	id?: string;
	day: string;
	type?: string;
	bedtime_start?: string;
	bedtime_end?: string;
	total_sleep_duration?: number | null;
	time_in_bed?: number | null;
	deep_sleep_duration?: number | null;
	rem_sleep_duration?: number | null;
	light_sleep_duration?: number | null;
	awake_time?: number | null;
	efficiency?: number | null;
	latency?: number | null;
	average_heart_rate?: number | null;
	lowest_heart_rate?: number | null;
	average_hrv?: number | null;
	average_breath?: number | null;
}

export interface DailyScore {
	day: string;
	score?: number | null;
}

export interface DailyReadiness extends DailyScore {
	temperature_deviation?: number | null;
	temperature_trend_deviation?: number | null;
}

export interface DailyActivity extends DailyScore {
	high_activity_met_minutes?: number | null;
	medium_activity_met_minutes?: number | null;
	low_activity_met_minutes?: number | null;
	steps?: number | null;
	met?: { interval?: number; items?: (number | null)[] } | null;
}

export class OuraApiError extends Error {}

export class OuraClient {
	constructor(
		private readonly token: string,
		private readonly transport: OuraTransport,
	) {}

	/** Fetch every document in `[startDate, endDate]` (inclusive, `YYYY-MM-DD`). */
	async collect<T>(collection: Collection, startDate: string, endDate: string): Promise<T[]> {
		const out: T[] = [];
		let nextToken: string | undefined;

		// Bounded so a malformed `next_token` loop can never hang the plugin.
		for (let page = 0; page < 50; page++) {
			const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
			if (nextToken) params.set('next_token', nextToken);

			const response = await this.transport({
				url: `${BASE}/${collection}?${params}`,
				headers: { Authorization: `Bearer ${this.token}` },
			});

			if (response.status === 401) {
				throw new OuraApiError('Unauthorized — check the personal access token in settings.');
			}
			if (response.status === 429) {
				throw new OuraApiError('Rate limited by Oura. Wait a minute and try again.');
			}
			if (response.status >= 400) {
				throw new OuraApiError(`${collection}: HTTP ${response.status}`);
			}

			const body = response.json as { data?: T[]; next_token?: string | null };
			out.push(...(body.data ?? []));

			if (!body.next_token) return out;
			nextToken = body.next_token;
		}
		return out;
	}
}

/** `YYYY-MM-DD` in the *local* timezone — Oura's day fields are local dates. */
export function isoDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
