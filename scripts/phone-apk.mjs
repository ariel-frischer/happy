#!/usr/bin/env node
// Builds the preview APK and sends it to the phone: build, publish it to the
// tailnet-only update feed Obtainium watches, and push a notification
// through ntfy.
//
//   pnpm apk:phone --modal     # build HEAD on Modal (cloud), nothing heavy runs here
//   pnpm apk:phone --local     # build HEAD on this machine, memory-capped
//   pnpm apk:phone             # build the current branch on GitLab CI
//   add --no-send              # build only, keep the APK in .worktrees/apk/
//
// APKs are named happy-preview-<build>-<sha>.apk, where <build> is the commit
// count of HEAD (shown in the app's Settings as "build <n>"), so the newest
// build has the highest number.
//
// --local builds a detached worktree of HEAD inside its own systemd user
// service with hard memory/swap/CPU limits, so a runaway build is the only
// thing that dies and no Gradle daemon outlives it. It waits until the
// 1-minute load average is below half the cores, and uses the fork's push
// config from $HAPPY_PUSH_DIR/push.env when present
// (docs/fork-push-notifications.md).
//
// Needs: `tailscale` (the feed is served on this machine's tailnet IP by a
// systemd user service, a static file server), and an ntfy
// config at NTFY_CONFIG (default ~/.omp/agent/ntfy-push.json:
// { server, topic, token? }).
// --local also needs JDK 17 via mise and the Android SDK at ANDROID_HOME
// (default ~/Android/Sdk); --modal needs `uv` and a Modal token
// (~/.modal.toml) and runs scripts/phone-apk-modal.py; CI needs the `gitlab`
// remote and a GitLab token (GITLAB_TOKEN or `glab auth`).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = 'ariel-frischer%2Fhappy';
const API = `https://gitlab.com/api/v4/projects/${PROJECT}`;
const JOB = 'android-apk';
const POLL_MS = 30_000;
// The Obtainium feed: a directory served at http://<tailnet IP>:8798/ by a
// user service bound to the tailnet address only (the same plain-HTTP link
// handup's APK uses; the ts.net HTTPS name did not open on the phone).
// index.html links only the newest APK; older ones stay downloadable until
// pruned.
const FEED_DIR = process.env.HAPPY_APK_FEED_DIR || join(homedir(), '.local/share/happy-apk');
const FEED_KEEP = 5;
const FEED_PORT = 8798;
const FEED_UNIT = 'happy-apk-feed.service';
// Hard limits for the local build's cgroup. Peak RSS of a cold build is
// roughly 8-10 GB (Gradle 5 GB heap, Metro, R8); above MemoryHigh the kernel
// reclaims from the build first, at MemoryMax only the build is killed.
const LIMITS = ['MemoryHigh=9G', 'MemoryMax=11G', 'MemorySwapMax=4G', 'CPUQuota=800%', 'Nice=10'];
const send = !process.argv.includes('--no-send');
const local = process.argv.includes('--local');
const modal = process.argv.includes('--modal');
const MODAL_VERSION = '1.6.0';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const repo = run('git', ['rev-parse', '--show-toplevel']);
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const shortSha = run('git', ['rev-parse', '--short=8', 'HEAD']);
const buildNumber = run('git', ['rev-list', '--count', 'HEAD']);
const apkName = `happy-preview-${buildNumber}-${shortSha}.apk`;
const outDir = join(repo, '.worktrees/apk');
mkdirSync(outDir, { recursive: true });

async function buildOnGitlab() {
    const token = process.env.GITLAB_TOKEN || run('glab', ['config', 'get', 'token', '--host', 'gitlab.com']);
    if (!token) throw new Error('No GitLab token: set GITLAB_TOKEN or run `glab auth login`.');
    if (branch === 'HEAD') throw new Error('Check out a branch first: the pipeline runs on a GitLab branch.');

    async function gitlab(path, init = {}) {
        const response = await fetch(`${API}${path}`, {
            ...init,
            headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json', ...init.headers },
        });
        if (!response.ok) throw new Error(`GitLab ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
        return response;
    }

    // A normal push: if GitLab's branch has diverged, stop rather than overwrite it.
    console.log(`Pushing ${branch} (${shortSha}) to gitlab...`);
    execFileSync('git', ['push', 'gitlab', `HEAD:refs/heads/${branch}`], { stdio: 'inherit' });

    const pipeline = await (await gitlab('/pipeline', {
        method: 'POST',
        body: JSON.stringify({
            ref: branch,
            variables: [{ key: 'BUILD_APK', value: '1' }, { key: 'HAPPY_BUILD_NUMBER', value: buildNumber }],
        }),
    })).json();
    console.log(`Pipeline ${pipeline.web_url}`);

    let job;
    for (;;) {
        const jobs = await (await gitlab(`/pipelines/${pipeline.id}/jobs`)).json();
        job = jobs.find((candidate) => candidate.name === JOB);
        const status = job?.status ?? 'pending';
        if (status === 'success') break;
        if (['failed', 'canceled', 'skipped'].includes(status)) {
            throw new Error(`${JOB} ${status}: ${job.web_url}`);
        }
        console.log(`${new Date().toLocaleTimeString()} ${JOB}: ${status}`);
        await sleep(POLL_MS);
    }

    const apkPath = join(outDir, apkName);
    const artifact = await gitlab(`/jobs/${job.id}/artifacts/dist/happy-preview-${job.commit.short_id}.apk`);
    writeFileSync(apkPath, Buffer.from(await artifact.arrayBuffer()));
    return apkPath;
}

// HAPPY_* values from the fork's private push config, if it has been set up.
function pushEnv() {
    const file = join(resolve(process.env.HAPPY_PUSH_DIR || join(homedir(), '.config/happy-push')), 'push.env');
    if (!existsSync(file)) return {};
    const env = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const match = line.match(/^(HAPPY_[A-Z0-9_]+)=(.*)$/);
        if (match) env[match[1]] = match[2];
    }
    console.log(`Using fork push config ${file}`);
    return env;
}

// Sends a `git archive` of HEAD to scripts/phone-apk-modal.py, which builds
// the same preview variant as --local on a Modal container and writes the APK
// back. The push config travels in the environment, not argv or Modal secrets.
function buildOnModal() {
    const source = join(outDir, `src-${shortSha}.tar`);
    const apkPath = join(outDir, apkName);
    execFileSync('git', ['archive', '--format=tar', '-o', source, 'HEAD'], { stdio: 'inherit' });
    const buildEnv = {
        HAPPY_BUILD_COMMIT_SHA: run('git', ['rev-parse', 'HEAD']),
        HAPPY_BUILD_COMMIT_TIMESTAMP: run('git', ['show', '-s', '--format=%cI', 'HEAD']),
        HAPPY_BUILD_NUMBER: buildNumber,
        ...pushEnv(),
    };
    try {
        execFileSync('uvx', [
            '--from', `modal==${MODAL_VERSION}`, 'modal', 'run', join(repo, 'scripts/phone-apk-modal.py'),
            '--source', source, '--out', apkPath,
        ], { stdio: 'inherit', env: { ...process.env, HAPPY_APK_ENV: JSON.stringify(buildEnv) } });
    } finally {
        rmSync(source, { force: true });
    }
    return apkPath;
}

async function buildLocally() {
    const cores = cpus().length;
    while (loadavg()[0] >= cores / 2) {
        console.log(`${new Date().toLocaleTimeString()} load ${loadavg()[0].toFixed(1)} >= ${cores / 2}; waiting`);
        await sleep(60_000);
    }

    const worktree = join(repo, '.worktrees/apk-build');
    if (existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { stdio: 'inherit' });
    execFileSync('git', ['worktree', 'add', '--detach', worktree, shortSha], { stdio: 'inherit' });

    const sdk = process.env.ANDROID_HOME || join(homedir(), 'Android/Sdk');
    const env = {
        PATH: process.env.PATH,
        HOME: homedir(),
        JAVA_HOME: run('mise', ['where', 'java@temurin-17']),
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: sdk,
        APP_ENV: 'preview',
        HAPPY_DISABLE_OTA: '1',
        EXPO_NO_TELEMETRY: '1',
        CI: '1',
        HAPPY_BUILD_NUMBER: buildNumber,
        ...pushEnv(),
    };
    // Each step runs as its own transient service: the limits apply to the
    // whole process tree, and systemd kills whatever is left when it exits.
    const capped = (name, cwd, cmd, args, extraEnv = {}) => {
        console.log(`[${name}] ${cmd} ${args.join(' ')}`);
        execFileSync('systemd-run', [
            '--user', '--wait', '--pipe', '--collect', '--quiet',
            `--unit=happy-apk-${shortSha}-${name}`,
            ...LIMITS.flatMap((limit) => ['-p', limit]),
            `--working-directory=${cwd}`,
            ...Object.entries({ ...env, ...extraEnv }).map(([key, value]) => `--setenv=${key}=${value}`),
            cmd, ...args,
        ], { stdio: ['ignore', 'inherit', 'inherit'] });
    };

    try {
        const app = join(worktree, 'packages/happy-app');
        capped('install', worktree, 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline']);
        capped('prebuild', app, 'node', ['../../node_modules/expo/bin/cli', 'prebuild', '--platform', 'android', '--no-install']);
        capped('gradle', join(app, 'android'), './gradlew', [
            'assembleRelease', '-PreactNativeArchitectures=arm64-v8a',
            '-Dorg.gradle.jvmargs=-Xmx5g -XX:MaxMetaspaceSize=1g',
            // Compile Kotlin inside Gradle instead of a separate daemon JVM.
            '-Pkotlin.compiler.execution.strategy=in-process',
            '--max-workers=4', '--no-daemon', '--console=plain', '-q',
        ], { NODE_ENV: 'production' });

        const apkPath = join(outDir, apkName);
        copyFileSync(join(app, 'android/app/build/outputs/apk/release/app-release.apk'), apkPath);
        return apkPath;
    } finally {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], { stdio: 'inherit' });
        rmSync(worktree, { recursive: true, force: true });
    }
}

const apkPath = modal ? buildOnModal() : local ? await buildLocally() : await buildOnGitlab();
console.log(`APK ${apkPath}`);
if (!send) process.exit(0);

const url = publish();
const ntfy = JSON.parse(readFileSync(process.env.NTFY_CONFIG ?? join(homedir(), '.omp/agent/ntfy-push.json'), 'utf8'));
const notify = await fetch(`${ntfy.server}/${ntfy.topic}`, {
    method: 'POST',
    headers: {
        Title: `Happy preview build ${buildNumber} ready (${branch} ${shortSha})`,
        Tags: 'package',
        Click: url,
        Actions: `view, Download APK, ${url}`,
        ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}),
    },
    body: `${apkName} is on the update feed: update it in Obtainium, or tap to download.`,
});
if (!notify.ok) throw new Error(`ntfy: ${notify.status} ${await notify.text()}`);
console.log(`Published ${url}`);

// Moves the APK into the feed (no copy stays in .worktrees/apk, so sent
// builds don't pile up in the repo), prunes old builds, points index.html at
// the new one and makes sure the feed server is running. Returns the APK's URL.
function publish() {
    mkdirSync(FEED_DIR, { recursive: true });
    copyFileSync(apkPath, join(FEED_DIR, apkName));
    rmSync(apkPath);
    const build = (name) => Number(name.match(/^happy-preview-(\d+)-/)?.[1] ?? -1);
    const apks = readdirSync(FEED_DIR).filter((name) => build(name) >= 0).sort((a, b) => build(b) - build(a));
    for (const old of apks.slice(FEED_KEEP)) rmSync(join(FEED_DIR, old));
    writeFileSync(join(FEED_DIR, 'index.html'),
        `<!doctype html><title>Happy preview</title>\n<a href="${apkName}">${apkName}</a>\n`);

    const ip = run('tailscale', ['ip', '-4']).split('\n')[0];
    ensureFeedServer(ip);
    return `http://${ip}:${FEED_PORT}/${apkName}`;
}

// Installs and starts the feed's file server as a user unit bound to the
// tailnet IP, so it is unreachable from other networks and comes back after a
// reboot (retrying until tailscale has the address).
function ensureFeedServer(ip) {
    const unitPath = join(homedir(), '.config/systemd/user', FEED_UNIT);
    const unit = `[Unit]
Description=Happy preview APK feed (tailnet only)

[Service]
ExecStart=/usr/bin/env python3 -m http.server ${FEED_PORT} --bind ${ip} --directory ${FEED_DIR}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
    if (!existsSync(unitPath) || readFileSync(unitPath, 'utf8') !== unit) {
        mkdirSync(join(homedir(), '.config/systemd/user'), { recursive: true });
        writeFileSync(unitPath, unit);
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
        execFileSync('systemctl', ['--user', 'enable', FEED_UNIT], { stdio: 'inherit' });
        execFileSync('systemctl', ['--user', 'restart', FEED_UNIT], { stdio: 'inherit' });
        return;
    }
    execFileSync('systemctl', ['--user', 'enable', '--now', FEED_UNIT], { stdio: 'inherit' });
}
