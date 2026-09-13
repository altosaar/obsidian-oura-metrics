import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import type OuraMetricsPlugin from './main';

export interface OuraMetricsSettings {
	/** Oura personal access token. Stored in the vault's plugin data, never in git. */
	token: string;
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
	token: '',
	outputFolder: 'oura',
	defaultDays: 14,
	threshold: 1.5,
	promptTemplateEnabled: true,
	promptTemplate: DEFAULT_PROMPT,
	appliedIgnoreFilter: '',
	excludeFromSearch: true,
};

export class OuraMetricsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: OuraMetricsPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Personal access token',
				desc: createFragment((f) => {
					f.appendText('Create one at ');
					f.createEl('a', {
						text: 'cloud.ouraring.com/personal-access-tokens',
						href: 'https://cloud.ouraring.com/personal-access-tokens',
					});
					f.appendText('. Stored in this vault’s plugin data.');
				}),
				// Rendered by hand: the declarative text control can't mask its input.
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'password';
						text.setPlaceholder('paste token')
							.setValue(this.plugin.settings.token)
							.onChange(async (value) => {
								this.plugin.settings.token = value.trim();
								await this.plugin.saveSettings();
							});
					});
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
}
