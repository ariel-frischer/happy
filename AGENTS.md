# Agent Workflow

## Releasing anything

Every release goes through the `release` skill: `.agents/skills/release/SKILL.md`.
Read it in full before running `eas update`, `eas build`, `eas submit`, any
`pnpm ota*` or `pnpm release:*` script, or dispatching a release workflow.
That covers preview and production OTA updates, native builds, store
submissions, and CLI publishes.

The rule the skill opens with is the one that is never skipped: **release from
a local `main` that is exactly `origin/main`, checked against a fetch made right
then, with a clean tree.** Not from a worktree. Not from a branch. Not from a
`main` that is ahead or behind. The mobile release scripts refuse anything else
(`packages/happy-app/sources/scripts/releasePreflight.mjs`).

The only exception is one the user asks for by name in the current
conversation. A standing instruction from an earlier session is not that, and
neither is your own judgement that it is probably fine. When they do ask, the
skill says how: show what `main` commits the release will lack, get a yes, run
with `HAPPY_RELEASE_ALLOW_OFF_MAIN=1`, and say it was off-main in the report.

Why: an OTA channel serves whatever was published last, not whatever is on
`main`. On 2026-09-20 a preview OTA from a stale worktree silently rolled four
shipped fixes off every preview phone for hours. Git looked fine the whole time.

## Phone test APKs

GitLab CI builds are paused (since 2026-10-01, Ariel's call): build APKs for
Ariel's phone with `pnpm apk:phone --modal`, which builds the committed `HEAD`
on Modal so the laptop never runs Gradle. Local Gradle builds pushed the laptop
into systemd-oomd kills of agent terminals on 2026-10-01. `--local` is the
fallback when Modal is unavailable: it builds in its own memory-capped systemd
service and waits for the load average to drop. Never hand-run Gradle. Both
publish the APK to the tailnet feed Ariel's phone updates from (Obtainium) and
send an ntfy message. A build takes longer than a 300-second tool call, so
run it as a named `bash` service or with `setsid nohup … > build.log`. Never
use an emulator. See
`docs/phone-apk-ci.md`. A test APK is not a release; the release skill still
governs EAS builds and OTA updates.

## Sync To Main

When the user says `sync to main` or `synt to main`, they mean:

1. Fetch `origin/main`.
2. Rebase the current branch on `origin/main`.
3. Push the current HEAD directly to `main` with a normal push, for example:
   `git push origin HEAD:main`

Do not force push for this workflow.
