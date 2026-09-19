# Pham's Chickens — 3x daily SMS reports via GitHub Actions

No Worker, no Vercel function, no plan upgrade. Two files in the repo you're
already pushing to, and GitHub runs them on schedule for free.

## Why not Vercel cron

Vercel's Hobby plan only allows cron jobs that run **once per day** — a
three-times-daily schedule is rejected at deploy time, not at runtime. Lifting
that means Pro at $20/month. GitHub Actions has no such limit on scheduled
workflows, and your code is already there.

## Install

Copy these two into your repo, keeping the paths:

```
scripts/farm-report.mjs
.github/workflows/farm-report.yml
```

Commit and push. That's the whole deploy — no build step, nothing added to your
HTML, nothing that touches the site.

## Secrets

GitHub → your repo → **Settings → Secrets and variables → Actions → New
repository secret**. Six of them:

| Name | Value |
|---|---|
| `SENSAPHONE_USER` | your Sensaphone.net username |
| `SENSAPHONE_PASS` | your Sensaphone.net password |
| `TWILIO_SID` | Account SID, starts with `AC` |
| `TWILIO_TOKEN` | Auth token |
| `TWILIO_FROM` | your Twilio number, `+18005551234` |
| `SMS_TO` | `+17634451162,+18172019844` |

Secrets are encrypted, masked in logs, and not visible to anyone who can only
read the repo. **If the repo is public, Actions logs are public too** — the
script never prints credentials, but it does print the report text. If you'd
rather the readings not be public, make the repo private (Actions is still free,
2,000 minutes/month, and this uses roughly 3).

Consider making a second Sensaphone user for this rather than using your own
admin login, so rotating it later doesn't lock you out of anything else.

## Test before it can text anyone

Actions tab → **Farm report** → **Run workflow** → mode `preview`, slot
`morning`. It prints the message and sends nothing.

Read that output carefully. The per-house grouping keys off the word "House"
plus a number in your Sensaphone zone names ("House 3 Temp"). If your zones are
named differently, everything lands under loose inputs instead of H1/H2/H3 and
one regex in `classify()` needs adjusting — send me the preview and I'll fix it.

When it looks right, run it again with mode `send` to fire a real text.

## Schedule

6:00a / 12:00p / 8:00p Central. Six cron lines are registered because GitHub
cron is UTC-only with no DST handling; the script works out which one is
actually the right local time and exits quietly on the others. Nothing to change
in March or November.

**One caveat:** GitHub's scheduled runs are best-effort and often fire 5–30
minutes late during busy periods, occasionally longer. Fine for a status digest,
which is why the timing logic keys off the *intended* time rather than the clock
at run time — a late run still files as the right report. It is not fine for
emergencies. Keep the Sensaphone's own alarm dialing on for those.

## Offline watcher (every 10 minutes)

`scripts/offline-watch.mjs` + `.github/workflows/offline-watch.yml`. Signs in to
Sensaphone.net, checks whether it can still reach the monitor unit and whether
each house's inputs are answering, and keeps a shared log of the stretches they
were not. Nothing to install beyond the two files; it uses the same
`SENSAPHONE_USER` / `SENSAPHONE_PASS` secrets as the report.

- Writes to the **`data` branch** (created by the first run), never `main`, so
  a heartbeat never redeploys the site. `vercel.json` also tells Vercel to
  ignore that branch.
- `offline-log.json` holds the entries in the same shape the monitor page uses;
  `status.json` is a heartbeat (when it last ran, what it saw).
- The page reads both from `raw.githubusercontent.com` and merges the entries
  into its **Sensor log** on every phone, marked "farm watcher". The unit
  section shows **Farm watcher · checked N min ago**, and turns orange or red
  when runs are late or have stopped. That read only works while the repo is
  public; make it private and the page falls back to logging outages it sees
  itself.
- GitHub's schedule is best-effort — often 5–30 minutes late — so an entry's
  times are "as of the check", not to the second. A gap longer than 40 minutes
  between runs is treated as the watcher being down: anything open then is
  closed at the last run and says so, rather than guessing.
- GitHub turns off scheduled workflows after 60 days with no repo activity;
  the watcher's own commits count, so this keeps itself alive. If the tile
  ever says "stopped", the Actions tab → **Offline watcher** → **Enable
  workflow** brings it back.
- Cost: free on a public repo. On a private one, 144 runs a day round up to
  about 4,300 Actions minutes a month — over the free 2,000.

Test it once by hand: Actions tab → **Offline watcher** → **Run workflow**. The
`data` branch appears, and within a few minutes the page's unit section shows
the watcher heartbeat.

## Notes

- **Failures text you too.** If Sensaphone is unreachable or login is rejected,
  you get a short "REPORT FAILED" message. Silence at 6am is indistinguishable
  from good news, which is the worst way for this to break.
- **Device-offline is always flagged.** A dead Sensaphone shows its last known
  readings forever; that line is how you catch it.
- **The morning recap needs data logging enabled** per zone in Sensaphone.net.
  Without it there's no history and the overnight min/max section comes back
  empty.
- **Cost.** 3/day × 2 recipients ≈ 180 messages/month, ~2 segments each, about
  $2.80/month plus $1.15 for the number. GitHub Actions is free.
- US A2P 10DLC or toll-free verification is required for Twilio to reliably
  deliver to US numbers. Unregistered traffic gets filtered silently. Start that
  early — it takes a few business days.
