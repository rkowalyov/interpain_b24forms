#!/usr/bin/env python3
"""Build a deterministic, credential-free runtime archive. Standard library only."""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import tarfile

ROOT_FILES = {"server.js", "package.json", "package-lock.json"}
RUNTIME_DIRS = {"api", "lib", "assets", "scenarios"}
REQUIRED = ROOT_FILES | {"spravka.html", "spravka-admin.html", "lib/bitrix-event-api.js",
                         "lib/bitrix-spravka.js", "lib/bitrix-spravka-app.js",
                         "lib/bitrix-spravka-settings.js"}


def allowed(name):
    parts = pathlib.PurePosixPath(name).parts
    if not parts or name.startswith("/") or any(p in {"", ".", ".."} or p.startswith(".") for p in parts):
        return False
    if any(p.lower().endswith((".env", ".pem", ".key")) for p in parts):
        return False
    if len(parts) == 1:
        return name in ROOT_FILES or bool(re.fullmatch(r"[A-Za-z0-9_-]+\.html", name))
    return parts[0] in RUNTIME_DIRS


def build(source, commit, output):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("A full lowercase Git commit SHA is required")
    source = pathlib.Path(source).resolve()
    files = {}
    for item in sorted(source.rglob("*")):
        relative = item.relative_to(source).as_posix()
        if item.is_symlink():
            if allowed(relative):
                raise ValueError(f"Runtime symlink is not allowed: {relative}")
            continue
        if item.is_file() and allowed(relative):
            files[relative] = item.read_bytes()
    missing = REQUIRED - files.keys()
    if missing:
        raise ValueError("Runtime files missing: " + ", ".join(sorted(missing)))
    metadata = {
        "commit": commit,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }
    files["release.json"] = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()
    with open(output, "wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for name, data in files.items():
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    entry.mode = 0o644
                    entry.mtime = 0
                    archive.addfile(entry, io.BytesIO(data))
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("commit")
    parser.add_argument("output")
    args = parser.parse_args()
    result = build(args.source, args.commit, args.output)
    print(f"Runtime archive: {len(result['files'])} files, commit {args.commit}")
