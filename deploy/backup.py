#!/usr/bin/env python3
"""Back up the three SQLite databases; keep the latest 14 daily snapshots.

SQLite backup API produces a consistent snapshot of each database while online.
For restoration/migration requiring an exact shared point, stop the application
before running this script. Retention only affects this tool's own directories.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OWN_NAME = re.compile(r'backup-\d{8}T\d{12}Z\Z')
DB_NAMES = ('costume.db', 'accounts.db', 'review_history.db')


def backup(data_dir: Path, output: Path, keep: int):
    data_dir, output = data_dir.resolve(strict=True), output.resolve()
    if output == data_dir or output.is_relative_to(data_dir):
        raise ValueError('Backup output must be outside the application data directory.')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.chmod(0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    final = output / ('backup-' + stamp)
    with tempfile.TemporaryDirectory(prefix='.pending-', dir=output) as staging_name:
        staging = Path(staging_name)
        for name in DB_NAMES:
            source = data_dir / name
            if not source.is_file():
                raise FileNotFoundError(f'Missing database; incomplete backup refused: {source}')
            destination = staging / name
            reader = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30)
            writer = sqlite3.connect(destination)
            try:
                reader.backup(writer)
                if writer.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError(f'Backup integrity check failed: {name}')
            finally:
                reader.close()
                writer.close()
            destination.chmod(0o600)
        (staging / 'manifest.json').write_text(json.dumps({
            'tool': 'costume-verifier-backup-v1', 'created_at_utc': stamp,
            'databases': list(DB_NAMES), 'consistency': 'per-database SQLite online snapshot',
        }, indent=2) + '\n', encoding='utf-8')
        staging.rename(final)
    owned = []
    for path in output.iterdir():
        if not path.is_dir() or path.is_symlink() or not OWN_NAME.fullmatch(path.name):
            continue
        try:
            marker = json.loads((path / 'manifest.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if marker.get('tool') == 'costume-verifier-backup-v1':
            owned.append(path)
    for path in sorted(owned, reverse=True)[keep:]:
        # Both absolute containment and ownership were checked before removal.
        if path.resolve().parent != output:
            raise RuntimeError('Unexpected backup retention target.')
        shutil.rmtree(path)
    print(f'Database backup complete: {final}', flush=True)
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data')
    parser.add_argument('--output', type=Path, default=Path('/var/backups/costume-verifier'))
    parser.add_argument('--keep', type=int, default=14)
    args = parser.parse_args()
    if args.keep < 1:
        parser.error('--keep must be at least 1')
    os.umask(0o077)
    backup(args.data_dir, args.output, args.keep)


if __name__ == '__main__':
    main()
