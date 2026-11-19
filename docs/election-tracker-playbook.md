# Election tracker playbook (2026 cycle)

How the Nov 2026 election tracker and poll pages on harjitsgill.com worked, how they
were taken down, and how to bring them back or rebuild them for a future election.

The pages were removed from the live site on 2026-11-19. Nothing was lost: the complete
working version is saved on the git branch **`archive/election-tracker-2026`** (never delete that branch).

## What existed

| Piece | Path | What it did |
|---|---|---|
| Results tracker | `/election/` | Live results for a hand-picked list of ~420 races (candidates endorsed or watched), with tabs/filters, called-race badges, and a "stale data" warning. |
| Poll pages | `/electionpolls/` | Polling average and individual polls per race, reading `electionpolls/data/polls.json`. |
| Redirect pages | `/mai/`, `/aapiforce/` | Tiny pages that redirect to `/election/?aapiforce`, a trimmed view showing only one list ("mine") for a friend/organization. |
| Updater | `scripts/election/` | Node scripts that pulled numbers from official state/county results sites and wrote JSON. |
| Automation | `.github/workflows/election-*.yml` | GitHub Actions: ran the updater every few minutes on election night and published the site. |

(`/dsatendencymap/` is a separate page and was not part of the tracker.)

## How it worked

1. **`election/data/races.json`** is the master list. Each race has an `id`, a `state`,
   `office`, `candidate`, `party`, `opponents`, `lists` (which tabs it appears under:
   `mine`, `dsa`, `wfp`, `watch`), and a `source` telling the updater where to get numbers
   (for example `{"type":"ca_sos","path":"insurance-commissioner"}`). It also holds
   `pollClose` times by state, so a race's feed stays hidden until its own polls close.
2. **`scripts/election/update.mjs`** reads that list, calls the matching adapter for each
   race, and writes `election/data/results.json` (real results) and
   `election/data/rehearsal.json` (the same pipeline run on the test data election offices
   post before election day, shown at `/election/?rehearsal`).
3. **`scripts/election/adapters.mjs`** has one function per results source: state sites
   (`ca_sos`, `mi_sos`, `oh_sos`, `nc_sbe`, `fl_dos`, `md_sbe`, `mn_sos`, `nm_sos`,
   `vt_sos`, `de_doe`, `ct_ems`, `dc_boe`, `in_enr`, `ny_enr`, `tx_civix`), county sites
   (`lavote`, `alameda`, `oc_hart`, `fresno`, `sf_doe`, `soe`), vendor platforms
   (`clarity`, `enhanced`), and `fox` (AP numbers via Fox News). Sites behind bot
   protection are loaded through a headless browser (`browser.mjs`, Playwright).
4. **`election/data/manual.json`** holds hand-entered numbers for races with no automatic
   feed (about a third of them). A manual entry wins over a feed unless marked
   `"fallback": true`, in which case the feed takes over as soon as it has real votes.
5. **`election/data/calls.json`** records race calls (AP or official) separately from the
   vote counts: `{ "<race id>": { "winner": "Full Name", "by": "AP", "at": "<ISO time>" } }`.
6. **`election/index.html`** is a single static page. It fetches `data/races.json` and
   `data/results.json` in the browser, refreshes on a timer, and shows a stale-data
   banner if `checkedAt` stops updating.
7. **`.github/workflows/election-results.yml`** ran the updater, committed only real
   changes ("Update election results"), and republished the site every run. It chained
   itself (each run waited, then triggered the next) because GitHub's cron is unreliable:
   about every 20 seconds of wait on election night (Nov 3 to 6), 4 minutes before, 12
   minutes after, and it stopped itself after Nov 11, 2026. The other `election-*.yml`
   files were manual helpers (test every feed, probe a URL, probe with a browser).
8. **Publishing:** GitHub Pages is set to deploy from **GitHub Actions**
   (`.github/workflows/pages.yml`), which avoids the 10-builds-per-hour limit of
   branch-based Pages builds.

## Bring the 2026 version back (to look at it, or reuse as-is)

To view it without touching the live site:

```bash
git clone https://github.com/harjitsgill1/harjit-site-
cd harjit-site-
git checkout archive/election-tracker-2026
# open election/index.html (data loads over http, so use: python3 -m http.server)
```

To restore it onto the live site, ask Claude: *"Restore the election tracker from the
`archive/election-tracker-2026` branch."* Or by hand:

```bash
git checkout main
git checkout origin/archive/election-tracker-2026 -- election electionpolls aapiforce mai scripts/election .github/workflows
git commit -m "Restore election tracker" && git push
```

Note the workflow's season dates (Nov 2026) will make it stop immediately; see below.

## Rebuild it for a new election (2028 or an off-year)

Ask Claude something like:

> Rebuild the election tracker from the `archive/election-tracker-2026` branch for the **[month year]**
> election. My races are: [list or spreadsheet]. Keep the same design and tabs.

Claude will need from you: the election date and poll-close times, your list of races
(candidate, office, state/district, party, which tab each belongs on), and whether you want
polls. Then the work is:

1. **Restore the files** from the archive branch (command above).
2. **Update dates** in three places: `FIRST_POLLS_CLOSE` and the dates in
   `scripts/election/update.mjs`; `ELECTION` in `adapters.mjs` (`ymd`, `mdY`); and the
   season dates in `election-results.yml` (the `2026-11-11` stop date, `night_start`,
   `night_end`). Update `election` and `pollClose` in `races.json`.
3. **Replace the race list** in `races.json`; clear `manual.json`, `calls.json`,
   `results.json`, `rehearsal.json`, and `polls.json`.
4. **Point each race at a source.** Reuse an adapter if that state or county already has
   one. Results pages change address and layout every cycle, so expect to fix several
   adapters. Use the `election-test` workflow, which reports each feed's result, and the
   probe workflows, which download a page so its format can be inspected. Races with no
   good source go in `manual.json`.
5. **Run a rehearsal** before election day: the updater builds `rehearsal.json` from the test
   data offices post, viewable at `/election/?rehearsal`.
6. **Turn the schedule on** (the workflow runs every 5 minutes at first, then chains).
   Make sure Settings > Pages > Source is **GitHub Actions**.
7. **During the night:** hand-enter anything the feeds miss in `manual.json`, and add AP
   calls to `calls.json`.
8. **Afterward, take it down:** delete the folders and workflows (the archive branch keeps them),
   delete the redirect pages, and save the cycle on an archive branch (for example `archive/election-tracker-2028`).

## Taking it down (what was done on 2026-11-19)

Removed `election/`, `electionpolls/`, `aapiforce/`, `mai/`, `scripts/election/`, and all
`.github/workflows/election-*.yml`; deleted nothing from git history; saved the last full version as the
`archive/election-tracker-2026` branch first. Anyone visiting `/election/` now gets a 404.

## Good to know

- No passwords, API keys, or tokens are used: every source is a public results page.
  The workflows use only GitHub's built-in token.
- This documentation file is itself public (everything in this repo is served).
- Cost: free. The only limits were GitHub Actions minutes and Pages build limits.
