#!/usr/bin/env node
// Points a fork's builds at its own Firebase + Expo projects so native push
// notifications work, without committing either. Everything it creates lives in
// a private directory outside the repo (HAPPY_PUSH_DIR, default
// ~/.config/happy-push); app.config.js reads it through HAPPY_* variables.
// Guide: docs/fork-push-notifications.md.
//
//   pnpm push:setup firebase --project <gcp-id> [--create] [--package <id>]
//   pnpm push:setup expo --account <expo-account> [--slug <slug>] [--package <id>] [--keep-key]
//   pnpm push:setup gitlab [--repo <owner/repo>]
//   pnpm push:setup env                       # print the shell exports
//
// Add --dry-run to any step to print what it would do without calling anything.
//
// firebase: gcloud (logged in). expo: EXPO_TOKEN (personal or robot access
// token). gitlab: glab (logged in).

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(process.env.HAPPY_PUSH_DIR || join(homedir(), '.config', 'happy-push'));
const ENV_FILE = join(DIR, 'push.env');
const GOOGLE_SERVICES = join(DIR, 'google-services.json');
const SA_KEY = join(DIR, 'fcm-service-account.json');
const SA_NAME = 'happy-fcm';
const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
const EXPO_GRAPHQL = 'https://api.expo.dev/graphql';
const DEFAULT_PACKAGE = 'com.slopus.happy.preview';

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const dryRun = flags['dry-run'] === true;

function parseFlags(args) {
    const out = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
        const name = arg.slice(2);
        const next = args[i + 1];
        if (next === undefined || next.startsWith('--')) out[name] = true;
        else out[name] = args[++i];
    }
    return out;
}

function fail(message) {
    console.error(`push-credentials: ${message}`);
    process.exit(1);
}

function flag(name, fallback) {
    const value = flags[name] ?? fallback;
    if (value === undefined || value === true) fail(`--${name} <value> is required`);
    return value;
}

function step(message) {
    console.log(`${dryRun ? '[dry-run] ' : ''}${message}`);
}

function sh(cmd, args, { input } = {}) {
    if (dryRun) {
        step(`$ ${cmd} ${args.join(' ')}${input === undefined ? '' : ' < (file)'}`);
        return '';
    }
    return execFileSync(cmd, args, {
        encoding: 'utf8',
        input,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
    }).trim();
}

// The private directory must never be tracked by this (or any) checkout.
function ensurePrivateDir() {
    const rel = relative(REPO_ROOT, DIR);
    if (!rel.startsWith('..') && !rel.startsWith('/')) {
        fail(`HAPPY_PUSH_DIR (${DIR}) is inside the repository; keep it outside so it is never committed`);
    }
    if (dryRun) return;
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    chmodSync(DIR, 0o700);
}

function readEnv() {
    if (!existsSync(ENV_FILE)) return {};
    const env = {};
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match) env[match[1]] = match[2];
    }
    return env;
}

function updateEnv(values) {
    const env = { ...readEnv(), ...values };
    step(`write ${ENV_FILE}: ${Object.keys(values).join(', ')}`);
    if (dryRun) return;
    const body = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
    writeFileSync(ENV_FILE, `# Private Happy push config (docs/fork-push-notifications.md). Never commit.\n${body}\n`, { mode: 0o600 });
}

function writePrivate(path, content) {
    step(`write ${path}`);
    if (dryRun) return;
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
}

// --- Firebase (gcloud + Firebase Management REST API) ---

// `optional`: a 403/404 returns null (a GCP project without Firebase answers either).
async function firebaseApi(project, method, path, body, { optional = false } = {}) {
    const url = path.startsWith('http') ? path : `${FIREBASE_API}/${path}`;
    if (dryRun) {
        step(`${method} ${url}${body ? ` ${JSON.stringify(body)}` : ''}`);
        return null;
    }
    const token = sh('gcloud', ['auth', 'print-access-token']);
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-goog-user-project': project,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (optional && (response.status === 403 || response.status === 404)) return null;
    const json = await response.json();
    if (!response.ok) fail(`${method} ${url} -> ${response.status}: ${json.error?.message ?? JSON.stringify(json)}`);
    return json;
}

async function waitForOperation(project, operation) {
    if (dryRun || !operation) return null;
    let current = operation;
    while (!current.done) {
        await new Promise((r) => setTimeout(r, 2000));
        current = await firebaseApi(project, 'GET', current.name);
    }
    if (current.error) fail(`operation ${current.name} failed: ${current.error.message}`);
    return current.response;
}

async function setupFirebase() {
    const project = flag('project');
    const packageName = flag('package', DEFAULT_PACKAGE);
    ensurePrivateDir();

    if (flags.create) {
        sh('gcloud', ['projects', 'create', project, '--name', 'Happy push']);
    }
    sh('gcloud', ['services', 'enable', '--project', project,
        'firebase.googleapis.com', 'fcm.googleapis.com',
        'fcmregistrations.googleapis.com', 'firebaseinstallations.googleapis.com']);

    if (!(await firebaseApi(project, 'GET', `projects/${project}`, undefined, { optional: true })) || dryRun) {
        step(`add Firebase to ${project}`);
        await waitForOperation(project, await firebaseApi(project, 'POST', `projects/${project}:addFirebase`, {}));
    }

    const apps = (await firebaseApi(project, 'GET', `projects/${project}/androidApps`))?.apps ?? [];
    let app = apps.find((a) => a.packageName === packageName);
    if (!app) {
        step(`create Android app ${packageName}`);
        app = await waitForOperation(project, await firebaseApi(project, 'POST', `projects/${project}/androidApps`, {
            packageName,
            displayName: 'Happy',
        }));
    }

    const config = await firebaseApi(project, 'GET', `projects/${project}/androidApps/${app?.appId ?? '<appId>'}/config`);
    writePrivate(GOOGLE_SERVICES, dryRun ? '' : Buffer.from(config.configFileContents, 'base64').toString('utf8'));

    // FCM V1 sender key that Expo uses to deliver to this app.
    const email = `${SA_NAME}@${project}.iam.gserviceaccount.com`;
    const exists = dryRun || (() => {
        try {
            execFileSync('gcloud', ['iam', 'service-accounts', 'describe', email, '--project', project], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    })();
    if (!exists || dryRun) {
        sh('gcloud', ['iam', 'service-accounts', 'create', SA_NAME, '--project', project, '--display-name', 'Happy FCM sender (Expo)']);
    }
    sh('gcloud', ['projects', 'add-iam-policy-binding', project, '--member', `serviceAccount:${email}`,
        '--role', 'roles/firebasecloudmessaging.admin', '--condition', 'None', '--quiet']);
    sh('gcloud', ['iam', 'service-accounts', 'keys', 'create', SA_KEY, '--iam-account', email, '--project', project]);
    if (!dryRun) chmodSync(SA_KEY, 0o600);

    updateEnv({ HAPPY_GOOGLE_SERVICES_FILE: GOOGLE_SERVICES, HAPPY_FIREBASE_PROJECT: project });
    step('Firebase ready. Next: EXPO_TOKEN=... pnpm push:setup expo --account <expo-account>');
}

// --- Expo (EAS GraphQL API, same calls `eas credentials` makes) ---

// `optional`: a GraphQL error (e.g. "not found") returns null instead of exiting.
async function expoGraphql(query, variables, { optional = false } = {}) {
    if (dryRun) {
        step(`POST ${EXPO_GRAPHQL} ${query.match(/(query|mutation) (\w+)/)?.[2]} ${JSON.stringify(variables, (k, v) => (k === 'jsonKey' ? '<service account key>' : v))}`);
        return null;
    }
    const token = process.env.EXPO_TOKEN;
    if (!token) fail('EXPO_TOKEN is not set (create one at expo.dev > Account settings > Access tokens)');
    const response = await fetch(EXPO_GRAPHQL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const json = await response.json();
    if (optional && json.errors?.length) return null;
    if (!response.ok || json.errors?.length) {
        fail(`Expo API: ${json.errors?.map((e) => e.message).join('; ') ?? response.status}`);
    }
    return json.data;
}

async function setupExpo() {
    const accountName = flag('account');
    const slug = flag('slug', 'happy');
    const packageName = flag('package', DEFAULT_PACKAGE);
    if (!dryRun && !existsSync(SA_KEY)) fail(`${SA_KEY} not found; run \`pnpm push:setup firebase\` first`);
    ensurePrivateDir();

    const account = (await expoGraphql(
        'query AccountByName($name: String!) { account { byName(accountName: $name) { id } } }',
        { name: accountName },
    ))?.account.byName;

    let projectId = flags['project-id'] ?? readEnv().HAPPY_EXPO_PROJECT_ID;
    if (!projectId) {
        const existing = (await expoGraphql(
            'query AppByFullName($name: String!) { app { byFullName(fullName: $name) { id } } }',
            { name: `@${accountName}/${slug}` },
            { optional: true },
        ))?.app?.byFullName?.id;
        projectId = existing ?? (await expoGraphql(
            'mutation CreateApp($appInput: AppInput!) { app { createApp(appInput: $appInput) { id } } }',
            { appInput: { accountId: account?.id ?? '<accountId>', projectName: slug } },
        ))?.app.createApp.id;
        step(existing ? `use existing Expo project @${accountName}/${slug}` : `create Expo project @${accountName}/${slug}`);
    }
    projectId ??= '<projectId>';

    const jsonKey = dryRun ? {} : JSON.parse(readFileSync(SA_KEY, 'utf8'));
    const keyId = (await expoGraphql(
        `mutation CreateKey($input: GoogleServiceAccountKeyInput!, $accountId: ID!) {
            googleServiceAccountKey { createGoogleServiceAccountKey(googleServiceAccountKeyInput: $input, accountId: $accountId) { id } }
        }`,
        { input: { jsonKey }, accountId: account?.id ?? '<accountId>' },
    ))?.googleServiceAccountKey.createGoogleServiceAccountKey.id ?? '<keyId>';

    const credentials = (await expoGraphql(
        `query AndroidCredentials($appId: String!, $pkg: String!) {
            app { byId(appId: $appId) { androidAppCredentials(filter: { applicationIdentifier: $pkg }) { id } } }
        }`,
        { appId: projectId, pkg: packageName },
    ))?.app.byId.androidAppCredentials[0];

    if (credentials) {
        await expoGraphql(
            `mutation SetFcmV1($id: ID!, $keyId: ID!) {
                androidAppCredentials { setGoogleServiceAccountKeyForFcmV1(id: $id, googleServiceAccountKeyId: $keyId) { id } }
            }`,
            { id: credentials.id, keyId },
        );
    } else {
        await expoGraphql(
            `mutation CreateAndroidCredentials($input: AndroidAppCredentialsInput!, $appId: ID!, $pkg: String!) {
                androidAppCredentials { createAndroidAppCredentials(androidAppCredentialsInput: $input, appId: $appId, applicationIdentifier: $pkg) { id } }
            }`,
            { input: { googleServiceAccountKeyForFcmV1Id: keyId }, appId: projectId, pkg: packageName },
        );
    }
    step(`FCM V1 key attached to ${packageName} in Expo project ${projectId}`);

    updateEnv({ HAPPY_EXPO_PROJECT_ID: projectId, HAPPY_EXPO_OWNER: accountName, HAPPY_EXPO_SLUG: slug });

    // Expo now holds the sender key; the local copy is only a liability.
    if (!flags['keep-key']) {
        step(`delete local ${SA_KEY}`);
        if (!dryRun) rmSync(SA_KEY);
    }
    step('Expo ready. Build with the exports from `pnpm push:setup env`, then re-register the device in the app.');
}

// --- GitLab CI (phone APK job) ---

function setupGitlab() {
    const env = readEnv();
    if (!dryRun && (!env.HAPPY_EXPO_PROJECT_ID || !existsSync(GOOGLE_SERVICES))) {
        fail('run the firebase and expo steps first');
    }
    const repo = flags.repo ? ['--repo', flag('repo')] : [];
    for (const key of ['HAPPY_EXPO_PROJECT_ID', 'HAPPY_EXPO_OWNER', 'HAPPY_EXPO_SLUG']) {
        sh('glab', ['variable', 'set', key, '--value', env[key] ?? `<${key}>`, ...repo]);
    }
    // File-type variable: CI exposes it as a path, which is what app.config.js expects.
    sh('glab', ['variable', 'set', 'HAPPY_GOOGLE_SERVICES_FILE', '--type', 'file', ...repo],
        { input: dryRun ? '' : readFileSync(GOOGLE_SERVICES, 'utf8') });
    step('GitLab CI variables set; the next `pnpm apk:phone` build uses them.');
}

function printEnv() {
    const env = readEnv();
    if (Object.keys(env).length === 0) fail(`${ENV_FILE} has no values yet`);
    for (const [key, value] of Object.entries(env)) console.log(`export ${key}=${value}`);
}

const commands = { firebase: setupFirebase, expo: setupExpo, gitlab: setupGitlab, env: printEnv };
if (!commands[command]) {
    console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(command ? 1 : 0);
}
await commands[command]();
