#!/usr/bin/env python3
"""One-time, additive setup. Never reads .env or restarts/deploys the application."""
import argparse
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import urllib.error
import urllib.request

SERVICE = "interpain-b24forms.service"
ROOT_UID = 0
ROOT_GID = 0
ORIGINAL = pathlib.Path("/opt/interpain_b24forms")
CURRENT = pathlib.Path("/opt/interpain_b24forms-current")
PRIVATE = pathlib.Path("/var/lib/interpain-spravka-bitrix")
CONFIG = pathlib.Path("/etc/interpain-spravka-bitrix.env")
DROPIN = pathlib.Path("/etc/systemd/system/interpain-b24forms.service.d/40-spravka-bitrix.conf")
CLIENT_ID = "local.6adf779fe777b5.30461534"
CONFIG_TEXT = (
    "# Bitrix24 application 445; report login deliberately disabled.\n"
    f"SPRAVKA_B24_CLIENT_ID={CLIENT_ID}\n"
    "SPRAVKA_B24_ENABLED=0\n"
    f"SPRAVKA_B24_STATE_DIR={PRIVATE}\n"
)
DROPIN_TEXT = f"[Service]\nEnvironmentFile={CONFIG}\n"


class SetupError(Exception):
    pass


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise SetupError("Служебная команда не выполнена; значения конфигурации не выводятся.")
    return result.stdout.strip()


def prop(name):
    return run(["/usr/bin/systemctl", "show", SERVICE, "-p", name, "--value"])


def exists(path):
    # A dangling symlink must not be mistaken for an absent file.
    return os.path.lexists(path)


def safe_directory(path, uid=None, exact_mode=None):
    uid = ROOT_UID if uid is None else uid
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
        raise SetupError("Неожиданный тип или владелец каталога; ничего не заменено.")
    mode = stat.S_IMODE(info.st_mode)
    if (exact_mode is not None and mode != exact_mode) or (
        exact_mode is None and mode & 0o022
    ):
        raise SetupError("Неожиданные права каталога; ничего не заменено.")


def safe_ancestors(path):
    for parent in reversed(path.parents):
        safe_directory(parent)


def check_existing_file(path, text, mode):
    if not exists(path):
        return
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != ROOT_UID
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != mode
        or info.st_size != len(text.encode("utf-8"))
        or path.read_bytes() != text.encode("utf-8")
    ):
        raise SetupError("Файл настройки уже существует и отличается; перезапись запрещена.")


def environment_files():
    # systemctl prints multiple entries on separate lines on Ubuntu 24.04.
    # Normalize separators only; still reject any unrecognized entry or suffix.
    value = " ".join(prop("EnvironmentFiles").split())
    matches = re.findall(r"(/[^\s]+) \(ignore_errors=(?:yes|no)\)", value)
    if " ".join(re.findall(r"/[^\s]+ \(ignore_errors=(?:yes|no)\)", value)) != value:
        raise SetupError("Неожиданный формат EnvironmentFiles.")
    return matches


def smoke():
    for route, wanted in (("/health", 200), ("/spravka", 200), ("/api/spravka", 401)):
        try:
            with urllib.request.urlopen("http://127.0.0.1:3001" + route, timeout=5) as response:
                code = response.status
                body = response.read(4096) if route == "/health" else b""
        except urllib.error.HTTPError as error:
            code, body = error.code, b""
            error.close()
        if code != wanted:
            raise SetupError("Проверка работающего сайта не прошла; выпуск не выполнялся.")
        if route == "/health" and json.loads(body).get("ok") is not True:
            raise SetupError("Проверка здоровья приложения не прошла.")


def preflight():
    if os.geteuid() != 0:
        raise SetupError("Этот одноразовый установщик запускается на сервере от root.")
    account = pwd.getpwnam("www-data")
    if prop("User") != "www-data" or prop("ActiveState") != "active":
        raise SetupError("Служба неактивна или работает от неожиданного пользователя.")
    if prop("WorkingDirectory") not in {str(ORIGINAL), str(CURRENT)}:
        raise SetupError("Неожиданный рабочий каталог службы.")
    old = str(ORIGINAL / ".env")
    env_files = environment_files()
    if env_files not in ([old], [old, str(CONFIG)]):
        raise SetupError("Есть другие файлы окружения; автоматическая настройка остановлена.")
    if not (ORIGINAL / ".env").is_file() or (ORIGINAL / ".env").is_symlink():
        raise SetupError("Неожиданное расположение прежнего .env; файл не прочитан.")
    pid = prop("MainPID")
    if not pid.isdecimal() or int(pid) <= 0:
        raise SetupError("Не удалось подтвердить PID работающего приложения.")
    safe_ancestors(PRIVATE)
    safe_ancestors(CONFIG)
    safe_ancestors(DROPIN.parent)
    if exists(DROPIN.parent):
        safe_directory(DROPIN.parent)
    if exists(PRIVATE):
        safe_directory(PRIVATE, uid=account.pw_uid, exact_mode=0o700)
    check_existing_file(CONFIG, CONFIG_TEXT, 0o600)
    check_existing_file(DROPIN, DROPIN_TEXT, 0o644)
    smoke()
    return account, pid, env_files


def create_file(path, text, mode, created):
    if exists(path):
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    created.append(("file", path))
    with os.fdopen(fd, "wb") as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), ROOT_UID, ROOT_GID)
        output.write(text.encode("utf-8"))
        output.flush()
        os.fsync(output.fileno())


def setup(apply=False):
    account, pid, env_files = preflight()
    if not apply:
        print("CHECK_OK: условия проверены; изменений нет.")
        return
    created = []
    reload_started = False
    try:
        if not exists(PRIVATE):
            PRIVATE.mkdir(mode=0o700)
            created.append(("directory", PRIVATE))
            os.chown(PRIVATE, account.pw_uid, account.pw_gid)
            PRIVATE.chmod(0o700)
        if not exists(DROPIN.parent):
            DROPIN.parent.mkdir(mode=0o755)
            created.append(("directory", DROPIN.parent))
            DROPIN.parent.chmod(0o755)
        create_file(CONFIG, CONFIG_TEXT, 0o600, created)
        create_file(DROPIN, DROPIN_TEXT, 0o644, created)
        if created or str(CONFIG) not in env_files:
            reload_started = True
            run(["/usr/bin/systemctl", "daemon-reload"])
        if environment_files() != [str(ORIGINAL / ".env"), str(CONFIG)]:
            raise SetupError("systemd не подтвердил порядок файлов окружения.")
        safe_directory(PRIVATE, uid=account.pw_uid, exact_mode=0o700)
        check_existing_file(CONFIG, CONFIG_TEXT, 0o600)
        check_existing_file(DROPIN, DROPIN_TEXT, 0o644)
        if prop("MainPID") != pid or prop("ActiveState") != "active":
            raise SetupError("Состояние приложения изменилось во время проверки.")
        smoke()
    except Exception:
        cleanup_failed = False
        for kind, path in reversed(created):
            try:
                path.unlink() if kind == "file" else path.rmdir()
            except OSError:
                cleanup_failed = True
        if reload_started:
            try:
                run(["/usr/bin/systemctl", "daemon-reload"])
            except Exception:
                cleanup_failed = True
        if cleanup_failed:
            raise SetupError("Настройка не завершена; откат новых файлов требует проверки.")
        raise SetupError("Настройка не завершена; новые файлы удалены. Приложение не перезапускалось.")
    print("SPRAVKA_SERVER_PREPARED_OK")
    print("APP_NOT_RESTARTED: PID не изменился.")
    print("BITRIX_REPORT_LOGIN: выключен, SPRAVKA_B24_ENABLED=0.")
    print("LEGACY_ENV: не читался и не изменялся.")
    print("Новая конфигурация вступит в силу только после отдельного перезапуска.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        setup(apply=args.apply)
    except Exception as error:
        message = str(error) if isinstance(error, SetupError) else "Проверка остановлена; секреты не выводятся."
        print("SETUP_FAILED: " + message)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
