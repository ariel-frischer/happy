"""Builds the preview APK on Modal so the laptop never runs Gradle.

Run through `pnpm apk:phone --modal` (scripts/phone-apk.mjs), which passes:
  --source  a `git archive` tarball of HEAD
  --out     where to write the APK
and the build environment as JSON in $HAPPY_APK_ENV (HAPPY_* push config and
the commit sha/timestamp the app config would otherwise read from git).

A local google-services file named by HAPPY_GOOGLE_SERVICES_FILE is sent with
each build and written into the source tree; nothing is stored in Modal except
the Gradle and pnpm download caches on the `happy-apk-cache` Volume.
"""

import json
import os
import subprocess
import tarfile
import time
from io import BytesIO
from pathlib import Path

import modal

NODE = "24.21.0"
PNPM = "10.11.0"
# https://developer.android.com/studio#command-line-tools-only
CMDLINE_TOOLS = "commandlinetools-linux-13114758_latest.zip"
SDK_PACKAGES = [
    "platform-tools",
    "platforms;android-36",
    "build-tools;36.0.0",
    "ndk;27.1.12297006",
    "cmake;3.22.1",
]
SDK = "/opt/android-sdk"
CACHE = "/cache"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("openjdk-17-jdk-headless", "curl", "unzip", "xz-utils", "git", "ca-certificates")
    # Set first: npm and sdkmanager need node and java on PATH while the image builds.
    .env(
        {
            "PATH": f"/opt/node/bin:{SDK}/platform-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "JAVA_HOME": "/usr/lib/jvm/java-17-openjdk-amd64",
            "ANDROID_HOME": SDK,
            "ANDROID_SDK_ROOT": SDK,
        }
    )
    .run_commands(
        f"curl -fsSL https://nodejs.org/dist/v{NODE}/node-v{NODE}-linux-x64.tar.xz | tar -xJ -C /opt",
        f"ln -s /opt/node-v{NODE}-linux-x64 /opt/node",
        f"npm install -g pnpm@{PNPM}",
        f"mkdir -p {SDK}/cmdline-tools && cd /tmp && curl -fsSLO https://dl.google.com/android/repository/{CMDLINE_TOOLS}"
        f" && unzip -q {CMDLINE_TOOLS} -d {SDK}/cmdline-tools && mv {SDK}/cmdline-tools/cmdline-tools {SDK}/cmdline-tools/latest"
        f" && rm {CMDLINE_TOOLS}",
        f"yes | {SDK}/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null",
        f"{SDK}/cmdline-tools/latest/bin/sdkmanager --install " + " ".join(f"'{p}'" for p in SDK_PACKAGES),
    )
)

app = modal.App("happy-apk", image=image)
cache = modal.Volume.from_name("happy-apk-cache", create_if_missing=True)


def step(name: str, cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
    start = time.monotonic()
    print(f"[{name}] {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)
    print(f"[{name}] done in {time.monotonic() - start:.0f}s", flush=True)


# A cold Gradle build took 30 min on 8 CPUs, mostly native C++; CPU-seconds
# cost the same either way, so more cores mainly buys wall time.
@app.function(cpu=16, memory=24576, timeout=3600, volumes={CACHE: cache})
def build(source: bytes, build_env: dict[str, str], files: dict[str, bytes]) -> bytes:
    src = Path("/tmp/src")
    with tarfile.open(fileobj=BytesIO(source)) as archive:
        archive.extractall(src, filter="data")
    for relative, content in files.items():
        (src / relative).write_bytes(content)

    app_dir = src / "packages/happy-app"
    env = {
        **os.environ,
        "APP_ENV": "preview",
        "HAPPY_DISABLE_OTA": "1",
        "EXPO_NO_TELEMETRY": "1",
        "CI": "1",
        "GRADLE_USER_HOME": f"{CACHE}/gradle",
        "npm_config_store_dir": f"{CACHE}/pnpm-store",
        **build_env,
    }
    try:
        step("install", ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], src, env)
        step("prebuild", ["node", "../../node_modules/expo/bin/cli", "prebuild", "--platform", "android", "--no-install"], app_dir, env)
        step(
            "gradle",
            [
                "./gradlew", "assembleRelease", "-PreactNativeArchitectures=arm64-v8a",
                "-Dorg.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=1g",
                "-Pkotlin.compiler.execution.strategy=in-process",
                "--max-workers=16", "--no-daemon", "--console=plain", "-q",
            ],
            app_dir / "android",
            {**env, "NODE_ENV": "production"},
        )
    finally:
        cache.commit()
    return (app_dir / "android/app/build/outputs/apk/release/app-release.apk").read_bytes()


@app.local_entrypoint()
def main(source: str, out: str) -> None:
    build_env = json.loads(os.environ.get("HAPPY_APK_ENV", "{}"))
    files = {}
    google_services = build_env.get("HAPPY_GOOGLE_SERVICES_FILE")
    if google_services and Path(google_services).expanduser().is_absolute():
        files["packages/happy-app/google-services.fork.json"] = Path(google_services).expanduser().read_bytes()
        build_env["HAPPY_GOOGLE_SERVICES_FILE"] = "./google-services.fork.json"
    apk = build.remote(Path(source).read_bytes(), build_env, files)
    Path(out).write_bytes(apk)
    print(f"wrote {out} ({len(apk) / 1e6:.1f} MB)")
