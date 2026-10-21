#!/usr/bin/python3 -I
"""Install or run the narrowly scoped Trigenys Notify Caddy operator.

No remote shell, provider credentials, session changes or message sending.
"""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile

CONFIG = Path('/etc/caddy/Caddyfile')
BACKUPS = Path('/var/backups/trigenys-notify')
CADDY = '/usr/bin/caddy'
HELPER = Path('/usr/local/sbin/trigenys-notify-ops')
WRAPPER = Path('/usr/local/sbin/trigenys-notify-ssh')
SUDOERS = Path('/etc/sudoers.d/trigenys-notify-ops')
ACCOUNT = 'notify-ops'
SITE = 'notify.trigenys.com'
BEGIN = '    # BEGIN trigenys-notify-group-discovery'
END = '    # END trigenys-notify-group-discovery'
ROUTE = '''
    # BEGIN trigenys-notify-group-discovery
    @notify_group_discovery {
        method GET
        path /api/trigenys-test/groups /api/trigenys-test/groups/count
    }
    handle @notify_group_discovery {
        reverse_proxy 127.0.0.1:3000
    }
    # END trigenys-notify-group-discovery
'''


class OpsError(Exception):
    pass


def command(args, code):
    """Capture all output: Caddy configuration errors can contain secrets."""
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise OpsError(code) from error
    if result.returncode:
        raise OpsError(code)
    return result.stdout


def patch_config(original):
    # Refuse unfamiliar layouts rather than replacing a complete Caddyfile.
    headings = list(re.finditer(
        r'(?m)^[ \t]*(?:https://)?notify\.trigenys\.com(?::443)?[ \t]*\{[ \t]*(?:#[^\n]*)?\n',
        original))
    if len(headings) != 1:
        raise OpsError('EXPECTED_ONE_NOTIFY_SITE_HEADING')
    position = headings[0].end()
    if BEGIN in original or END in original:
        if (original.startswith(ROUTE, position) and original.count(ROUTE) == 1
                and original.count(BEGIN) == 1 and original.count(END) == 1
                and len(re.findall(r'(?m)^[ \t]*@notify_group_discovery[ \t]*\{', original)) == 1):
            return original
        raise OpsError('EXISTING_MANAGED_ROUTE_DIFFERS')
    if '@notify_group_discovery' in original:
        raise OpsError('DISCOVERY_MATCHER_ALREADY_EXISTS')
    return original[:position] + ROUTE + original[position:]


def validate(path):
    command([CADDY, 'validate', '--config', str(path), '--adapter', 'caddyfile'],
            'CADDY_VALIDATION_FAILED')


def replace_config(path, content, metadata):
    fd, name = tempfile.mkstemp(prefix='.notify-ops-', dir=path.parent)
    candidate = Path(name)
    try:
        with os.fdopen(fd, 'w') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.chown(candidate, metadata.st_uid, metadata.st_gid)
        candidate.chmod(stat.S_IMODE(metadata.st_mode))
        validate(candidate)
        os.replace(candidate, path)
    finally:
        candidate.unlink(missing_ok=True)


def operate(action, path=CONFIG):
    if action not in ('inspect', 'enable-discovery'):
        raise OpsError('OPERATION_NOT_ALLOWED')
    if path.is_symlink() or not path.is_file():
        raise OpsError('EXPECTED_REGULAR_CADDYFILE')
    command(['/usr/bin/systemctl', 'is-active', '--quiet', 'caddy'], 'CADDY_NOT_ACTIVE')
    original = path.read_text()
    validate(path)
    expected = patch_config(original)
    result = {'site': SITE, 'discovery_enabled': original == expected,
              'config_sha256': hashlib.sha256(original.encode()).hexdigest()}
    if action == 'inspect' or expected == original:
        return result
    metadata = path.stat()
    backups = BACKUPS
    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    if backups.is_symlink() or backups.stat().st_uid != 0:
        raise OpsError('UNSAFE_BACKUP_DIRECTORY')
    backups.chmod(0o700)
    backup = backups / ('Caddyfile-' + result['config_sha256'])
    if not backup.exists():
        with backup.open('x') as file:
            file.write(original)
        backup.chmod(0o600)
    if path.read_text() != original:
        raise OpsError('CADDYFILE_CHANGED_DURING_OPERATION')
    replace_config(path, expected, metadata)
    try:
        command(['/usr/bin/systemctl', 'reload', 'caddy'], 'CADDY_RELOAD_FAILED')
    except OpsError as error:
        replace_config(path, original, metadata)
        try:
            command(['/usr/bin/systemctl', 'reload', 'caddy'], 'ROLLBACK_RELOAD_FAILED')
        except OpsError:
            raise OpsError('CADDY_RELOAD_FAILED_ROLLBACK_RELOAD_FAILED') from error
        raise OpsError('CADDY_RELOAD_FAILED_CONFIG_RESTORED') from error
    return {'site': SITE, 'discovery_enabled': True, 'changed': True,
            'config_sha256': hashlib.sha256(expected.encode()).hexdigest()}


def write_root(path, content, mode):
    if path.is_symlink():
        raise OpsError('UNEXPECTED_SYMLINK')
    path.write_text(content)
    os.chown(path, 0, 0)
    path.chmod(mode)


def install(host):
    ipaddress.ip_address(host)
    owner_name = os.environ.get('SUDO_USER', '')
    if not owner_name or owner_name in ('root', ACCOUNT):
        raise OpsError('INSTALL_USING_SUDO_FROM_YOUR_NORMAL_ACCOUNT')
    owner = pwd.getpwnam(owner_name)
    if not Path(CADDY).is_file() or not CONFIG.is_file():
        raise OpsError('CADDY_INSTALLATION_NOT_FOUND')
    validate(CONFIG)
    try:
        account = pwd.getpwnam(ACCOUNT)
        if not HELPER.exists() or account.pw_dir != '/home/' + ACCOUNT:
            raise OpsError('ACCOUNT_ALREADY_EXISTS_NOT_MANAGED')
    except KeyError:
        command(['/usr/sbin/useradd', '--create-home', '--user-group', '--shell', '/bin/sh', ACCOUNT],
                'ACCOUNT_CREATION_FAILED')
        account = pwd.getpwnam(ACCOUNT)
    if account.pw_uid == 0 or os.getgrouplist(ACCOUNT, account.pw_gid) != [account.pw_gid]:
        raise OpsError('EXPECTED_UNPRIVILEGED_OPS_ACCOUNT')
    key_dir = Path(owner.pw_dir) / '.ssh'
    key_dir.mkdir(mode=0o700, exist_ok=True)
    if key_dir.is_symlink() or key_dir.stat().st_uid not in (0, owner.pw_uid):
        raise OpsError('UNSAFE_KEY_DIRECTORY')
    os.chown(key_dir, owner.pw_uid, owner.pw_gid)
    key_dir.chmod(0o700)
    key = key_dir / 'trigenys_notify_actions'
    public = Path(str(key) + '.pub')
    if key.is_symlink() or public.is_symlink():
        raise OpsError('UNSAFE_KEY_FILE')
    if not key.exists() and not public.exists():
        command(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '',
                 '-C', 'trigenys-notify-actions', '-f', str(key)], 'KEY_CREATION_FAILED')
    if not key.is_file() or not public.is_file():
        raise OpsError('INCOMPLETE_KEY_PAIR')
    generated = command(['/usr/bin/ssh-keygen', '-y', '-P', '', '-f', str(key)], 'KEY_CHECK_FAILED').strip()
    if public.read_text().split()[:2] != generated.split()[:2]:
        raise OpsError('KEY_PAIR_MISMATCH')
    for file, mode in ((key, 0o600), (public, 0o644)):
        os.chown(file, owner.pw_uid, owner.pw_gid)
        file.chmod(mode)
    write_root(HELPER, Path(__file__).read_text(), 0o755)
    write_root(WRAPPER, '''#!/bin/sh
case "$SSH_ORIGINAL_COMMAND" in
  inspect|enable-discovery)
    exec /usr/bin/sudo -n /usr/local/sbin/trigenys-notify-ops "$SSH_ORIGINAL_COMMAND" ;;
  *) echo 'OPERATION_NOT_ALLOWED' >&2; exit 64 ;;
esac
''', 0o755)
    sudoers = ''.join(f'{ACCOUNT} ALL=(root) NOPASSWD: {HELPER} {action}\n'
                      for action in ('inspect', 'enable-discovery'))
    fd, name = tempfile.mkstemp(prefix='notify-sudoers-')
    try:
        with os.fdopen(fd, 'w') as file:
            file.write(sudoers)
        command(['/usr/sbin/visudo', '-cf', name], 'SUDOERS_VALIDATION_FAILED')
        write_root(SUDOERS, sudoers, 0o440)
    finally:
        Path(name).unlink(missing_ok=True)
    home = Path(account.pw_dir)
    os.chown(home, 0, 0)
    home.chmod(0o755)
    auth_dir = home / '.ssh'
    auth_dir.mkdir(exist_ok=True)
    if auth_dir.is_symlink():
        raise OpsError('UNSAFE_AUTHORIZED_KEYS_DIRECTORY')
    os.chown(auth_dir, 0, 0)
    auth_dir.chmod(0o755)
    write_root(auth_dir / 'authorized_keys',
               f'restrict,command="{WRAPPER}" {public.read_text().strip()}\n', 0o644)
    host_public = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
    if host_public[0] != 'ssh-ed25519':
        raise OpsError('EXPECTED_ED25519_HOST_KEY')
    known_hosts = key_dir / 'trigenys_notify_known_hosts'
    if known_hosts.is_symlink():
        raise OpsError('UNSAFE_KNOWN_HOSTS_FILE')
    known_hosts.write_text(f'{host} {host_public[0]} {host_public[1]}\n')
    os.chown(known_hosts, owner.pw_uid, owner.pw_gid)
    known_hosts.chmod(0o644)
    print(json.dumps({'installed': True, 'account': ACCOUNT,
                      'VPS_SSH_PRIVATE_KEY_file': str(key),
                      'VPS_SSH_KNOWN_HOSTS_file': str(known_hosts)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'inspect', 'enable-discovery'])
    parser.add_argument('--host', default='15.235.90.215')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise OpsError('ROOT_REQUIRED')
    os.umask(0o077)
    os.environ['PATH'] = '/usr/sbin:/usr/bin:/sbin:/bin'
    if args.action == 'install':
        install(args.host)
    else:
        with open('/run/lock/trigenys-notify-ops.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            print(json.dumps(operate(args.action)))


if __name__ == '__main__':
    try:
        main()
    except OpsError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('NOTIFY_OPS_FAILED', file=sys.stderr)
        sys.exit(1)
