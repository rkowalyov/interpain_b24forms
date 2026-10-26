import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parents[1]
COMMIT = "a" * 40


def module(name):
    specification = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    result = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(result)
    return result


packager = module("package_release")
gateway = module("release_gateway")
installer = module("install_gateway")


def source_fixture(root):
    for name in packager.REQUIRED:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("{}" if name.endswith(".json") else "test source")
    (root / ".env").write_text("SENSITIVE=do-not-package")
    (root / ".tmp.env").write_text("SENSITIVE=also-do-not-package")
    (root / "README.md").write_text("Documentation")
    return root


def archive_with(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, payload, kind in entries:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.size = len(payload) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                entry.linkname = "/etc/passwd"
            archive.addfile(entry, io.BytesIO(payload) if entry.isfile() else None)
    return output.getvalue()


class PackagingTests(unittest.TestCase):
    def test_runtime_allowlist_matches_gateway_and_excludes_secrets(self):
        cases = {
            "server.js": True, "spravka.html": True, "lib/a.js": True,
            "assets/fonts/GolosText.ttf": True, ".env": False, ".tmp.env": False,
            "assets/.env": False, "lib/secret.key": False, ".git/config": False,
            "../server.js": False, "/server.js": False, "api/../server.js": False,
            "scripts/private.cjs": False, "deploy/install.py": False,
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(packager.allowed(name), expected)
                self.assertEqual(gateway.allowed(name), expected)

    def test_package_roundtrip_is_deterministic_and_contains_no_env(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            source = source_fixture(base / "source")
            first, second = base / "first.tar.gz", base / "second.tar.gz"
            packager.build(source, COMMIT, first)
            packager.build(source, COMMIT, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            destination = base / "unpacked"
            destination.mkdir()
            metadata = gateway.unpack(first.read_bytes(), destination, COMMIT)
            self.assertEqual(metadata["commit"], COMMIT)
            self.assertEqual(set(metadata["files"]), packager.REQUIRED)
            self.assertFalse((destination / ".env").exists())
            self.assertFalse((destination / ".tmp.env").exists())

    def test_required_files_and_exact_commit_are_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with self.assertRaises(ValueError):
                packager.build(root, "main", root / "out.tar.gz")
            with self.assertRaises(ValueError):
                packager.build(root, COMMIT, root / "out.tar.gz")

    def test_runtime_symlinks_are_never_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = source_fixture(pathlib.Path(directory))
            target = root / "assets" / "leak"
            target.parent.mkdir()
            target.symlink_to(root / ".env")
            with self.assertRaises(ValueError):
                packager.build(root, COMMIT, root / "out.tar.gz")

    def test_reject_traversal_links_devices_duplicate_names_and_secrets(self):
        attacks = [
            [("../outside", b"x", tarfile.REGTYPE)],
            [("/tmp/outside", b"x", tarfile.REGTYPE)],
            [("api/link", b"", tarfile.SYMTYPE)],
            [("api/link", b"", tarfile.LNKTYPE)],
            [("api/device", b"", tarfile.CHRTYPE)],
            [(".env", b"secret", tarfile.REGTYPE)],
            [("lib/private.key", b"secret", tarfile.REGTYPE)],
            [("server.js", b"x", tarfile.REGTYPE), ("server.js", b"y", tarfile.REGTYPE)],
        ]
        for entries in attacks:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    gateway.unpack(archive_with(entries), pathlib.Path(directory), COMMIT)

    def test_reject_manifest_tampering_and_wrong_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = source_fixture(root / "source")
            payload = root / "out.tar.gz"
            packager.build(source, COMMIT, payload)
            for expected in ["b" * 40]:
                destination = root / expected
                destination.mkdir()
                with self.assertRaises(ValueError):
                    gateway.unpack(payload.read_bytes(), destination, expected)
            entries = []
            with tarfile.open(payload, "r:gz") as archive:
                for entry in archive:
                    data = archive.extractfile(entry).read()
                    if entry.name == "server.js":
                        data = b"changed source"
                    entries.append((entry.name, data, tarfile.REGTYPE))
            destination = root / "tampered"
            destination.mkdir()
            with self.assertRaises(ValueError):
                gateway.unpack(archive_with(entries), destination, COMMIT)

    def test_archive_count_and_expanded_size_are_bounded(self):
        payload = archive_with([("server.js", b"too much", tarfile.REGTYPE)])
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(gateway, "MAX_EXPANDED", 1):
                with self.assertRaises(ValueError):
                    gateway.unpack(payload, pathlib.Path(directory), COMMIT)
            with mock.patch.object(gateway, "MAX_FILES", 0):
                with self.assertRaises(ValueError):
                    gateway.unpack(payload, pathlib.Path(directory), COMMIT)


class GatewayTests(unittest.TestCase):
    def test_only_fixed_commands_are_allowed(self):
        self.assertEqual(gateway.command("check"), ("check", None))
        self.assertEqual(gateway.command("rollback"), ("rollback", None))
        self.assertEqual(gateway.command("deploy " + COMMIT), ("deploy", COMMIT))
        for value in ["bash", "", "--bootstrap", "deploy main", "check; id",
                      "check\nid", "deploy " + COMMIT + "\n", "deploy " + "A" * 40]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                gateway.command(value)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.original = self.root / "original"
        self.releases = self.root / "releases"
        self.target = self.releases / COMMIT
        self.original.mkdir()
        self.target.mkdir(parents=True)
        self.current = self.root / "current"
        self.dropin = self.root / "systemd" / "30-release.conf"
        self.state = self.root / "state"
        for name, value in [("ORIGINAL", self.original), ("RELEASES", self.releases),
                            ("CURRENT", self.current), ("DROPIN", self.dropin), ("STATE", self.state)]:
            patcher = mock.patch.object(gateway, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_successful_activation_records_previous_without_touching_original(self):
        sentinel = self.original / ".env"
        sentinel.write_text("secret must stay here")
        with mock.patch.object(gateway, "run") as run, mock.patch.object(gateway, "wait_healthy"):
            gateway.activate(self.target)
        self.assertEqual(self.current.resolve(), self.target)
        self.assertEqual((self.state / "previous").read_text(), str(self.original))
        self.assertEqual(sentinel.read_text(), "secret must stay here")
        self.assertEqual(self.dropin.read_text(), gateway.DROPIN_TEXT)
        run.assert_any_call(["/usr/bin/systemctl", "restart", gateway.SERVICE])

    def test_failed_first_activation_restores_original_and_removes_only_own_dropin(self):
        with mock.patch.object(gateway, "run"), mock.patch.object(
                gateway, "wait_healthy", side_effect=[RuntimeError("test failure"), None]):
            with self.assertRaises(RuntimeError):
                gateway.activate(self.target)
        self.assertEqual(self.current.resolve(), self.original)
        self.assertFalse(self.dropin.exists())
        self.assertFalse((self.state / "previous").exists())

    def test_recording_failure_restores_original_and_keeps_previous_record(self):
        self.state.mkdir()
        record = self.state / "previous"
        record.write_text("existing record")
        with mock.patch.object(gateway, "run"), mock.patch.object(gateway, "wait_healthy"), \
                mock.patch.object(gateway.os, "replace", wraps=gateway.os.replace) as replace:
            actual_replace = gateway.os.replace._mock_wraps

            def fail_only_record(source, destination):
                if pathlib.Path(destination) == record:
                    raise OSError("simulated state storage failure")
                return actual_replace(source, destination)

            replace.side_effect = fail_only_record
            with self.assertRaises(OSError):
                gateway.activate(self.target)
        self.assertEqual(self.current.resolve(), self.original)
        self.assertFalse(self.dropin.exists())
        self.assertEqual(record.read_text(), "existing record")
        self.assertEqual(list(self.state.iterdir()), [record])

    def test_readonly_check_fails_when_http_smoke_checks_fail(self):
        with mock.patch.object(gateway, "run", return_value=mock.Mock(stdout="active\n")), \
                mock.patch.object(gateway, "health", return_value=False), \
                mock.patch("builtins.print"):
            with self.assertRaises(RuntimeError):
                gateway.readonly_check()

    def test_failed_later_activation_preserves_existing_release_configuration(self):
        previous = self.releases / ("b" * 40)
        previous.mkdir()
        self.current.symlink_to(previous)
        self.dropin.parent.mkdir()
        self.dropin.write_text(gateway.DROPIN_TEXT)
        with mock.patch.object(gateway, "run"), mock.patch.object(
                gateway, "wait_healthy", side_effect=[RuntimeError("test failure"), None]):
            with self.assertRaises(RuntimeError):
                gateway.activate(self.target)
        self.assertEqual(self.current.resolve(), previous)
        self.assertEqual(self.dropin.read_text(), gateway.DROPIN_TEXT)

    def test_existing_unrelated_dropin_is_not_overwritten(self):
        self.dropin.parent.mkdir()
        self.dropin.write_text("unrelated configuration")
        with mock.patch.object(gateway, "run") as run:
            with self.assertRaises(ValueError):
                gateway.activate(self.target)
        run.assert_not_called()
        self.assertFalse(self.current.exists())
        self.assertEqual(self.dropin.read_text(), "unrelated configuration")

    def test_release_paths_cannot_escape_allowed_root(self):
        outside = self.root / "outside"
        outside.mkdir()
        link = self.releases / ("c" * 40)
        link.symlink_to(outside)
        for value in [outside, link, self.releases / ("d" * 40)]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                gateway.secure_path(value)


class BootstrapTests(unittest.TestCase):
    def test_public_key_validation_never_accepts_a_private_key_or_multiple_keys(self):
        wire = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32
        key = "ssh-ed25519 " + base64.b64encode(wire).decode() + " test-deployment"
        self.assertEqual(installer.public_key(key), key)
        for invalid in ["-----BEGIN OPENSSH PRIVATE KEY-----", key + "\n" + key,
                        "ssh-rsa AAAA", "ssh-ed25519 !!!", "ssh-ed25519 eA=="]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                installer.public_key(invalid)


if __name__ == "__main__":
    unittest.main()
