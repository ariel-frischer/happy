# Push notifications on a fork

Native push reaches a phone through three projects you own. **Firebase** issues
the Android device token (FCM). **Expo** holds the FCM sender key and turns
Expo push tokens into FCM deliveries. Your **Happy server** sends to Expo's push
API (`packages/happy-server/sources/app/push/pushSend.ts`). A fork that builds
the app without its own Firebase and Expo projects registers devices under
upstream's, and pushes to those devices do not arrive.

Nothing here is committed. The app config reads your projects from `HAPPY_*`
variables, and the credentials stay in a private directory outside the repo:

| Variable | Read by | Default (upstream) |
|---|---|---|
| `HAPPY_EXPO_PROJECT_ID` | `app.config.js`: `extra.eas.projectId` (push token + OTA URL) | `4558dd3d-…` |
| `HAPPY_EXPO_OWNER` | `app.config.js`: `owner` | `bulkacorp` |
| `HAPPY_EXPO_SLUG` | `app.config.js`: `slug` | `happy` |
| `HAPPY_GOOGLE_SERVICES_FILE` | `app.config.js`: `android.googleServicesFile` | `./google-services.json` |

With none of them set, builds behave exactly as before.

## Setup

`pnpm push:setup` (`scripts/push-credentials.mjs`) does each step with the
providers' CLIs and APIs. Every step accepts `--dry-run`, which prints the
commands and API calls without making them. Files go to `HAPPY_PUSH_DIR`
(default `~/.config/happy-push`, mode 700). The script refuses a directory
inside the repository.

1. **Firebase** (needs `gcloud auth login`):

   ```sh
   pnpm push:setup firebase --project <gcp-project-id> [--create] [--package com.slopus.happy.preview]
   ```

   Creates the GCP project with `--create`, enables the FCM APIs, adds
   Firebase, registers the Android app, and writes `google-services.json`. It
   also creates the `happy-fcm` service account with the FCM admin role and
   downloads its key, which Expo needs in the next step.

2. **Expo** (needs `EXPO_TOKEN`, from expo.dev > Account settings > Access
   tokens):

   ```sh
   EXPO_TOKEN=... pnpm push:setup expo --account <expo-account> [--slug happy] [--package com.slopus.happy.preview]
   ```

   Finds or creates the Expo project `@<account>/<slug>` and uploads the
   service account key as the app's FCM V1 credential. These are the same
   GraphQL calls `eas credentials` makes. Afterwards it deletes the local key
   (`--keep-key` keeps it).

3. **Build** with your projects:

   ```sh
   eval "$(pnpm -s push:setup env)"
   ```

   `pnpm apk:phone --local` loads `~/.config/happy-push/push.env` by itself.
   For GitLab CI builds, `pnpm push:setup gitlab [--repo owner/repo]` stores
   the same values as CI variables, with `google-services.json` as a file
   variable.

4. **Re-register** on the phone: install the new build and allow
   notifications. The app registers its Expo push token with your server on
   launch.

The `--package` value must match the variant you build. The variants are
`com.slopus.happy.preview` (preview), `com.slopus.happy.dev` (development), and
`com.ex3ndr.happy` (production). Run the Firebase and Expo steps once per
package.

## Cost and data

FCM and Expo's push service are free. Firebase's Spark plan covers FCM, and
the setup creates no billable resources. Notification titles and bodies pass
through Expo and Google on their way to the phone.

If you turn on Expo's enhanced push security for the project, the server also
needs an Expo access token. The current sender does not send one.
