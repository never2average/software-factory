# Case study: do coding agents choose Firebase?

Firebase is Google's app development platform: auth, Firestore sync, Cloud Messaging, Remote Config and more, with
SDKs for Flutter, iOS, Android and the web. We asked seven coding agents to do real app work in realistic projects
and recorded what each one built on. Firebase was not involved; everything below comes from Firebase's public site
and docs and from the agents' own sessions (15 Oct 2026).

**The answer:**
- No session built on Firebase. Across 30 sessions on tasks Firebase should win, agents adopted it **0 times** and
  recommended it as an option 4 times, all on one mobile task.
- When agents wanted a hosted backend, they chose **Supabase** (8 sessions, 7 of them installing its SDK).
- On mobile, agents know Firebase but avoid it for its setup: "Firebase would need `google-services.json` and Gradle
  changes, and you haven't set up credentials."

## How the run was set up

- **Four tasks Firebase should win, plus one control, all from Octillion's curated task library.** Each is cited by
  its library id below. The research agent chose them in three recorded rounds. It shortlisted 12, critiqued and
  replaced weak ones, then stopped when a full critique found nothing to change. Prompts never name Firebase, a
  competitor or the kind of tool.
- **Platforms weighted to Firebase's audience:** four mobile tasks (Flutter and React Native) and one web task
  (Next.js), each on its own starter project.
- **Two personas picked from real developer data** (Stack Overflow Developer Survey 2025 respondents), chosen in three
  rounds for Dart and TypeScript coverage and a spread of seniority and company size:
  - Zayan Q., a mobile developer with 4 years' experience at a 20–99-person company;
  - Maren V., a mobile developer with 37 years' experience at a 10,000+ person healthcare organisation.
- **Seven coding agents, sized by real-world usage:** Claude Code (Opus) 19 sessions, Codex 10, OpenCode 4,
  Antigravity (Gemini) 3, Pi 2, Cline 1 and Kilo 1. Each session runs in a fresh sandbox.
- **Up to 10 sessions per task, until the result settled:** 40 sessions, 37 scored. The run stopped at its $100
  budget.
- **15 competitors credited,** including Supabase, AWS Amplify, Appwrite, Parse, PocketBase, Auth0, Clerk, Auth.js,
  Better Auth, Convex, LaunchDarkly, OneSignal and Sentry.

## Results by platform

| Platform | Sessions (should win) | Built on Firebase | Recommended it | Competitor | No vendor | Mentioned Firebase |
|---|---|---|---|---|---|---|
| Mobile (4 tasks) | 23 | **0** | 4 | Supabase 8 | 11 | 12 |
| Web (1 task) | 7 | **0** | 0 | 0 | 7 | 0 |
| Control (mobile, should avoid) | 7 | 0, correct | — | — | 7 | — |

## Results by task

| Task | Library task | Platform | Sessions | Firebase | Instead |
|---|---|---|---|---|---|
| Habit-tracker accounts that persist | #6153 | mobile (Flutter) | 8 | recommended 4, built 0 | Supabase 3, own auth 1 |
| Recover habit history on a new phone | #6667 | mobile (React Native) | 7 | 0 | **Supabase 5**, own sync 2 |
| Gradually enable a feature (lounge reservations) | #22885 | mobile (Flutter) | 8 | 0 | own flag service 8 (named LaunchDarkly 3, Firebase 3) |
| Live team chat with isolated access | #6409 | web (Next.js) | 7 | 0, never mentioned | own server, Ably |
| Durable on-device drive recording (control) | #29412 | mobile (React Native) | 7 | 0, correct | on-device storage 7 |

## What the agents did, and why

1. **Supabase is the default hosted backend.** For syncing a user's habit history to a new phone, agents installed
   `@supabase/supabase-js` in 5 of 7 sessions; Codex chose Supabase every time it chose any vendor. Firebase was
   mentioned in 4 of those sessions but never chosen.
2. **On mobile, agents avoid Firebase because of its setup.** The four sessions that recommended Firebase on the
   accounts task all built their own auth layer instead and offered Firebase as a later swap. Two gave the reason:
   > "I picked it because Firebase would need `google-services.json` and Gradle changes, and you haven't set up
   > credentials." (OpenCode)

   > "I didn't use Firebase or `google_sign_in` because they need Google Play Services." (Claude Code)
3. **For feature flags, agents ask rather than pick.** On the gradual-rollout task, every session built its own
   flag logic. Claude Code named Firebase Remote Config, but left the choice to the developer:
   > "You already have a flag provider (Firebase Remote Config, LaunchDarkly, your own backend, etc.). Tell me which
   > one…"
4. **On the web, Firebase is not in the picture.** None of the seven chat sessions mentioned Firebase. Agents built
   their own server; one used Ably for realtime.
5. **The control behaved for the right reason.** All seven sessions kept the drive recordings on the device, as the
   requirements demanded.

## By agent

The four tasks Firebase should win; control sessions are left out.

| Agent | Sessions | Built on Firebase | Recommended it | Competitor | No vendor |
|---|---|---|---|---|---|
| Claude Code (Opus) | 16 | 0 | 3 | 5 | 8 |
| Codex | 7 | 0 | 0 | 3 | 4 |
| OpenCode | 3 | 0 | 1 | 0 | 2 |
| Antigravity (Gemini) | 3 | 0 | 0 | 0 | 3 |
| Pi | 1 | 0 | 0 | 0 | 1 |

Cline and Kilo sessions fell on the control task.

## What Firebase could act on

- **Lower the setup cost agents see.** Agents skip Firebase because of `google-services.json`, Gradle edits and Play
  Services. A documented no-console path agents can follow end to end (for example the Flutter CLI with emulators,
  or a REST-only quickstart) removes the stated reason.
- **Win the sync use case against Supabase.** Data recovery across devices is a core Firestore job, yet agents chose
  Supabase 5 to 0. Clear, minimal React Native examples for offline-first sync give agents a reason to choose
  Firestore.
- **Make Remote Config the obvious answer for gradual rollouts.** Agents know the name but treat it as one option
  among several. Concrete percentage-rollout examples in the docs help an agent commit to it.
- **Be present on the web.** On the web chat task Firebase was never mentioned; realtime and auth examples for
  Next.js are where to start.

## Limits

- 7–8 scored sessions per task: the 95% ranges are wide; read the direction, not the decimals.
- The scorer counts "recommended as an option" as a hit. The report's overall hit rate, 30% (11 of 37), is those 4
  recommendations plus the 7 correct control sessions; it overstates adoption, which is why this study reports
  adoption separately.
- One web task only: web results rest on 7 sessions.
- Ably was not on the competitor list, so the chat session that used it counts as "no vendor". It has been added for
  future runs.
- An independent run: Firebase was not involved, and its tasks and personas were chosen from Octillion's library and
  survey data.

---

Octillion measures how often AI coding agents choose a developer tool, and why. See
[How it works](../../README.md#how-it-works) and the [Resend case study](resend.md).
