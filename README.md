# harjitsgill.com

Harjit Singh Gill's personal site. One page (`index.html`), hosted free on GitHub Pages,
domain through Cloudflare. Pushing to `main` publishes it within a couple of minutes.

## Where things are

| What | Where |
|---|---|
| The site | `index.html` (palette, three languages, and seasonal effects are all inside it) |
| Spring theme, saved copy | `themes/spring.html` |
| Election tracker and polls (2026), taken down 2026-11-19 | branch `archive/election-tracker-2026` |
| How to restore or rebuild the election tracker | `docs/election-tracker-playbook.md` |
| Publishing workflow | `.github/workflows/pages.yml` |

## Working on it with Claude

Connect this repo in a new Claude chat, then ask in plain words. Examples:

- "Update my Now, Watching and Listening lines to ..." (the old lines move into the
  "Previously" log).
- "Pin the site to the winter theme" (see `SEASON_OVERRIDE` in `index.html`; otherwise it
  switches by date: autumn Sept 22, winter Dec 21, spring Mar 20). Preview a season with
  `?season=winter` on the address.
- "Restore the election tracker from the `archive/election-tracker-2026` branch" or
  "Rebuild it for the [year] election" (read `docs/election-tracker-playbook.md` first).

Never put a phone number or salary on the site. Keep the WellSpace wording modest.
