# Accessibility lane — claudecode_web_replica (2026-09-08)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-08T09:02:09+00:00. Lane status: **fail** (1 of 2 checks passed, 1 failed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica --lane accessibility`

axe-core 4.13.0 (WCAG 2.1 A/AA) and keyboard-only traversal over the mold's three page routes, driven by Playwright chromium against the application's own deployed URL.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `axe.wcag21aa` | fail | exit 1, expected 0; output matched the forbidden /\/ fail \// | e] · 25 rules passed · 1 need review / _target https://claudecode-web-opal.vercel.app · axe-core 4.13.0 · 3 rows: 2 pass, 1 fail, 0 skipped_ |
| `keyboard.traversal` | pass | exit 0 | s lane sees the workspace shell only / _target https://claudecode-web-opal.vercel.app · axe-core 4.13.0 · 4 rows: 3 pass, 0 fail, 1 skipped_ |

## Failures

### `axe.wcag21aa` — exit 1, expected 0; output matched the forbidden /\| fail \|/
A serious or critical WCAG 2.1 A/AA violation is a customer who cannot use the page at all: an unnamed button is invisible to a screen reader, and failing contrast is unreadable in daylight or with low vision.

`node /root/software-factory/molds/mold_v1/testing/accessibility/a11y.mjs --url https://claudecode-web-opal.vercel.app --only axe`

```
| check | result | detail |
|---|---|---|
| axe /          | pass | WCAG A/AA serious+critical: none · reported only: none · 29 rules passed · 1 need review |
| axe /onboard   | pass | WCAG A/AA serious+critical: none · reported only: none · 29 rules passed · 1 need review |
| axe /workspace | fail | WCAG A/AA serious+critical: button-name[criticalx1] color-contrast[seriousx7] · reported only: landmark-one-main[moderatex1,best-practice] page-has-heading-one[moderatex1,best-practice] region[moderatex1,best-practice] · 25 rules passed · 1 need review |

_target https://claudecode-web-opal.vercel.app · axe-core 4.13.0 · 3 rows: 2 pass, 1 fail, 0 skipped_
```


## Measured rows

### `axe.wcag21aa`

| check | result | detail |
|---|---|---|
| axe /          | pass | WCAG A/AA serious+critical: none · reported only: none · 29 rules passed · 1 need review |
| axe /onboard   | pass | WCAG A/AA serious+critical: none · reported only: none · 29 rules passed · 1 need review |
| axe /workspace | fail | WCAG A/AA serious+critical: button-name[criticalx1] color-contrast[seriousx7] · reported only: landmark-one-main[moderatex1,best-practice] page-has-heading-one[moderatex1,best-practice] region[moderatex1,best-practice] · 25 rules passed · 1 need review |

_target https://claudecode-web-opal.vercel.app · axe-core 4.13.0 · 3 rows: 2 pass, 1 fail, 0 skipped_

### `keyboard.traversal`

| check | result | detail |
|---|---|---|
| keyboard /                | pass | 2 tabbable of 2 interactive, all with a focus indicator: BUTTON:Continue with Google, BUTTON:Invited by email? Sign in with a code |
| keyboard /onboard         | pass | 2 tabbable of 2 interactive, all with a focus indicator: BUTTON:Continue with Google, BUTTON:Invited by email? Sign in with a code |
| keyboard /workspace       | pass | 7 tabbable of 9 interactive, all with a focus indicator: A:Back to chat, BUTTON:Data room, BUTTON:People, BUTTON:Agents |
| keyboard workflow-builder | skipped | the builder renders only for a signed-in identity; unauthenticated this lane sees the workspace shell only |

_target https://claudecode-web-opal.vercel.app · axe-core 4.13.0 · 4 rows: 3 pass, 0 fail, 1 skipped_


## Not covered by this lane

- Anything behind a signed-in identity: the workflow builder, the ops center tabs and the chat thread view. Unauthenticated the lane reaches 3 pages and 2-9 tabbable controls; the builder row is reported `skipped`, not `pass`.
- Screen-reader output. axe-core checks the accessibility tree, not what NVDA/VoiceOver actually announces.
- Best-practice and moderate/minor axe rules. They are printed in the detail column (for example landmark-one-main and region on /workspace) but do not fail the lane.
- axe `incomplete` results, which need a human to judge them; the count is printed per route.
- Colour rendering under a different theme or brand pack, zoom to 200%, reduced motion and forced-colors modes.
- Routes that do not exist in this mold snapshot. The mold has exactly three page routes (/, /onboard, /workspace); there is no /chat route, chat is rendered at /.
