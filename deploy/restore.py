#!/usr/bin/env python3
"""Restore a checked three-database snapshot after stopping costume-verifier."""
from __future__ import annotations

import json
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess
import sys
import tempfile

NAMES = ('costume.db', 'accounts.db', 'review_history.db')
REQUIRED_TABLES = {
    'costume.db': {'sources', 'evidence_chunks'},
    'accounts.db': {'users', 'sessions'},
    'review_history.db': {'review_runs'},
}


def restore(snapshot: Path, data: Path, uid: int, gid: int):
    snapshot, data = snapshot.resolve(strict=True), data.resolve(strict=True)
    if snapshot == data or snapshot.is_relative_to(data):
        raise ValueError('Snapshot must be separate from live application data.')
    marker = json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))
    if marker.get('tool') != 'costume-verifier-backup-v1' or marker.get('databases') != list(NAMES):
        raise ValueError('Not a complete costume-verifier backup.')
    # Prepare and validate ALL replacement files before touching a live file.
    with tempfile.TemporaryDirectory(prefix='.restore-', dir=data) as temp:
        prepared = Path(temp)
        for name in NAMES:
            source = snapshot / name
            if source.is_symlink() or not source.is_file():
                raise ValueError(f'Missing/linked backup database: {name}')
            reader = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
            writer = sqlite3.connect(prepared / name)
            try:
                reader.backup(writer)
                if writer.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError(f'Corrupt database: {name}')
                tables = {row[0] for row in writer.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not REQUIRED_TABLES[name].issubset(tables):
                    raise ValueError(f'Wrong database schema: {name}')
            finally:
                reader.close()
                writer.close()
            (prepared / name).chmod(0o600)
            os.chown(prepared / name, uid, gid)
        for name in NAMES:
            target = data / name
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise ValueError(f'Refusing linked or non-file live database: {name}')
            for suffix in ('-wal', '-shm', '-journal'):
                sidecar = data / (name + suffix)
                if sidecar.is_symlink() or (sidecar.exists() and not sidecar.is_file()):
                    raise ValueError(f'Refusing linked or non-file SQLite sidecar: {sidecar.name}')
        # Service is stopped. Replace each database atomically, then clear stale
        # sidecars from the old stopped database; never replay them on the copy.
        for name in NAMES:
            os.replace(prepared / name, data / name)
            for suffix in ('-wal', '-shm', '-journal'):
                (data / (name + suffix)).unlink(missing_ok=True)
    print('Restored all three databases. Start costume-verifier and check the site.')


def main():
    if len(sys.argv) != 2 or os.geteuid() != 0:
        raise SystemExit('Usage: sudo python deploy/restore.py /absolute/path/to/backup')
    state = subprocess.run(['systemctl', 'show', 'costume-verifier.service', '--property=ActiveState', '--value'],
                           check=True, capture_output=True, text=True).stdout.strip()
    if state not in ('inactive', 'failed'):
        raise SystemExit('Stop costume-verifier before restoring databases.')
    account = pwd.getpwnam('costume')
    restore(Path(sys.argv[1]), Path('/opt/costume-verifier/data'), account.pw_uid, account.pw_gid)


if __name__ == '__main__':
    main()
