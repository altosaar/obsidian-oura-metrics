# Oura Metrics

An Obsidian plugin that turns your Oura data into one LLM-ready markdown note —
7 days, 2 weeks, or 4 weeks — ready to paste into a chat.

A companion to [Microlite](https://github.com/altosaar/obsidian-microlite) ([Obsidian plugin link](https://community.obsidian.md/plugins/microlite)),
which does the same for your note edits. Same shape: tap the ribbon icon, get a
dated note in a folder, paste it somewhere useful.

## The idea

Oura's app shows you today. This note shows each metric's **change from your own
recent baseline over weeks**, including its spread, not just its average.

It reports a small, fixed set of scalars and nothing else. Every extra field is
context an LLM has to wade through, and noise it can pattern-match against.

## What it reports

**Sleep** — total sleep, efficiency, onset latency, deep/REM/light as a percentage
of total sleep time, midsleep clock time, sleep score.

**Physiology and activity** — nocturnal resting and average heart rate, HRV
(RMSSD), respiratory rate, skin-temperature deviation, activity score, active MET
minutes, within-day activity CV.

**Derived** — the window measured against **the three weeks before it**: each metric's
mean and SD for both periods, the change between them in the metric's own unit and in
baseline SDs, a 7-night rolling SD of sleep duration, and every day sitting beyond
±1.5 SD of the baseline.

### The baseline is the weeks before the window, not the window

A window that is its own baseline cannot see a shifted week. Take seven nights of five
hours' sleep: measured against their own mean, every one of them is unremarkable. So the
fetch reaches three weeks further back than the window it prints. Those days are never
listed — they set the mean and SD everything in the window is read against.

`z` is the difference between the two means in *baseline* SDs (a standardized mean
difference against a reference period), not a test statistic. Dividing by the standard
error instead would call nearly every week significant: n is 7 and consecutive nights are
correlated. Read ±0.5 as visible and ±1 as pronounced, and look at several metrics
together before either.

Both periods report an SD, not just a mean: a week can hold its average and still
scatter far more than the weeks before it.

### What it deliberately omits

The intra-night hypnogram and the 1440-point daily MET series never appear. They
are reduced to scalars — stage percentages, one activity CV per day. A language
model reads a 288-character stage string poorly and a single number well.

## Setup

```bash
npm install
npm run install:vault    # builds, then copies into the vault in .vault-path
```

`.vault-path` is a gitignored one-line file holding the absolute path to your
vault (or set `OBSIDIAN_VAULT`). Then enable **Oura Metrics** in Settings →
Community plugins, and paste a token from
[cloud.ouraring.com/personal-access-tokens](https://cloud.ouraring.com/personal-access-tokens).

The token lives in the vault's plugin data (`.obsidian/plugins/oura-metrics/data.json`),
never in git. It is stored in plaintext — Obsidian gives a plugin nowhere else to
persist settings — so if your vault syncs to a cloud service, the token syncs with it.
It is a read-only credential; revoke it at
[cloud.ouraring.com](https://cloud.ouraring.com/personal-access-tokens) if needed.

## Use

Tap the ribbon icon, or run **Generate summary (last 7 days / 2 weeks / 4 weeks)**
from the command palette. A dated note — `oura/oura-metrics-YYYY-MM-DD.md` —
opens, ready to copy.

Settings cover the token, output folder, default window, deviation threshold,
whether the output folder is excluded from search, and the prompt template that
leads each note (placeholders: `{{date}}`, `{{time}}`, `{{window}}`). The prompt
is saved in the vault's plugin data, so a personal prompt never touches the repo.

### Headless, for automation

The headless CLI lives in [petrograph](https://github.com/altosaar/petrograph)
(`tools/oura_metrics.ts`), which pins this repo as a submodule and calls the very
same `buildDays` and `renderNote` the plugin does — so the note reaching a model
is the note you have reviewed by eye. `OuraClient` takes its HTTP transport as a
constructor argument, so the plugin passes `requestUrl` and the CLI passes
`fetch` without either importing the other's.

## Three things that are easy to get wrong

**Midsleep is computed in the timestamp's own timezone**, not the machine's. Oura
records the UTC offset the ring was in, and that is the clock that matters — a
night slept in Lisbon should read as Lisbon local time no matter where the note is
generated later. Using `getHours()` would silently re-clock your whole history when
you travel.

**Today's activity is partial and excluded from baselines.** Last night's sleep is
complete by morning, but the day's activity is not — a run at noon sees a third of
a day. Those values are shown (marked `*`) but kept out of the mean, or every
pre-bedtime run would flag a phantom collapse in activity *and* drag the baseline
the other days are compared against. Sleep on the same row still counts.

**Stage percentages are of total sleep time, not time in bed.** Dividing by time in
bed silently deflates every stage by the awake fraction.

## Caveats, stated in the note itself

Deviations are measured against *the previous three weeks*. That is a real reference
period rather than the window judging itself, but it inherits whatever those weeks
were: if they were already unusual, the current one reads as normal. Several metrics
moving together say more than any single flag. Sleep stages from a consumer ring are
estimates, so stage percentages are trend indicators, not measurements.

## Icon

A pixel-art crescent moon, mirrored across the vertical centre line so it opens
to the upper right. [`assets/moon.svg`](assets/moon.svg) is the standalone file;
`src/icon.ts` inlines the same markup for `addIcon()`.

It is traced one rect per grid cell rather than with potrace or Inkscape. Vector
tracing smooths the staircase edges into curves, which destroys the pixel-art
look that is the whole point. The source PNG turned out to be a 16×16 grid
upscaled (the 32px file tiles cleanly at 2px blocks, and the 100px file agrees
with it on all 256 cells), so each cell maps to exactly 6.25 units of Obsidian's
0 0 100 100 viewBox. Adjacent cells are merged into maximal blocks — 35 cells
become 15 rects. Rasterizing the result back to 32px matches the mirrored source
1024/1024 pixels.

Icon from [Icons8](https://icons8.com).

## Development

```bash
npm test           # unit tests over the metric derivations and rendering
npm run dev        # esbuild watch
npm run build      # typecheck + production bundle
```

`src/metrics.ts` and `src/render.ts` are free of Obsidian imports, so the whole
derivation and rendering path is testable in plain Node.
