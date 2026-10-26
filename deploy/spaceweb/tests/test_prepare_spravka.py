import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).resolve().parents[1] / "prepare_spravka.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.original = self.root / "app"
        self.original.mkdir()
        self.legacy = self.original / ".env"
        self.legacy.write_bytes(b"SECRET=do-not-read-or-change\r\n")
        self.private = self.root / "state"
        self.config = self.root / "config.env"
        self.dropin = self.root / "service.d" / "40-spravka-bitrix.conf"
        self.old = str(self.legacy)
        self.envs = [self.old]
        self.pid = "123"
        self.calls = []
        for name, value in {
            "ROOT_UID": os.getuid(),
            "ROOT_GID": os.getgid(),
            "ORIGINAL": self.original,
            "CURRENT": self.root / "current",
            "PRIVATE": self.private,
            "CONFIG": self.config,
            "DROPIN": self.dropin,
            "CONFIG_TEXT": f"SPRAVKA_B24_ENABLED=0\nSPRAVKA_B24_STATE_DIR={self.private}\n",
            "DROPIN_TEXT": f"[Service]\nEnvironmentFile={self.config}\n",
        }.items():
            self.enterContext(patch.object(m, name, value))
        # Temporary directories are legitimately under /tmp; production rejects it.
        self.enterContext(patch.object(m, "safe_ancestors"))
        self.enterContext(patch.object(m.os, "geteuid", return_value=0))
        self.enterContext(patch.object(m.pwd, "getpwnam", return_value=types.SimpleNamespace(
            pw_uid=os.getuid(), pw_gid=os.getgid()
        )))
        self.enterContext(patch.object(m, "prop", side_effect=self.prop))
        self.enterContext(patch.object(m, "run", side_effect=self.run_command))
        self.smoke = self.enterContext(patch.object(m, "smoke"))

    def prop(self, name):
        return {
            "User": "www-data", "ActiveState": "active", "MainPID": self.pid,
            "WorkingDirectory": str(self.original),
            "EnvironmentFiles": " ".join(f"{p} (ignore_errors=no)" for p in self.envs),
        }[name]

    def run_command(self, args):
        self.calls.append(args)
        self.assertEqual(args, ["/usr/bin/systemctl", "daemon-reload"])
        self.envs = [self.old, str(self.config)] if self.dropin.exists() else [self.old]
        return ""

    def test_dry_run_writes_nothing(self):
        m.setup()
        self.assertFalse(self.config.exists())
        self.assertFalse(self.private.exists())
        self.assertEqual(self.calls, [])

    def test_setup_additive_disabled_no_restart(self):
        before = self.legacy.read_bytes()
        m.setup(apply=True)
        self.assertEqual(self.legacy.read_bytes(), before)
        self.assertIn("SPRAVKA_B24_ENABLED=0", self.config.read_text())
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o700)
        self.assertEqual(self.calls, [["/usr/bin/systemctl", "daemon-reload"]])

    def test_idempotent_without_rewrite_or_reload(self):
        m.setup(apply=True)
        before = self.config.stat().st_mtime_ns
        self.calls.clear()
        m.setup(apply=True)
        self.assertEqual(self.config.stat().st_mtime_ns, before)
        self.assertEqual(self.calls, [])

    def test_foreign_config_fails_before_any_creation(self):
        self.config.write_text("SPRAVKA_B24_ENABLED=1\n")
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.private.exists())
        self.assertIn("=1", self.config.read_text())

    def test_dangling_symlink_rejected(self):
        self.config.symlink_to(self.root / "missing")
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.private.exists())

    def test_state_symlink_rejected(self):
        target = self.root / "other"
        target.mkdir()
        self.private.symlink_to(target)
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.config.exists())

    def test_open_state_directory_rejected(self):
        self.private.mkdir(mode=0o755)
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.config.exists())

    def test_unknown_environment_files_rejected(self):
        self.envs.append("/other.env")
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.config.exists())

    def test_failure_cleans_only_created_paths(self):
        self.smoke.side_effect = [None, RuntimeError("failure")]
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.config.exists())
        self.assertFalse(self.dropin.exists())
        self.assertFalse(self.private.exists())
        self.assertEqual(self.legacy.read_bytes(), b"SECRET=do-not-read-or-change\r\n")
        self.assertEqual(len(self.calls), 2)

    def test_existing_private_state_is_preserved_on_failure(self):
        self.private.mkdir(mode=0o700)
        marker = self.private / "installation.json"
        marker.write_text("do-not-read-or-delete")
        self.smoke.side_effect = [None, RuntimeError("failure")]
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertEqual(marker.read_text(), "do-not-read-or-delete")

    def test_pid_change_rolls_back_without_restart(self):
        original_run = self.run_command
        def changing_run(args):
            result = original_run(args)
            self.pid = "124"
            return result
        with patch.object(m, "run", side_effect=changing_run):
            with self.assertRaises(m.SetupError):
                m.setup(apply=True)
        self.assertFalse(self.config.exists())
        self.assertTrue(all(c[-1] == "daemon-reload" for c in self.calls))

    def test_old_env_never_read_by_setup(self):
        original_read = Path.read_bytes
        def guarded_read(path):
            if path == self.legacy:
                self.fail("Legacy .env was read")
            return original_read(path)
        with patch.object(Path, "read_bytes", guarded_read):
            m.setup(apply=True)

    def test_non_root_refused(self):
        with patch.object(m.os, "geteuid", return_value=1000):
            with self.assertRaises(m.SetupError):
                m.setup(apply=True)
        self.assertFalse(self.config.exists())

    def test_dropin_symlink_rejected(self):
        self.dropin.parent.mkdir()
        self.dropin.symlink_to(self.root / "missing-unit")
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.private.exists())

    def test_matching_config_with_open_mode_refused(self):
        self.config.write_text(m.CONFIG_TEXT)
        self.config.chmod(0o644)
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.private.exists())

    def test_hardlinked_config_refused(self):
        self.config.write_text(m.CONFIG_TEXT)
        self.config.chmod(0o600)
        os.link(self.config, self.root / "second-link")
        with self.assertRaises(m.SetupError):
            m.setup(apply=True)
        self.assertFalse(self.private.exists())

    def test_reload_failure_cleans_files_and_reloads_previous_config(self):
        with patch.object(m, "run", side_effect=[RuntimeError("reload failed"), ""]) as called:
            with self.assertRaises(m.SetupError):
                m.setup(apply=True)
        self.assertEqual(called.call_count, 2)
        self.assertFalse(self.config.exists())
        self.assertFalse(self.dropin.exists())


if __name__ == "__main__":
    unittest.main()
