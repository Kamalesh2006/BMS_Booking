# IMAX Saturday Checker

I wanted IMAX tickets for **The Odyssey** in Chennai on a Saturday, and BookMyShow
doesn't tell you when a date opens for booking — it just quietly becomes clickable
at some point. Rather than refresh the page all day, I wrote this.

It checks the page once an hour on GitHub Actions and emails me the moment an
upcoming Saturday goes on sale. One HTTP request per run, and it runs whether or
not my laptop is on.

If you found this repo looking for how to scrape BookMyShow, skip to
[What I learned about their bot protection](#what-i-learned-about-their-bot-protection).
That's the part worth your time — most of the obvious approaches don't work, and
I'd rather you not lose the afternoon I lost.

---

## What it does

Once an hour it loads the movie's showtimes page, reads which dates are
currently bookable, and compares that against the next couple of Saturdays. When
one flips to on-sale, I get an email with a direct booking link.

A real run looks like this:

```
Today (IST): 2026-07-28
Watching:    Saturday, 1 August 2026, Saturday, 8 August 2026

Loading https://in.bookmyshow.com/movies/chennai/the-odyssey/buytickets/ET00480917

   attempt 1/3
   posing as: nvidia-gtx1650-desktop | 6 cores | 16 GB (deviceMemory 8) | 1536x864@1.25 | viewport 1536x713 | seed 99887766-1#1
   Google Chrome 144.0.7559.132
   loaded ok (HTTP 200, 282745 bytes)

Booking window on sale: 20260728, 20260729
Strip covers:           20260728, 20260729, 20260730, 20260731, 20260801, 20260802, 20260803

Saturday, 1 August 2026 [20260801] -> listed but not on sale
Saturday, 8 August 2026 [20260808] -> not in booking window yet
```

It remembers what it has already told me, so I get **one email per date** — not
one an hour for a week. If a date goes on sale and then disappears, the
alert re-arms.

There's a **second alert for when the checker itself breaks**. If three runs in a
row fail to read the page, it emails me — from a different template, so it's
obvious at a glance which kind of mail it is — with a link to the failing workflow
run. A monitor that silently stops monitoring is worse than no monitor, and that's
exactly how I'd miss the tickets.

---

## What I learned about their bot protection

BookMyShow sits behind Cloudflare, and I got 403'd a lot before this worked. Three
findings, all from testing against the live site rather than guessing:

### 1. The showtimes API is unreachable, full stop

The page renders showtimes client-side by calling
`/api/movies-data/v5/showtimes-by-event/primary-dynamic`. **That endpoint 403s for
automated browsers** and I could not get past it. I tried headless and headful,
bundled Chromium and real Google Chrome, honest and spoofed user-agents, with and
without fingerprint patching. All 403.

So the rendered page shows *"Oops! Something went wrong"* and contains **zero
showtimes**. If you scrape the DOM you get nothing — and worse, nothing looks
exactly like "no tickets yet", so a naive scraper fails silently forever. That was
my first version, and it would never have fired.

The way through: the same payload is **embedded in the HTML** as
`window.__INITIAL_STATE__`, which ships with the document and isn't behind that
rule.

### 2. Inside that state, most of the obvious signals are traps

| Candidate signal | Verdict |
|---|---|
| Rendered DOM showtimes | Always empty — the XHR is blocked |
| `__INITIAL_STATE__` showtime list | **Useless.** Always contains *today's* schedule no matter which date the URL asks for. I verified it byte-identical for dates months out |
| `IMAX 2D` chip's `isDisabled` flag | **Misleading.** It means "IMAX is the currently-selected format", not "unavailable" |
| **Date strip `styleId`** | **This is the one.** Genuinely per-date |

Each date in the strip carries `styleId: "date-selected"` / `"date-default"` when
it's on sale, or `"date-disabled"` when it isn't — and disabled dates are rendered
without a `cta` at all. One page load reports every date at once, which is why
this only needs a single request per run instead of one per Saturday.

Because the event code in the URL (`ET00480917`) is the **IMAX 2D** event
(`the-odyssey-imax-2d`), a date going on sale on this page *is* IMAX going on sale.
No format filtering needed.

### 3. Two things get you a 200, and one is the opposite of standard advice

- **Don't warm up the session.** Every scraping guide says to hit the homepage
  first to look natural. Here it does the opposite: the homepage makes Cloudflare
  issue a bot-management cookie that gets your *next* request 403'd. Going straight
  to the target page on a cold context returns 200. Every retry in this code uses a
  brand-new browser context so that cookie is never carried over.
- **Use a Windows user-agent.** Chrome's honest Linux UA gets 403'd by a WAF rule.
  The identical request with a Windows UA passes.

### 4. A repeated fingerprint is its own signal

Loading the same URL every hour from a machine that reports byte-identical
hardware every time is the pattern that earns you a CAPTCHA even when each
individual request looks fine. So `fingerprint.js` generates a **synthetic
machine** per run — GPU, CPU core count, RAM, display, storage quota, network —
and `stealth.js` installs it.

The thing that actually matters is **coherence, not randomness**. Bot scoring
doesn't look for unusual values, it looks for combinations that can't exist. A
profile is therefore built outward from a machine archetype, and everything else
is derived from it:

| Claim | Constrained by |
|---|---|
| `deviceMemory` | Capped at 8 and quantised. A 32 GB box **must** still report 8 — reporting 16 is not a rare machine, it's an impossible one |
| `hardwareConcurrency` | Drawn from what that archetype ships with |
| WebGL renderer | Paired vendor/renderer strings, plus the **D3D11 limits** — rewriting `RTX 3060` while `MAX_TEXTURE_SIZE` stays at SwiftShader's 8192 is worse than not lying |
| `screen.avail*` | Smaller than `screen.*` by a taskbar; headless makes them equal |
| `outerHeight` | Larger than `innerHeight` by the toolbar; headless makes them equal |
| `jsHeapSizeLimit` | V8 picks it from installed RAM, so it has to track the RAM figure |
| `navigator.languages` | Must match the `Accept-Language` header, in both directions |

Three findings from building it that I didn't expect:

- **`--disable-gpu` was making things worse.** It removes the WebGL context
  entirely, and a desktop Chrome with no WebGL is rarer than one with a strange
  renderer. Dropping it and rewriting SwiftShader's strings *and limits* is the
  better trade.
- **Bundled Chromium announces itself in `sec-ch-ua`** as
  `"HeadlessChrome";v="151"`. No amount of JavaScript patching helps — it's on
  the wire before your code runs. It can't be hardcoded either, since the GREASE
  brand and its punctuation change every release, so the value is read off the
  browser itself via a throwaway loopback request and rewritten. (Real Chrome
  gets this right and is left alone.)
- **Most stealth snippets add `chrome.runtime`. Real Chrome doesn't have it**
  unless an extension is installed — I checked. Adding it is a flag, not a fix.

Each retry within a run also draws a *different* machine: re-requesting with the
fingerprint that was just refused is the one thing guaranteed not to help.

Canvas and audio readbacks get a small deterministic perturbation seeded from the
profile, so the hash is stable within a page load — a canvas that returns
different bytes on two reads is a louder signal than a stable odd one — while
differing between runs.

The seed is printed in every run's log, and setting `FINGERPRINT_SEED` to it
reproduces that machine exactly, which is what makes a blocked run debuggable.

Real Google Chrome is used when available, bundled Chromium as fallback. Both are
verified to produce a self-consistent fingerprint, but Chrome is the better
target — it needs fewer corrections, because most of what's being corrected *is*
the difference between it and headless Chromium.

### What this does *not* do

I want to be straight about the limits, because plenty of blog posts on this topic
aren't:

- It **does not** solve an interactive CAPTCHA. Nothing here clicks a checkbox.
  The fingerprinting is aimed at not being *served* one; once you have been, it's
  no help at all.
- It **does not** help if the IP itself is banned. That's decided at the network
  layer before any of your JavaScript runs. If GitHub's runner IPs get blocked, the
  only real fix is a residential proxy (`PROXY_URL`).
- It **does not** spoof fonts, and TLS/HTTP2 fingerprinting is untouched — both
  are below the level Playwright gives you access to. A determined WAF can still
  tell.
- It's tuned to one movie in one city. See [Pointing it elsewhere](#pointing-it-elsewhere).

When it *is* blocked it says so loudly and saves a screenshot, rather than
reporting "no tickets yet" and letting me miss the release.

---

## Run your own copy

### 1. Fork or clone
Keep `.github/workflows/` intact — that path is what makes Actions pick it up.

> `.gitignore` excludes `.env`, which holds your EmailJS **private key**. Keep it
> that way. Credentials belong in GitHub Secrets, not in the repo.

### 2. Set up EmailJS
1. Sign up at <https://www.emailjs.com>
2. **Email Service** → connect Gmail
3. Create **two Email Templates**, both using the variables `{{subject}}`,
   `{{message}}` and `{{to_email}}`:
   - one for **"tickets are open"** alerts
   - one for **"the checker is broken"** warnings
   Two templates rather than one so a failure warning is visually distinct in the
   inbox from the alert I'm actually waiting for — and so I can style the alert
   loudly without every error mail shouting too.
4. **Account → Security** → enable **"Allow non-browser use"**

That last step is not optional and the error message if you skip it is easy to
miss — EmailJS returns `403: API access from non-browser environments is currently
disabled`. This runs on a server, not in a browser. Enabling it is also what
reveals your **Private Key**.

### 3. Add repo secrets
Settings → Secrets and variables → Actions → **Secrets**:

| Secret | Required | Purpose |
|---|---|---|
| `TO_EMAIL` | yes | Where alerts go |
| `EMAILJS_SERVICE_ID` | yes | |
| `EMAILJS_TEMPLATE_ID` | yes | Template for "tickets are open" |
| `EMAILJS_FAILURE_TEMPLATE_ID` | no | Template for "checker is blocked". Defaults to `template_dx9v2zk` |
| `EMAILJS_PUBLIC_KEY` | yes | |
| `EMAILJS_PRIVATE_KEY` | yes | |
| `PROXY_URL` | no | Residential proxy, if you get blocked |

Then under **Variables**:

- `TARGET_URL_BASE` = `https://in.bookmyshow.com/movies/chennai/the-odyssey/buytickets/ET00480917`
  (no trailing date — the script appends dates itself)

### 4. Trigger it once by hand
Actions → "Check IMAX Availability" → **Run workflow**. The log should print the
booking window and a verdict per Saturday.

Do this before trusting it. All my testing ran from a home IP in India; GitHub's
runners have different IP reputation with Cloudflare, and that's the one variable
I couldn't test from my machine.

### 5. Leave it alone
It then fires hourly on its own and commits `state.json` back to the repo
to remember what it has already sent.

---

## Running locally

```bash
npm install
npm run browsers
cp .env.example .env     # fill it in
npm run check:local
```

---

## Pointing it elsewhere

For a different movie or city, change `TARGET_URL_BASE` to that film's
`buytickets` URL. Grab it by opening the movie on BookMyShow and copying the URL
without any trailing date.

Two caveats:

- **The event code is format-specific.** `ET00480917` is the IMAX 2D event;
  the regular 2D release of the same film is a different code (`ET00452034`).
  If you want a specific format, make sure you've grabbed that format's URL —
  otherwise you'll be watching the wrong thing.
- **The region is baked into the URL** (`/chennai/`). The page state also carries a
  region code, so use the URL for the city you actually want.

Everything else — date logic, blocking, alerts — is city and movie agnostic.

---

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `SATURDAYS_TO_CHECK` | `2` | Set `1` for this week's Saturday only. BookMyShow publishes ~7 days, so further-out Saturdays just read "not in booking window yet" until they come into range |
| `MAX_ATTEMPTS` | `3` | Retries when blocked. Each gets a fresh browser, a fresh context and a **different** hardware profile |
| `FINGERPRINT_SEED` | run id + attempt | Replay a specific machine. Copy the seed from a run's `posing as:` log line to reproduce it exactly |
| `BLOCK_ALERT_THRESHOLD` | `3` | Consecutive failed runs before it emails to say it's blind |
| `PROXY_URL` | — | Proxy, e.g. `http://user:pass@host:port` |

On cadence: hourly, one request per run. Going faster mainly raises the odds of
getting the IP blocked, which costs the alert entirely — and a blocked checker is
worth far less than one that's an hour behind. If you do speed it up, note that
`BLOCK_ALERT_THRESHOLD` counts *runs*, not time, so the failure alert gets
proportionally quicker too.

---

## When a run goes red

- **Exit 2** means the page couldn't be read — blocked, or the page structure
  changed. Download the run's **debug-artifacts**: it has a screenshot and the raw
  HTML of exactly what came back. That artifact is how I diagnosed everything above.
- **After 3 consecutive failed runs it emails me** (via the separate failure
  template) to say it has gone blind, with a direct link to the failing workflow
  run. A permanently broken checker must never quietly masquerade as "no tickets
  yet" — that's the failure mode that would actually cost me the tickets.

  "Failed" here means *any* run that couldn't determine availability, not just an
  HTTP block. A page that returns 200 and then doesn't parse counts too — that's a
  real case, and it's how a site redesign would show up.

  It alerts **once** per outage, not every hour, and re-arms automatically
  once a run succeeds. If the failure email itself can't be sent, it isn't marked
  as delivered, so a transient EmailJS outage won't swallow the warning.
- If BookMyShow changes their page structure, `extract.js` is the only file that
  should need touching. It matches on widget *shape* rather than exact paths, so
  layout shuffles shouldn't break it — but renaming `__INITIAL_STATE__` or the
  `date-*` styleIds would.

---

## Files

| File | Role |
|---|---|
| `check.js` | Orchestration — dates, fetching, notification, state |
| `extract.js` | Parses `__INITIAL_STATE__` into per-date availability |
| `fingerprint.js` | Generates one coherent synthetic machine per run — GPU, CPU, RAM, display |
| `stealth.js` | Applies that machine to the browser, plus human-ish activity |
| `state.json` | What's already been alerted, plus the block counter (CI commits this) |
| `.github/workflows/check-imax.yml` | The schedule |

Node 20+, Playwright, no other dependencies.

---

## A note on being polite

This makes one request an hour to a page anyone can load in a browser,
to answer a question their UI doesn't answer directly: *when does this date open?*
It doesn't buy tickets, doesn't touch checkout, and doesn't hammer anything. If
you reuse it, please keep it that way.
