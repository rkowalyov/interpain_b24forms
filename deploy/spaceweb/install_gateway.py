#!/usr/bin/python3
"""One-time, explicitly authorized VPS bootstrap. Does not deploy or restart the app."""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import tempfile

APP = pathlib.Path("/opt/interpain_b24forms")
GATEWAY = pathlib.Path("/usr/local/sbin/interpain-release")
SUDOERS = pathlib.Path("/etc/sudoers.d/interpain-spaceweb")
HOME = pathlib.Path("/var/lib/b24deploy")
BUILD_HOME = pathlib.Path("/var/lib/interpain-build")
MARKER = pathlib.Path("/var/lib/interpain-spaceweb-bootstrap.json")
USER = "b24deploy"
SERVICE = "interpain-b24forms.service"


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def public_key(value):
    parts = value.strip().split()
    if len(parts) not in {2, 3} or parts[0] != "ssh-ed25519" or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", parts[1]):
        raise ValueError("A single public Ed25519 key is required")
    decoded = base64.b64decode(parts[1], validate=True)
    if len(decoded) != 51 or decoded[:19] != b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20":
        raise ValueError("Invalid public Ed25519 key encoding")
    return " ".join(parts)


def install(key):
    if os.geteuid() != 0:
        raise ValueError("Run this one-time installer as root")
    key = public_key(key)
    source = pathlib.Path(__file__).with_name("release_gateway.py")
    if not source.is_file():
        raise ValueError("release_gateway.py must be next to this installer")
    for binary in ["/usr/bin/python3", "/usr/bin/node", "/usr/bin/npm", "/usr/bin/sudo",
                   "/usr/sbin/runuser", "/usr/sbin/useradd", "/usr/sbin/visudo"]:
        if not os.access(binary, os.X_OK):
            raise ValueError(f"Required executable is unavailable: {binary}")
    if APP.is_symlink() or not (APP / "server.js").is_file() or not (APP / ".env").is_file():
        raise ValueError("Existing application layout differs; nothing will be replaced")
    if run(["/usr/bin/systemctl", "show", SERVICE, "-p", "User", "--value"]) != "www-data":
        raise ValueError("Unexpected service user")
    if run(["/usr/bin/systemctl", "show", SERVICE, "-p", "WorkingDirectory", "--value"]) != str(APP):
        raise ValueError("Unexpected service working directory")
    if str(APP / ".env") not in run([
            "/usr/bin/systemctl", "show", SERVICE, "-p", "EnvironmentFiles", "--value"]):
        raise ValueError("Unexpected service environment-file location")
    run(["/usr/bin/systemctl", "is-active", "--quiet", SERVICE])
    try:
        pwd.getpwnam(USER)
    except KeyError:
        existing_user = False
    else:
        existing_user = True
    if existing_user or any(item.exists() for item in (
            GATEWAY, SUDOERS, MARKER, HOME, BUILD_HOME, pathlib.Path("/var/lib/interpain-spaceweb"))):
        raise ValueError("Deployment access already exists or conflicts; refusing to overwrite")
    host = pathlib.Path("/etc/ssh/ssh_host_ed25519_key.pub").read_text().split()
    if len(host) < 2 or host[0] != "ssh-ed25519":
        raise ValueError("Expected public Ed25519 host key is unavailable")
    run(["/usr/sbin/visudo", "-cf", "/etc/sudoers"])
    ssh_directory = HOME / ".ssh"
    forced = (
        'restrict,command="/usr/bin/sudo -n /usr/local/sbin/interpain-release '
        '\\"$SSH_ORIGINAL_COMMAND\\"" ' + key + "\n"
    )
    rule = "b24deploy ALL=(root) NOPASSWD: /usr/local/sbin/interpain-release *\n"
    with tempfile.NamedTemporaryFile("w", prefix="interpain-sudoers-", delete=False) as temporary:
        temporary.write(rule)
        candidate = pathlib.Path(temporary.name)
    try:
        candidate.chmod(0o440)
        run(["/usr/sbin/visudo", "-cf", str(candidate)])
        run(["/usr/sbin/useradd", "--create-home", "--home-dir", str(HOME),
             "--shell", "/bin/bash", USER])
        account = pwd.getpwnam(USER)
        HOME.chmod(0o700)
        ssh_directory.mkdir(mode=0o700)
        authorized = ssh_directory / "authorized_keys"
        authorized.write_text(forced)
        authorized.chmod(0o600)
        for item in (HOME, ssh_directory, authorized):
            os.chown(item, account.pw_uid, account.pw_gid)
        BUILD_HOME.mkdir(mode=0o700)
        shutil.chown(BUILD_HOME, user=USER, group=USER)
        shutil.copyfile(source, GATEWAY)
        GATEWAY.chmod(0o755)
        os.chown(GATEWAY, 0, 0)
        shutil.copyfile(candidate, SUDOERS)
        SUDOERS.chmod(0o440)
        os.chown(SUDOERS, 0, 0)
        run(["/usr/sbin/visudo", "-cf", "/etc/sudoers"])
        MARKER.write_text(json.dumps({
            "user": USER, "gateway_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "public_key": key
        }, sort_keys=True))
        MARKER.chmod(0o600)
    finally:
        candidate.unlink(missing_ok=True)
    # Host PUBLIC key only. Never reads .env contents or any private SSH key.
    print("SETUP_OK: restricted deployment access installed; application was not restarted.")
    print("KNOWN_HOSTS_PUBLIC: 194.226.99.172 " + " ".join(host[:2]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-key", required=True)
    args = parser.parse_args()
    install(args.public_key)
