import { App, PluginSettingTab, Setting } from 'obsidian';
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Personal access token')
			.setDesc(
				createFragment((f) => {
					f.appendText('Create one at ');
					f.createEl('a', {
						text: 'cloud.ouraring.com/personal-access-tokens',
						href: 'https://cloud.ouraring.com/personal-access-tokens',
					});
					f.appendText('. Stored in this vault’s plugin data.');
				}),
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setPlaceholder('paste token')
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Output folder')
			.setDesc('Where the dated notes are written. Leave empty for the vault root.')
			.addText((text) =>
				text.setValue(this.plugin.settings.outputFolder).onChange(async (value) => {
					this.plugin.settings.outputFolder = value.trim().replace(/^\/+|\/+$/g, '');
					await this.plugin.saveSettings();
					this.plugin.syncSearchExclusion();
				}),
			);

		new Setting(containerEl)
			.setName('Default window')
			.setDesc('The window the ribbon icon uses.')
			.addDropdown((drop) =>
				drop
					.addOptions({ '7': '7 days', '14': '14 days', '28': '28 days' })
					.setValue(String(this.plugin.settings.defaultDays))
					.onChange(async (value) => {
						this.plugin.settings.defaultDays = Number(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Deviation threshold')
			.setDesc('How many standard deviations from the window mean before a day is flagged.')
			.addDropdown((drop) =>
				drop
					.addOptions({ '1': '1.0 SD', '1.5': '1.5 SD', '2': '2.0 SD' })
					.setValue(String(this.plugin.settings.threshold))
					.onChange(async (value) => {
						this.plugin.settings.threshold = Number(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Exclude output folder from search')
			.setDesc('Keeps generated notes out of Search, Quick switcher, Graph and backlinks.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.excludeFromSearch).onChange(async (value) => {
					this.plugin.settings.excludeFromSearch = value;
					await this.plugin.saveSettings();
					this.plugin.syncSearchExclusion();
				}),
			);

		new Setting(containerEl)
			.setName('Prompt template')
			.setDesc('Lead each note with a prompt. Placeholders: {{date}}, {{time}}, {{window}}.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.promptTemplateEnabled).onChange(async (value) => {
					this.plugin.settings.promptTemplateEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Prompt text')
			.setClass('oura-metrics-prompt')
			.addTextArea((area) => {
				area.inputEl.rows = 12;
				area
					.setValue(this.plugin.settings.promptTemplate)
					.onChange(async (value) => {
						this.plugin.settings.promptTemplate = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
