#!/usr/bin/env node
// Builds the preview APK on GitLab CI (see .gitlab-ci.yml) and sends it to the
// phone: push the current commit to the `gitlab` remote, run the android-apk
// job, download the APK, upload it to Google Drive with `gog`, and push the
// private Drive link through ntfy.
//
//   pnpm apk:phone             # current branch
//   pnpm apk:phone --no-send   # build and download only
//
// Needs: the `gitlab` remote, a GitLab token (GITLAB_TOKEN or `glab auth`),
// `gog` signed in to Drive, and an ntfy config at NTFY_CONFIG
// (default ~/.omp/agent/ntfy-push.json: { server, topic, token? }).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = 'ariel-frischer%2Fhappy';
const API = `https://gitlab.com/api/v4/projects/${PROJECT}`;
const JOB = 'android-apk';
const POLL_MS = 30_000;
const send = !process.argv.includes('--no-send');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const token = process.env.GITLAB_TOKEN || run('glab', ['config', 'get', 'token', '--host', 'gitlab.com']);
if (!token) throw new Error('No GitLab token: set GITLAB_TOKEN or run `glab auth login`.');

async function gitlab(path, init = {}) {
    const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!response.ok) throw new Error(`GitLab ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
    return response;
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch === 'HEAD') throw new Error('Check out a branch first: the pipeline runs on a GitLab branch.');
const shortSha = run('git', ['rev-parse', '--short=8', 'HEAD']);

// A normal push: if GitLab's branch has diverged, stop rather than overwrite it.
console.log(`Pushing ${branch} (${shortSha}) to gitlab...`);
execFileSync('git', ['push', 'gitlab', `HEAD:refs/heads/${branch}`], { stdio: 'inherit' });

const pipeline = await (await gitlab('/pipeline', {
    method: 'POST',
    body: JSON.stringify({ ref: branch, variables: [{ key: 'BUILD_APK', value: '1' }] }),
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
    await new Promise((done) => setTimeout(done, POLL_MS));
}

const apkName = `happy-preview-${job.commit.short_id}.apk`;
const outDir = resolve('.worktrees/apk');
mkdirSync(outDir, { recursive: true });
const apkPath = join(outDir, apkName);
const artifact = await gitlab(`/jobs/${job.id}/artifacts/dist/${apkName}`);
writeFileSync(apkPath, Buffer.from(await artifact.arrayBuffer()));
console.log(`Downloaded ${apkPath}`);
if (!send) process.exit(0);

const upload = run('gog', ['drive', 'upload', apkPath, '--name', apkName]);
const link = upload.match(/^link\s+(\S+)/m)?.[1];
if (!link) throw new Error(`No Drive link in gog output:\n${upload}`);

const ntfy = JSON.parse(readFileSync(process.env.NTFY_CONFIG ?? join(homedir(), '.omp/agent/ntfy-push.json'), 'utf8'));
const notify = await fetch(`${ntfy.server}/${ntfy.topic}`, {
    method: 'POST',
    headers: {
        Title: `Happy APK ready (${branch} ${job.commit.short_id})`,
        Tags: 'package',
        Click: link,
        ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}),
    },
    body: `Tap to download ${apkName} (private Drive link).`,
});
if (!notify.ok) throw new Error(`ntfy: ${notify.status} ${await notify.text()}`);
console.log(`Sent to phone: ${link}`);
