#!/usr/bin/python3
"""Root-owned forced-command gateway. No shell, Git operations, or secret reads."""
import fcntl
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.error
import uuid

ORIGINAL = pathlib.Path("/opt/interpain_b24forms")
RELEASES = pathlib.Path("/opt/interpain_b24forms-releases")
CURRENT = pathlib.Path("/opt/interpain_b24forms-current")
STATE = pathlib.Path("/var/lib/interpain-spaceweb")
DROPIN = pathlib.Path("/etc/systemd/system/interpain-b24forms.service.d/30-spaceweb-releases.conf")
SERVICE = "interpain-b24forms.service"
DEPLOY_USER = "b24deploy"
MAX_COMPRESSED = 50 * 1024 * 1024
MAX_EXPANDED = 200 * 1024 * 1024
MAX_FILES = 5000
REQUIRED = {"server.js", "package.json", "package-lock.json", "spravka.html",
            "lib/bitrix-event-api.js", "lib/bitrix-spravka.js"}
DROPIN_TEXT = (
    "[Service]\nWorkingDirectory=/opt/interpain_b24forms-current\n"
    "ExecStart=\nExecStart=/usr/bin/node /opt/interpain_b24forms-current/server.js\n"
)


def command(text):
    if text in {"check", "rollback"}:
        return text, None
    match = re.fullmatch(r"deploy ([0-9a-f]{40})", text)
    if match:
        return "deploy", match.group(1)
    raise ValueError("Only check, deploy <full SHA>, or rollback is allowed")


def allowed(name):
    parts = pathlib.PurePosixPath(name).parts
    if not parts or name.startswith("/") or any(p in {"", ".", ".."} or p.startswith(".") for p in parts):
        return False
    if any(p.lower().endswith((".env", ".pem", ".key")) for p in parts):
        return False
    if len(parts) == 1:
        return name in {"server.js", "package.json", "package-lock.json", "release.json"} or bool(
            re.fullmatch(r"[A-Za-z0-9_-]+\.html", name))
    return parts[0] in {"api", "lib", "assets", "scenarios"}


def unpack(data, destination, commit):
    """Reject traversal, duplicate paths, links, devices, hidden files and oversized data."""
    destination = pathlib.Path(destination)
    names = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for number, entry in enumerate(archive, 1):
            if number > MAX_FILES or not entry.isfile() or not allowed(entry.name):
                raise ValueError("Archive contains an unsupported entry")
            if entry.name in names:
                raise ValueError("Archive contains duplicate paths")
            names.add(entry.name)
            total += entry.size
            if entry.size < 0 or total > MAX_EXPANDED:
                raise ValueError("Archive size limit exceeded")
            target = destination / entry.name
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError("Archive path escapes release directory")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(entry) as stream:
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                with os.fdopen(descriptor, "wb") as output:
                    shutil.copyfileobj(stream, output)
    if not REQUIRED.issubset(names) or "release.json" not in names:
        raise ValueError("Required runtime files are missing")
    metadata = json.loads((destination / "release.json").read_text())
    if metadata.get("commit") != commit or set(metadata.get("files", {})) != names - {"release.json"}:
        raise ValueError("Release manifest does not match the requested commit")
    for name, expected in metadata["files"].items():
        if not re.fullmatch(r"[0-9a-f]{64}", str(expected)):
            raise ValueError("Invalid release checksum")
        actual = hashlib.sha256((destination / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError("Release checksum mismatch")
    return metadata


def run(args, timeout=60, capture=False):
    return subprocess.run(args, check=True, timeout=timeout,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None, text=True)


def secure_path(target):
    resolved = pathlib.Path(target).resolve()
    if resolved.is_dir() and (resolved == ORIGINAL or (
            resolved.parent == RELEASES and re.fullmatch(r"[0-9a-f]{40}", resolved.name))):
        return resolved
    raise ValueError("Release target is outside the allowed directories")


def swap_link(target):
    temporary = CURRENT.with_name(CURRENT.name + "." + uuid.uuid4().hex)
    try:
        temporary.symlink_to(str(secure_path(target)))
        os.replace(temporary, CURRENT)
    finally:
        temporary.unlink(missing_ok=True)


def health():
    checks = [("/health", 200), ("/spravka", 200), ("/api/spravka", 401)]
    for route, expected in checks:
        try:
            with urllib.request.urlopen("http://127.0.0.1:3001" + route, timeout=3) as response:
                status = response.status
                body = response.read(4096)
        except urllib.error.HTTPError as error:
            status, body = error.code, b""
        if status != expected:
            return False
        if route == "/health" and json.loads(body).get("ok") is not True:
            return False
    return True


def wait_healthy():
    for _ in range(20):
        try:
            if health():
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("Application smoke checks did not pass")


def record_previous(previous):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = STATE / ("previous." + uuid.uuid4().hex)
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(str(previous))
        os.replace(temporary, STATE / "previous")
    finally:
        temporary.unlink(missing_ok=True)


def activate(target):
    """Switch only this service. Restore its previous target and drop-in on failure."""
    target = secure_path(target)
    if CURRENT.exists() and not CURRENT.is_symlink():
        raise ValueError("Current release path exists but is not a symlink")
    previous = secure_path(CURRENT.resolve()) if CURRENT.is_symlink() else ORIGINAL
    had_dropin = DROPIN.exists()
    if had_dropin and DROPIN.read_text() != DROPIN_TEXT:
        raise ValueError("Existing release drop-in differs; refusing to overwrite")
    swapped = False
    try:
        swap_link(target)
        swapped = True
        if not had_dropin:
            DROPIN.parent.mkdir(parents=True, exist_ok=True)
            DROPIN.write_text(DROPIN_TEXT)
            DROPIN.chmod(0o644)
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "restart", SERVICE])
        wait_healthy()
        record_previous(previous)
    except BaseException:
        if swapped:
            swap_link(previous)
            if not had_dropin:
                DROPIN.unlink(missing_ok=True)
            run(["/usr/bin/systemctl", "daemon-reload"])
            run(["/usr/bin/systemctl", "restart", SERVICE])
            wait_healthy()
        raise
    print(json.dumps({"result": "active", "release": str(target), "previous": str(previous)}))


def readonly_check():
    active = run(["/usr/bin/systemctl", "is-active", SERVICE], capture=True).stdout.strip()
    healthy = health()
    print(json.dumps({"ssh": "ok", "service": active, "smoke_checks": healthy,
                      "release": str(CURRENT.resolve()) if CURRENT.is_symlink() else str(ORIGINAL)}))
    if active != "active" or not healthy:
        raise RuntimeError("Read-only service or HTTP checks did not pass")


def lock_release_files(target):
    """Do not leave application sources writable by the SSH or service user."""
    for root, directories, files in os.walk(target, followlinks=False):
        os.chown(root, 0, 0)
        os.chmod(root, 0o755)
        for name in directories + files:
            entry = pathlib.Path(root) / name
            os.chown(entry, 0, 0, follow_symlinks=False)
            if not entry.is_symlink():
                mode = entry.stat().st_mode
                os.chmod(entry, 0o755 if entry.is_dir() or mode & 0o111 else 0o644)


def deploy(commit):
    RELEASES.mkdir(mode=0o755, exist_ok=True)
    destination = RELEASES / commit
    if destination.exists():
        raise ValueError("Release directory already exists; use a new commit or rollback")
    payload = sys.stdin.buffer.read(MAX_COMPRESSED + 1)
    if len(payload) > MAX_COMPRESSED:
        raise ValueError("Compressed archive limit exceeded")
    temporary = pathlib.Path(tempfile.mkdtemp(prefix=".incoming-", dir=RELEASES))
    try:
        unpack(payload, temporary, commit)
        # Dependency installation never runs as root and lifecycle scripts are disabled.
        shutil.chown(temporary, user=DEPLOY_USER, group=DEPLOY_USER)
        for root, directories, files in os.walk(temporary):
            for name in directories + files:
                shutil.chown(pathlib.Path(root) / name, user=DEPLOY_USER, group=DEPLOY_USER)
        run(["/usr/sbin/runuser", "-u", DEPLOY_USER, "--", "/usr/bin/env",
             "HOME=/var/lib/interpain-build", "npm_config_cache=/var/lib/interpain-build/npm",
             "/usr/bin/npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
             "--prefix", str(temporary)], timeout=300)
        run(["/usr/bin/node", "--check", str(temporary / "server.js")])
        lock_release_files(temporary)
        temporary.rename(destination)
        activate(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise ValueError("This gateway must run through its fixed sudo rule")
    action, commit = command(sys.argv[1])
    if action == "check":
        readonly_check()
        return
    with open("/run/lock/interpain-spaceweb.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if action == "deploy":
            deploy(commit)
        else:
            previous = STATE / "previous"
            if not previous.is_file():
                raise ValueError("No previous successful release is recorded")
            activate(secure_path(previous.read_text().strip()))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No raw HTTP responses, service environments or request URLs in logs.
        print(f"Release failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
