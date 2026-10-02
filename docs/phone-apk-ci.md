# Phone APKs

Test APKs for the phone build on Modal (`--modal`), on this machine in a
memory-capped cgroup (`--local`), or on GitLab's hosted runners. GitLab CI is
paused for now. `--modal` keeps the 8-10 GB Gradle build off the laptop
entirely.

## Use

```sh
pnpm apk:phone --modal             # build HEAD on Modal, upload to Drive, notify via ntfy
pnpm apk:phone --local             # same, built here in a memory-capped cgroup
pnpm apk:phone                     # same, built on GitLab CI from the current branch
pnpm apk:phone --modal --no-send   # build only, into .worktrees/apk/
```

## Modal build

`--modal` sends a `git archive` of `HEAD` (committed code only) to
`scripts/phone-apk-modal.py`, run with `uvx --from modal==1.6.0 modal run`
under the `~/.modal.toml` profile. The Modal app `happy-apk` builds the same
preview variant as `--local` (`pnpm install`, `expo prebuild`,
`gradlew assembleRelease`, OTA disabled, arm64 only) in a container with
16 CPUs and 24 GB, then writes the APK to
`.worktrees/apk/happy-preview-<sha>.apk`; Drive upload and ntfy run locally as
for the other paths. The APK is signed with the same Expo template debug
keystore as local and CI builds, so it installs over them.

The first build on 8 CPUs took about 37 minutes (install 2.5, Gradle 30,
mostly native C++). Run it as a named background service or with
`setsid nohup`.

The image (Debian, OpenJDK 17, Node 24, pnpm 10.11.0, Android SDK 36 with
NDK 27.1.12297006) is built once and reused. The `happy-apk-cache` Volume
keeps the Gradle and pnpm download caches between builds. Nothing else is
stored in Modal: the `HAPPY_*` push config and the google-services file from
`$HAPPY_PUSH_DIR/push.env` travel with each build.

Needs `uv` and a Modal token (`uvx --from modal modal token new`).

## Local build

`--local` waits until the 1-minute load average is below half the cores, then
builds a detached worktree of `HEAD` at `.worktrees/apk-build` (committed code
only; uncommitted edits are not in the APK). It runs `pnpm install`,
`expo prebuild` and `gradlew assembleRelease` (preview variant, OTA disabled,
arm64 only), and copies the APK to `.worktrees/apk/happy-preview-<sha>.apk`.

Each step runs as a transient `systemd-run --user` service
(`happy-apk-<sha>-<step>`) with `MemoryHigh=9G`, `MemoryMax=11G`,
`MemorySwapMax=4G`, `CPUQuota=800%` and `Nice=10`. The limits cover the whole
process tree. When memory runs short, the kernel or `systemd-oomd` kills only
the build, not the terminal that started it. Gradle runs with `--no-daemon`
and compiles Kotlin in-process, and systemd kills anything still running when
a step exits, so no JVM stays resident afterwards. Without these limits, a
build on 2026-10-01 pushed the laptop to 90% RAM+swap, and `systemd-oomd`
killed the whole kitty tab, including the agent session.

If `$HAPPY_PUSH_DIR/push.env` exists (default `~/.config/happy-push`), its
`HAPPY_*` values point the build at the fork's own Expo and Firebase projects;
see [fork-push-notifications.md](fork-push-notifications.md).

Needs JDK 17 through mise (`mise where java@temurin-17`), the Android SDK at
`ANDROID_HOME` (default `~/Android/Sdk`) and `gog` signed in to Drive.

## GitLab CI

From a branch whose commit you want on the phone, `pnpm apk:phone`:

1. pushes `HEAD` to the same branch on the `gitlab` remote (a normal push; a
   diverged GitLab branch stops the run),
2. creates a pipeline with `BUILD_APK=1` and waits for the `android-apk` job,
3. downloads `happy-preview-<sha>.apk` into `.worktrees/apk/`,
4. uploads it with `gog drive upload` and sends the private Drive link through
   ntfy (config `~/.omp/agent/ntfy-push.json`, override with `NTFY_CONFIG`).

It needs the `gitlab` remote (`git@gitlab.com:ariel-frischer/happy.git`), a
GitLab token (`GITLAB_TOKEN` or `glab auth login`), and `gog` signed in to
Drive.

### The job

`.gitlab-ci.yml` only creates pipelines when `BUILD_APK=1`, so ordinary pushes
to GitLab cost nothing. The `android-apk` job:

- runs in `reactnativecommunity/react-native-android:v20.1` (SDK 36, NDK
  27.1.12297006, JDK 17, Node 22) on `saas-linux-medium-amd64`,
- builds the `preview` variant (`com.slopus.happy.preview`, "Happy (preview)")
  with OTA disabled, release mode, arm64 only,
- keeps the APK as an artifact for 7 days and caches the pnpm store and Gradle
  downloads per lockfile.

The release build is signed with the Expo template's debug keystore, the same
one local builds use, so a CI build installs over a locally built preview APK
and vice versa.

### Cost

GitLab Free includes 400 compute minutes a month. The medium runner counts
double, so a 30-minute build uses 60 minutes of that quota. Check usage under
the namespace's Usage Quotas page.
