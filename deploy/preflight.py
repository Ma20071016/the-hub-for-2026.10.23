#!/usr/bin/env python3
"""Verify packaged assets, and optionally exercise CPU inference without DB writes."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def check_assets():
    report = json.loads((ROOT / 'reports/bert_assets.json').read_text(encoding='utf-8'))
    for name in ('config.json', 'model.safetensors'):
        info = report['files'][name]
        path = (ROOT / info['path']).resolve(strict=True)
        if not path.is_relative_to(ROOT) or path.stat().st_size != info['size_bytes']:
            raise RuntimeError(f'Invalid or incomplete model asset: {name}')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != info['sha256']:
            raise RuntimeError(f'Model SHA-256 mismatch: {name}')
    snapshot = (ROOT / report['snapshot_directory']).resolve(strict=True)
    if not snapshot.is_relative_to(ROOT):
        raise RuntimeError('Model snapshot is outside the release.')
    for name in ('config.json', 'model.safetensors'):
        if (snapshot / name).resolve(strict=True) != (ROOT / report['files'][name]['path']).resolve(strict=True):
            raise RuntimeError(f'Snapshot and model manifest disagree: {name}')
    required = [
        'runs/ocnli_50k_20261007_01/best.pt',
        'data/processed/bert-base-chinese-tokenizer/tokenizer.json',
        'data/processed/bert-base-chinese-tokenizer/tokenizer_config.json',
        'data/processed/bert-base-chinese-tokenizer/special_tokens_map.json',
        'data/processed/bert-base-chinese-tokenizer/vocab.txt',
        'data/library_visuals.json', 'frontend/login.html',
        'frontend/downloads/robe-review-practice.docx',
    ]
    for name in required:
        path = ROOT / name
        if not path.is_file() or not path.stat().st_size:
            raise RuntimeError(f'Missing/empty required file: {name}')
    database = ROOT / 'data/costume.db'
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('Evidence database integrity check failed.')
        sources = connection.execute('SELECT COUNT(*) FROM sources').fetchone()[0]
        approved = connection.execute("SELECT COUNT(*) FROM evidence_chunks WHERE review_status='approved'").fetchone()[0]
    if not sources or not approved:
        raise RuntimeError('Evidence database has no usable evidence.')
    return {'sources': sources, 'approved_evidence': approved, 'bert_sha256': 'verified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    options = parser.add_mutually_exclusive_group()
    options.add_argument('--assets-only', action='store_true')
    options.add_argument('--model', action='store_true')
    args = parser.parse_args()
    result = check_assets()
    if args.model:
        from backend.inference import Verifier
        from backend.document_upload import extract_document
        started = time.monotonic()
        verifier = Verifier()
        loaded = time.monotonic()
        prediction = verifier.predict('这件棉袍采用对襟设计。', '这件棉袍衣身宽大，对襟，两侧缝开短衩。')
        result.update(device=str(verifier.device), load_seconds=round(loaded-started, 2),
                      prediction_seconds=round(time.monotonic()-loaded, 2), label=prediction['label'])
        document = (ROOT / 'frontend/downloads/robe-review-practice.docx').read_bytes()
        extract_document(document, 'docx')
        result['docx_extraction'] = 'passed'
        result['versions'] = {name: importlib.metadata.version(name) for name in
                              ('torch', 'transformers', 'tokenizers', 'safetensors', 'pypdf', 'python-docx')}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
