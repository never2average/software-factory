# Customer note: how updates to OnFinance AI work (self-hosted copy)

A draft for the operator to send to customers whose OnFinance AI runs on its own server (`target: vm_remote`).
Filled in by the operator on 2026-10-12; send it as it is. The facts behind it are in `docs/COST_MODEL.md` §7
("what a redeploy costs in downtime") and `docs/RUNBOOK.md` §9 F; if either changes, change this note too.

Status: **sent** by the operator on 2026-10-12 (closed gate task mold_v1-213).

---

**Subject: How updates to OnFinance AI work**

Hello,

A short note on how we update your OnFinance AI workspace, and what you might notice when we do.

**When updates happen.** We update OnFinance AI about once a week, at a quiet time:
weekdays between 7 and 8 am India time. If an update ever needs more than a few
seconds of your time, we will tell you beforehand.

**What you may notice.** Almost nothing. At the moment of the switch:

- the page may take a second or two to load, once;
- the assistant may pause for up to about 15 seconds. If an answer stops part-way, send the question again.

You do not need to sign in again, and nothing you have saved is affected.

**How you are protected.**

- The new version is prepared next to the one you are using, while you keep working. We only switch when it is
  completely ready.
- If the new version does not start properly, your server goes back to the previous version by itself.
  We can also go back to it by hand at any time.
- Your conversations, documents and data room stay where they are. An update changes the software, not your data.
- Each update re-checks that your workspace's data cannot be seen from any other workspace before the new version
  is allowed to serve you.

If something does not look right after an update, reply to this email and we will look at it straight away.

Best regards,
Priyesh
