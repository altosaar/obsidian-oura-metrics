import { Notice, Plugin, TFile, addIcon, normalizePath, requestUrl } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	OuraMetricsSettingTab,
	type OuraMetricsSettings,
} from './settings';
import { OURA_ICON_ID, OURA_ICON_SVG } from './icon';
import {
	OuraApiError,
	OuraClient,
	isoDate,
	type DailyActivity,
	type DailyReadiness,
	type DailyScore,
	type SleepPeriod,
} from './oura';
import {
	PROTOCOL_ACTION,
	authorizeUrl,
	fieldsFromProtocol,
	isExpired,
	newState,
	parseAuthorizationResponse,
} from './oauth';
import { DEFAULT_BASELINE_WEEKS, buildDays, splitWindow } from './metrics';
import { renderNote } from './render';

const DAY_MS = 86_400_000;

interface SummaryWindow {
	/** Stable command-id suffix — keep constant so user hotkeys survive. */
	id: string;
	label: string;
	days: number;
}

const WINDOWS: SummaryWindow[] = [
	{ id: '7d', label: '7 days', days: 7 },
	{ id: '14d', label: '2 weeks', days: 14 },
	{ id: '28d', label: '4 weeks', days: 28 },
];

export default class OuraMetricsPlugin extends Plugin {
	settings!: OuraMetricsSettings;
	private settingTab!: OuraMetricsSettingTab;

	async onload() {
		await this.loadSettings();

		addIcon(OURA_ICON_ID, OURA_ICON_SVG);

		this.addRibbonIcon(OURA_ICON_ID, 'Oura Metrics: generate summary', () => {
			void this.generate(this.defaultWindow());
		});

		for (const w of WINDOWS) {
			this.addCommand({
				id: `oura-metrics-${w.id}`,
				name: `Generate summary (last ${w.label})`,
				icon: OURA_ICON_ID,
				callback: () => void this.generate(w),
			});
		}

		// Oura redirects to obsidian://oura-metrics#access_token=… after consent.
		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			void this.completeAuthorization(fieldsFromProtocol(params));
		});

		this.settingTab = new OuraMetricsSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.syncSearchExclusion();
	}

	onunload() {}

	async loadSettings() {
		const saved = ((await this.loadData()) ?? {}) as Partial<OuraMetricsSettings> & {
			token?: unknown;
		};
		// `token` held a personal access token; Oura retired those in December 2025.
		const { token: legacyToken, ...current } = saved;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, current);
		if (legacyToken !== undefined) await this.saveSettings();
	}

	/** data.json changed outside the app — `npm run install:vault` writing the client ID, or sync. */
	async onExternalSettingsChange() {
		await this.loadSettings();
		this.settingTab.refreshAccount();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Send the user to Oura's consent page; the answer comes back via the protocol handler. */
	async startAuthorization(): Promise<void> {
		const { clientId } = this.settings;
		if (!clientId) {
			new Notice('Oura Metrics: add your Oura application’s client ID first.', 8000);
			return;
		}
		this.settings.oauthState = newState();
		await this.saveSettings();
		window.open(authorizeUrl(clientId, this.settings.oauthState));
	}

	/** Store the access token from Oura's redirect, or say why it was refused. */
	async completeAuthorization(fields: URLSearchParams): Promise<void> {
		try {
			const grant = parseAuthorizationResponse(fields, this.settings.oauthState, Date.now());
			this.settings.accessToken = grant.accessToken;
			this.settings.tokenExpiresAt = grant.expiresAt;
			this.settings.oauthState = '';
			await this.saveSettings();
		} catch (err) {
			// Field names only: the values include the token.
			console.warn('Oura Metrics: authorization response rejected; fields:', [...fields.keys()], err);
			new Notice(`Oura Metrics: ${err instanceof Error ? err.message : String(err)}`, 12000);
			return;
		}
		this.settingTab.refreshAccount();
		new Notice('Oura Metrics: connected to Oura.');
	}

	async disconnect(): Promise<void> {
		this.settings.accessToken = '';
		this.settings.tokenExpiresAt = 0;
		await this.saveSettings();
		this.settingTab.refreshAccount();
	}

	private defaultWindow(): SummaryWindow {
		const days = this.settings.defaultDays;
		return (
			WINDOWS.find((w) => w.days === days) ?? {
				id: `${days}d`,
				label: `${days} days`,
				days,
			}
		);
	}

	/** Fetch, derive, render, then write & open oura-metrics-YYYY-MM-DD.md. */
	async generate(summaryWindow: SummaryWindow): Promise<void> {
		if (!this.settings.accessToken) {
			new Notice('Oura Metrics: connect your Oura account in settings first.', 8000);
			return;
		}
		if (isExpired(this.settings.tokenExpiresAt, Date.now())) {
			new Notice('Oura Metrics: Oura access has expired. Reconnect in settings.', 8000);
			return;
		}

		const notice = new Notice(`Oura Metrics: fetching last ${summaryWindow.label}…`, 0);
		try {
			const now = new Date();
			// Oura's `day` is the wake day, so a night is reported on the morning it ends.
			// Reaching one day past today costs nothing and avoids clipping last night.
			const end = isoDate(new Date(now.getTime() + DAY_MS));
			// The reported window starts here — `days - 1` because today is one of them.
			// The fetch reaches three further weeks back: those days are never listed,
			// they are the baseline the window is read against.
			const windowStart = isoDate(new Date(now.getTime() - (summaryWindow.days - 1) * DAY_MS));
			const start = isoDate(
				new Date(
					now.getTime() - (summaryWindow.days - 1 + DEFAULT_BASELINE_WEEKS * 7) * DAY_MS,
				),
			);

			// `requestUrl` rather than `fetch`: not subject to the renderer's CORS
			// policy, and identical on mobile. `throw: false` because OuraClient
			// turns statuses into messages a user can act on.
			const client = new OuraClient(this.settings.accessToken, (request) =>
				requestUrl({ ...request, throw: false }),
			);
			const [sleep, dailySleep, dailyActivity, dailyReadiness] = await Promise.all([
				client.collect<SleepPeriod>('sleep', start, end),
				client.collect<DailyScore>('daily_sleep', start, end),
				client.collect<DailyActivity>('daily_activity', start, end),
				client.collect<DailyReadiness>('daily_readiness', start, end),
			]);

			const fetched = buildDays(
				{ sleep, dailySleep, dailyActivity, dailyReadiness },
				isoDate(now),
			);
			const { window: days, baseline } = splitWindow(fetched, windowStart);
			const markdown = renderNote(days, {
				windowLabel: summaryWindow.label,
				generatedAt: now,
				threshold: this.settings.threshold,
				baseline,
				baselineLabel: `the previous ${DEFAULT_BASELINE_WEEKS} weeks`,
				prompt: this.settings.promptTemplateEnabled
					? renderPrompt(this.settings.promptTemplate, now, summaryWindow.label)
					: undefined,
			});

			const file = await this.writeNote(markdown);
			this.syncSearchExclusion();
			notice.hide();
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (err) {
			console.error('Oura Metrics: generation failed', err);
			const detail =
				err instanceof OuraApiError && err.status === 401
					? `${err.message} Reconnect in settings.`
					: err instanceof Error
						? err.message
						: String(err);
			notice.setMessage(`Oura Metrics: ${detail}`);
			window.setTimeout(() => notice.hide(), 12000);
		}
	}

	/** Create (or overwrite same-day) the dated note in the configured folder. */
	private async writeNote(contents: string): Promise<TFile> {
		const stamp = isoDate(new Date());
		const folder = this.settings.outputFolder;
		const path = normalizePath(
			folder ? `${folder}/oura-metrics-${stamp}.md` : `oura-metrics-${stamp}.md`,
		);

		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {});
		}

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, contents);
			return existing;
		}
		return this.app.vault.create(path, contents);
	}

	/**
	 * Keep Obsidian's "Excluded files" list in sync with our settings, touching only the
	 * single filter we previously added so the user's own filters are never removed.
	 *
	 * `getConfig`/`setConfig` are stable-but-untyped internal APIs backing the Settings →
	 * Files and links UI; a narrow local interface keeps the access type-checked.
	 */
	syncSearchExclusion(): void {
		const vault = this.app.vault as unknown as VaultConfigAccess;
		if (typeof vault.getConfig !== 'function' || typeof vault.setConfig !== 'function') return;

		const current = vault.getConfig('userIgnoreFilters');
		const filters = Array.isArray(current) ? current.filter((f): f is string => typeof f === 'string') : [];

		const previous = this.settings.appliedIgnoreFilter;
		const folder = this.settings.outputFolder.replace(/^\/+|\/+$/g, '');
		const desired = this.settings.excludeFromSearch
			? folder || String.raw`/^oura-metrics-.*\.md$/`
			: '';

		const next = previous ? filters.filter((f) => f !== previous) : filters.slice();
		if (desired && !next.includes(desired)) next.push(desired);

		if (previous !== desired || next.length !== filters.length) {
			vault.setConfig('userIgnoreFilters', next);
			this.settings.appliedIgnoreFilter = desired;
			void this.saveSettings();
		}
	}
}

/** Substitute the prompt placeholders. */
export function renderPrompt(template: string, now: Date, windowLabel: string): string {
	return template
		.replace(/\{\{date\}\}/g, now.toLocaleDateString(undefined, { dateStyle: 'full' }))
		.replace(/\{\{time\}\}/g, now.toLocaleTimeString(undefined, { timeStyle: 'short' }))
		.replace(/\{\{window\}\}/g, windowLabel);
}

interface VaultConfigAccess {
	getConfig(key: string): unknown;
	setConfig(key: string, value: unknown): void;
}
