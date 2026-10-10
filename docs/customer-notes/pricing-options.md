# Decision brief: pricing and packaging for OnFinance AI

For the operator. This decides the `released` gate "pricing/packaging decided" (task mold_v1-211), which only you can
close. Below are three ways to charge, what each costs us to serve, and one recommendation. The **costs are
measured or derived** (`docs/COST_MODEL.md` §2c and §7, read 2026-10-10); the **prices are proposals** for you to
change. All amounts are US dollars per month.

## What it costs us to serve (from `docs/COST_MODEL.md` §2c)

| Item | On Vercel (`onfinance_hfc`) | On the customer's own server (`onfinance_hfc_vm`) | Kind |
|---|---|---|---|
| one chat turn (main agent) | $0.080 | $0.012 | measured |
| one research-assistant run: small / typical / heavy | $0.036 / $0.50 / $6.43 | the same (same model) | measured |
| one person at light / typical / heavy use | $5.90 / $32 / $766 | $1.41 / $22 / $736 | estimated (scenario volumes x measured unit costs) |
| starter apps that refresh on a schedule (per workspace) | about $134 (about $61 if big runs cache as well as small ones) | the same | estimated |
| the server | none | $48 (DigitalOcean `s-4vcpu-8gb`, fetched 2026-10-10) | fetched |
| Vercel plan, database, file storage, email, web search | not priced yet (`docs/COST_MODEL.md` §6) | email and web search not priced yet | not priced |
| your own time (onboarding, support) | not priced | not priced | not priced |

**A typical workspace** below means five people at typical use (7 chat turns a working day each) with the starter
apps on: about **$294** a month in inference on Vercel, about **$290** on the customer's own server including the
server. The big risk is not the number of people but the research runs: one person who runs full-document research
all day costs about $750 a month on their own, and the app does not stop it (mold_v1 enforces no budget; you see it
coming with `python3 .claude/scripts/app_usage.py --all`).

## Option A: per workspace, per month (recommended)

- **Price (proposed): $750 per workspace per month**, up to 10 people.
- **Included:** the assistant and its four research specialists, the starter apps, the data room, web search,
  sign-in by email code and Google, updates, and **$400 of inference a month** (about 8 people at typical use with the starter apps, or 12
  without them).
- **Above the allowance:** billed at cost plus 25%, shown from `app_usage.py` each month.
- **Cost to serve, typical workspace:** $294 -> **margin about 61%** ($456).
- **At 10 typical people:** cost $455, of which $55 is above the allowance and billed at cost plus 25% ($69) ->
  margin about 39% before that charge, about 44% with it.

## Option B: per person, per month

- **Price (proposed): $99 per person per month**, at least 3 people; starter apps **$150 per workspace** extra.
- **Included:** the same as A, with a fair-use limit of $60 of inference per person a month, above it at cost plus 25%.
- **Cost to serve, typical person:** $32 -> margin about 68% per person; typical workspace (5 people + starter
  apps) $645 charged against $294 -> **margin about 54%**.
- **Weak spot:** one heavy researcher costs about $766, eight times their seat price; without the fair-use limit,
  one such person turns the workspace into a loss.

## Option C: own-server tier

- **Price (proposed): $1,000 per workspace per month**, up to 10 people, the server included, on a server in the
  customer's own cloud account or one we run for them; the same $400 inference allowance and overage as A.
- **Included:** everything in A, plus the data and the files never leave that server, and updates switch over in
  seconds with an automatic switch back (`docs/customer-notes/updates.md`).
- **Cost to serve, typical workspace:** $290 including the $48 server -> **margin about 71%** ($710). If the customer
  pays the server directly, take $48 off both sides.
- **Not included yet:** backups of that server (`docs/RUNBOOK.md` §9: not built). Say so before selling it, or price
  the backups in once they exist.

## Recommendation

**Option A, per workspace**, with C offered as the premium tier to customers who need their data on their own
server. Why: what we pay grows with how much research a workspace runs, not with how many people sign in, so a
per-person price (B) is the one most likely to lose money on one heavy user. A workspace is also the unit the
product already isolates, bills inference to (`app_usage.py` reports per workspace) and onboards with one command.
Whatever you choose, keep the inference allowance and the overage line: without them the heavy case is open-ended.

## What you need to decide

1. Which option (A, B or C, or A with C as the premium tier).
2. The price, if not the proposed one.
3. The inference allowance and what happens above it (billed at cost plus a margin, or a conversation first).

Once you answer, the agent records the decision in `docs/PRODUCTS.md` and closes mold_v1-211.
