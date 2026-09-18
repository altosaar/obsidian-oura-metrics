import { App, PluginSettingTab, type ButtonComponent, type SettingDefinitionItem } from 'obsidian';
import type OuraMetricsPlugin from './main';
import { REDIRECT_URI, isExpired } from './oauth';

export interface OuraMetricsSettings {
	/** Client ID of the user's own Oura OAuth application. */
	clientId: string;
	/** OAuth access token. Stored in the vault's plugin data, never in git. */
	accessToken: string;
	/** Epoch ms when `accessToken` expires; 0 when unknown. */
	tokenExpiresAt: number;
	/** `state` of the authorization in flight, persisted in case the app restarts mid-flow. */
	oauthState: string;
	/** Folder the dated notes are written to. Empty means vault root. */
	outputFolder: string;
	/** Window the ribbon icon uses, in days. */
	defaultDays: number;
	/** SD threshold for flagging a day as deviating from the window baseline. */
	threshold: number;
	promptTemplateEnabled: boolean;
	promptTemplate: string;
	/** Tracks the "Excluded files" entry we added, so we only ever remove our own. */
	appliedIgnoreFilter: string;
	excludeFromSearch: boolean;
}

export const DEFAULT_PROMPT = `Below is a {{window}} summary of my Oura ring sleep and activity metrics, generated {{date}}.

Please:
1. Note what stands out against the baseline period, and explicitly say when nothing does.
2. Distinguish what looks like real change from what is likely noise at this sample size.
3. Flag which metrics are too sparse to read yet.

Don't manufacture a pattern if the data doesn't support one.`;

export const DEFAULT_SETTINGS: OuraMetricsSettings = {
	clientId: '',
	accessToken: '',
	tokenExpiresAt: 0,
	oauthState: '',
	outputFolder: 'oura',
	defaultDays: 14,
	threshold: 1.5,
	promptTemplateEnabled: true,
	promptTemplate: DEFAULT_PROMPT,
	appliedIgnoreFilter: '',
	excludeFromSearch: true,
};

export class OuraMetricsSettingTab extends PluginSettingTab {
	/** Set while the account row is on screen, so a finished connection can update it. */
	private repaintAccount: (() => void) | undefined;

	constructor(
		app: App,
		private readonly plugin: OuraMetricsPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Client ID',
				desc: createFragment((f) => {
					f.appendText('Register an application at ');
					f.createEl('a', {
						text: 'cloud.ouraring.com/oauth/applications',
						href: 'https://cloud.ouraring.com/oauth/applications',
					});
					f.appendText(' with the redirect URI ');
					f.createEl('code', { text: REDIRECT_URI });
					f.appendText(', then paste its client ID. No client secret is needed.');
				}),
				control: { type: 'text', key: 'clientId', placeholder: 'client ID' },
			},
			{
				name: 'Oura account',
				render: (setting) => {
					let connect: ButtonComponent | undefined;
					let disconnect: ButtonComponent | undefined;
					setting
						.addButton((button) => {
							connect = button
								.setCta()
								.onClick(() => void this.plugin.startAuthorization());
						})
						.addButton((button) => {
							disconnect = button
								.setButtonText('Disconnect')
								.onClick(() => void this.plugin.disconnect());
						});

					this.repaintAccount = () => {
						const { accessToken, tokenExpiresAt } = this.plugin.settings;
						setting.setDesc(accountStatus(accessToken, tokenExpiresAt, Date.now()));
						connect?.setButtonText(accessToken ? 'Reconnect' : 'Connect');
						disconnect?.buttonEl.toggle(accessToken !== '');
					};
					this.repaintAccount();
					return () => {
						this.repaintAccount = undefined;
					};
				},
			},
			{
				name: 'Output folder',
				desc: 'Where the dated notes are written. Leave empty for the vault root.',
				control: { type: 'text', key: 'outputFolder' },
			},
			{
				name: 'Default window',
				desc: 'The window the ribbon icon uses.',
				control: {
					type: 'dropdown',
					key: 'defaultDays',
					options: { '7': '7 days', '14': '14 days', '28': '28 days' },
				},
			},
			{
				name: 'Deviation threshold',
				desc: 'How many standard deviations from the window mean before a day is flagged.',
				control: {
					type: 'dropdown',
					key: 'threshold',
					options: { '1': '1.0 SD', '1.5': '1.5 SD', '2': '2.0 SD' },
				},
			},
			{
				name: 'Exclude output folder from search',
				desc: 'Keeps generated notes out of Search, Quick switcher, Graph and backlinks.',
				control: { type: 'toggle', key: 'excludeFromSearch' },
			},
			{
				name: 'Prompt template',
				desc: 'Lead each note with a prompt. Placeholders: {{date}}, {{time}}, {{window}}.',
				control: { type: 'toggle', key: 'promptTemplateEnabled' },
			},
			{
				name: 'Prompt text',
				// Rendered by hand to keep the `oura-metrics-prompt` class styles.css targets.
				render: (setting) => {
					setting.setClass('oura-metrics-prompt').addTextArea((area) => {
						area.inputEl.rows = 12;
						area.setValue(this.plugin.settings.promptTemplate).onChange(async (value) => {
							this.plugin.settings.promptTemplate = value;
							await this.plugin.saveSettings();
						});
					});
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		const value: unknown = this.plugin.settings[key as keyof OuraMetricsSettings];
		// The dropdowns hold strings; the settings hold numbers.
		return typeof value === 'number' ? String(value) : value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key) {
			case 'clientId':
				settings.clientId = String(value).trim();
				break;
			case 'outputFolder':
				settings.outputFolder = String(value).trim().replace(/^\/+|\/+$/g, '');
				break;
			case 'defaultDays':
			case 'threshold':
				settings[key] = Number(value);
				break;
			case 'excludeFromSearch':
			case 'promptTemplateEnabled':
				settings[key] = value === true;
				break;
		}
		await this.plugin.saveSettings();
		if (key === 'outputFolder' || key === 'excludeFromSearch') {
			this.plugin.syncSearchExclusion();
		}
	}

	/** Bring the account row up to date after connecting or disconnecting. */
	refreshAccount(): void {
		this.repaintAccount?.();
	}
}

function accountStatus(accessToken: string, expiresAt: number, now: number): string {
	if (!accessToken) return 'Not connected.';
	if (!expiresAt) return 'Connected.';
	const date = new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
	return isExpired(expiresAt, now)
		? `Access expired ${date}. Reconnect to keep generating notes.`
		: `Connected until ${date}. Oura’s client-side flow can’t renew access, so reconnect then.`;
}
