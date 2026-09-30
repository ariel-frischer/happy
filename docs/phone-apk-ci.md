# Phone APKs on GitLab CI

Test APKs for the phone build on GitLab's hosted runners, not the laptop. A
local release build takes about 16 minutes of full CPU; the CI job moves that
off the machine.

## Use

From a branch whose commit you want on the phone:

```sh
pnpm apk:phone             # build, download, upload to Drive, notify via ntfy
pnpm apk:phone --no-send   # build and download to .worktrees/apk/ only
```

`scripts/phone-apk.mjs`:

1. pushes `HEAD` to the same branch on the `gitlab` remote (a normal push; a
   diverged GitLab branch stops the run),
2. creates a pipeline with `BUILD_APK=1` and waits for the `android-apk` job,
3. downloads `happy-preview-<sha>.apk` into `.worktrees/apk/`,
4. uploads it with `gog drive upload` and sends the private Drive link through
   ntfy (config `~/.omp/agent/ntfy-push.json`, override with `NTFY_CONFIG`).

It needs the `gitlab` remote (`git@gitlab.com:ariel-frischer/happy.git`), a
GitLab token (`GITLAB_TOKEN` or `glab auth login`), and `gog` signed in to
Drive.

## The job

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

## Cost

GitLab Free includes 400 compute minutes a month. The medium runner counts
double, so a 30-minute build uses 60 minutes of that quota. Check usage under
the namespace's Usage Quotas page.
