# NexStar Fleet Reporter

The Tampermonkey userscript that reports your **Nexus Legacy** fleet positions to
the NAV/Commonwealth NexStar map, and answers the map's fuel-estimate and
own-planet logistics requests. **Your session token never leaves your browser** —
the script only sends already-fetched fleet data to the map's ingest server,
authenticated by a personal key you get from the Discord bot.

## Install

1. Install the **Tampermonkey** browser extension.
2. Open the raw script and click **Install** in Tampermonkey:
   **[nexstar-fleet-reporter.user.js](https://raw.githubusercontent.com/tmfink10/nexstar-reporter/main/nexstar-fleet-reporter.user.js)**
3. In Discord, run `/userscript` to get your personal key, then set it via the
   Tampermonkey menu → **Set NexStar key**.
4. Reload your Nexus Legacy game tab.

## Updating

There is **no silent auto-update** (see Security). The script checks the
published version and, when a new one exists, shows a **"⬆ Update"** item in the
Tampermonkey menu — clicking it opens this install page so you can review and
install the new version yourself.

## Security

This script runs on the game origin with your live session, so its update and
write behavior is deliberately locked down:

- **Hosted here, on a public branch-protected GitHub repo** — not on the map's
  server. Every version is a reviewed git commit; a compromise of the map's VPS
  cannot change what you install or run.
- **No silent auto-update.** `@updateURL`/`@downloadURL` are intentionally
  absent, so nothing can background-install new code. Updates are a deliberate,
  reviewable act.
- **Writes are gated.** Only a transfer/deliver to one of *your own* planets runs
  without a prompt. Anything else — hostile, off-target, gift, garrison, spy, or
  a move to a moon — requires an explicit confirmation **in the game tab** and
  fails closed if it can't be shown. So even a compromised map can only *ask*;
  only you can approve a dangerous action.

If you can read code, you're encouraged to skim the script before installing —
that's the point of hosting it in the open.

## Reporting issues

Ping an officer in the NAV/Commonwealth Discord.
