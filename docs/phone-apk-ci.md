# Phone APKs

Test APKs for the phone build on Modal (`--modal`), on this machine in a
memory-capped cgroup (`--local`), or on GitLab's hosted runners. GitLab CI is
paused for now. `--modal` keeps the 8-10 GB Gradle build off the laptop
entirely.

## Use

```sh
pnpm apk:phone --modal             # build HEAD on Modal, publish to the feed, notify via ntfy
pnpm apk:phone --local             # same, built here in a memory-capped cgroup
pnpm apk:phone                     # same, built on GitLab CI from the current branch
pnpm apk:phone --modal --no-send   # build only, into .worktrees/apk/
```

APKs are named `happy-preview-<build>-<sha>.apk`. `<build>` is the commit
count of `HEAD` (`git rev-list --count HEAD`), so a newer commit on `main`
always has a higher number. The app shows it in Settings next to the version
(`1.8.0 build 1234 / runtime 21`); the ntfy title carries it too.

## Installing on the phone (Obtainium)

Without `--no-send`, the script copies the APK into `~/.local/share/happy-apk`
(override with `HAPPY_APK_FEED_DIR`), keeps the newest five, rewrites its
`index.html` to link only the newest one, and serves the directory on the
tailnet with `tailscale serve --set-path /happy-apk` (HTTPS, tailnet only,
added once and persisted by tailscaled). It then sends an ntfy message whose
tap opens the APK link directly.

[Obtainium](https://github.com/ImranR98/Obtainium) on the phone watches that
page, so a new build is one tap ("Update") instead of download, open,
install-without-scanning and fingerprint. One-time setup in Obtainium:

1. Add app, URL `https://ari.taile4560a.ts.net/happy-apk/` (source: HTML).
2. Optional, to show the build number as the version: Version Extraction
   `happy-preview-(\d+)-`, Match Group `1`, and turn Version Detection off
   (the app's own version name stays `1.8.0`).
3. Add. If the preview app is already installed, Obtainium adopts it on the
   first update; the APKs share one signing key, so updates install in place.

Obtainium checks on its own schedule (Settings > update interval) and can
install updates in the background on Android 12+ for apps it installed. The
feed is only reachable while this laptop is on and the phone is on the
tailnet.

## Modal build

`--modal` sends a `git archive` of `HEAD` (committed code only) to
`scripts/phone-apk-modal.py`, run with `uvx --from modal==1.6.0 modal run`
under the `~/.modal.toml` profile. The Modal app `happy-apk` builds the same
preview variant as `--local` (`pnpm install`, `expo prebuild`,
`gradlew assembleRelease`, OTA disabled, arm64 only) in a container with
16 CPUs and 24 GB, then writes the APK to
`.worktrees/apk/happy-preview-<build>-<sha>.apk`; publishing and ntfy run
locally as for the other paths. The APK is signed with the same Expo template debug
keystore as local and CI builds, so it installs over them.

The first build on 8 CPUs took about 37 minutes (install 2.5, Gradle 30,
mostly native C++); a from-scratch build on 16 CPUs runs close to an hour. The
`happy-apk-cache` Volume keeps ccache (native C++) and Gradle's build cache
(Kotlin/Java/dex) between runs, so later builds only recompile what changed;
the build log ends with `ccache --show-stats`. The Modal function's timeout is
2 hours. Run it as a named background service or with `setsid nohup`.

The image (Debian, OpenJDK 17, Node 24, pnpm 10.11.0, Android SDK 36 with
NDK 27.1.12297006) is built once and reused. The `happy-apk-cache` Volume
keeps the Gradle cache between builds; the pnpm store is not cached because
reading it from the Volume was slower than downloading. Nothing else is
stored in Modal: the `HAPPY_*` push config and the google-services file from
`$HAPPY_PUSH_DIR/push.env` travel with each build.

Needs `uv` and a Modal token (`uvx --from modal modal token new`).

Killing the local process can leave the Modal container running and
billing. Check with `uvx --from modal modal app list` and stop it with
`uvx --from modal modal app stop -y <app id>`.

## Local build

`--local` waits until the 1-minute load average is below half the cores, then
builds a detached worktree of `HEAD` at `.worktrees/apk-build` (committed code
only; uncommitted edits are not in the APK). It runs `pnpm install`,
`expo prebuild` and `gradlew assembleRelease` (preview variant, OTA disabled,
arm64 only), and copies the APK to `.worktrees/apk/happy-preview-<build>-<sha>.apk`.

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

Needs JDK 17 through mise (`mise where java@temurin-17`) and the Android SDK at
`ANDROID_HOME` (default `~/Android/Sdk`).

## GitLab CI

From a branch whose commit you want on the phone, `pnpm apk:phone`:

1. pushes `HEAD` to the same branch on the `gitlab` remote (a normal push; a
   diverged GitLab branch stops the run),
2. creates a pipeline with `BUILD_APK=1` and `HAPPY_BUILD_NUMBER` (the CI
   clone is shallow, so the job cannot count commits itself) and waits for
   the `android-apk` job,
3. downloads the APK into `.worktrees/apk/happy-preview-<build>-<sha>.apk`,
4. publishes it to the feed and sends the ntfy message (config
   `~/.omp/agent/ntfy-push.json`, override with `NTFY_CONFIG`).

It needs the `gitlab` remote (`git@gitlab.com:ariel-frischer/happy.git`) and a
GitLab token (`GITLAB_TOKEN` or `glab auth login`).

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
