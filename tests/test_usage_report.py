"""Usage report checks with synthetic logs/databases; no production access."""
from contextlib import closing, redirect_stdout
from datetime import datetime, timedelta
import gzip
import hashlib
import io
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from deploy import usage_report as report


class UsageReportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='costume-usage-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.start = datetime(2026, 10, 18, tzinfo=report.CHINA)
        self.end = self.start + timedelta(hours=23)

    def line(self, offset, target, status=200, method='GET', ip='203.0.113.8', agent=None):
        stamp = (self.start + timedelta(seconds=offset)).strftime('%d/%b/%Y:%H:%M:%S %z')
        agent = agent or 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36'
        return (f'{ip} - - [{stamp}] "{method} {target} HTTP/1.1" {status} 123 '
                f'"https://example.test/source.html?secret=PRIVATE_REFERRER" "{agent}"\n')

    def write_log(self, lines, name='costume-access.log'):
        path = self.root / name
        if name.endswith('.gz'):
            with gzip.open(path, 'wt', encoding='utf-8') as stream:
                stream.write(''.join(lines))
        else:
            path.write_text(''.join(lines), encoding='utf-8')

    def test_newest_details_across_rotations_keep_failures_skip_background(self):
        self.write_log([
            self.line(0, '/api/auth/login?secret=PRIVATE_QUERY', 401, 'POST'),
            self.line(120, '/style.css'),
            self.line(180, '/api/review', method='POST'),
            self.line(240, '/guide.html', ip='127.0.0.1'),
            self.line(-1, '/login.html'),
            self.line(300, '/api/library/2', ip='2001:db8::1'),
            'malformed log line\n',
        ])
        self.write_log([self.line(60, '/api/auth/login', method='POST')], 'costume-access.log.1')
        self.write_log([self.line(420, '/guide.html', 304)], 'costume-access.log.2.gz')
        stats = report.read_logs(self.root, self.start, self.end, set(), details=3)
        events = sorted(stats['events'])
        self.assertEqual(stats['files'], 3)
        self.assertEqual(stats['requests'], 6)
        self.assertEqual(stats['malformed'], 1)
        self.assertEqual(stats['detail_matches'], 5)
        self.assertEqual([item[2]['path'] for item in events], ['/api/review', '/api/library/2', '/guide.html'])
        self.assertIn('须查已保存档案', events[0][2]['result'])
        self.assertIn('缓存', events[-1][2]['result'])
        self.assertIn('模型正忙', report.request_result('POST', '/api/review', 429))
        self.assertEqual(events[0][2]['client'], 'Chrome / Windows')
        self.assertEqual(events[0][2]['source'], 'example.test')
        all_events = report.read_logs(self.root, self.start, self.end, set(), details=30)['events']
        self.assertTrue(any('401' in event[2]['result'] for event in all_events))

    def test_ip_normalization_and_exclusions(self):
        self.write_log([self.line(10, '/library.html', ip='2001:0db8:0:0:0:0:0:1'),
                        self.line(20, '/library.html', ip='203.0.113.9')])
        stats = report.read_logs(self.root, self.start, self.end, set(), details=10, only_ip='2001:db8::1')
        self.assertEqual(stats['requests'], 1)
        self.assertEqual(stats['events'][0][2]['ip'], '2001:db8::1')
        excluded = report.read_logs(self.root, self.start, self.end, {'2001:db8::1'})
        self.assertEqual(excluded['requests'], 1)
        self.assertEqual(excluded['ip'], {'203.0.113.9'})

    def test_details_redact_queries_record_ids_and_terminal_controls(self):
        review_id = 'a' * 32
        self.write_log([
            self.line(1, f'/api/reviews/{review_id}/report?token=PRIVATE_QUERY'),
            self.line(2, '/unknown\x1b[31m?secret=PRIVATE_QUERY'),
            self.line(3, '/api/auth/session'),
        ])
        stats = report.read_logs(self.root, self.start, self.end, set(), details=10, all_requests=True)
        output = io.StringIO()
        with redirect_stdout(output):
            report.print_details(stats, self.start, self.end, None, True)
        text = output.getvalue()
        for private in ('PRIVATE_QUERY', 'PRIVATE_REFERRER', review_id, '\x1b'):
            self.assertNotIn(private, text)
        self.assertIn('记录编号已隐藏', text)
        self.assertIn('通常自动触发', text)
        self.assertIn('不代表已保存', text)
        self.assertEqual(report.referrer_host('https://name:password@example.test/path?secret=x'), 'example.test')
        self.assertEqual(report.referrer_host('-'), '未提供或无法识别')
        self.assertLessEqual(len(report.display_path('/' + 'x' * 1000)), 120)

    def test_database_calendar_boundaries_and_readonly(self):
        accounts = self.root / 'accounts.db'
        reviews = self.root / 'review_history.db'
        with closing(sqlite3.connect(accounts)) as connection:
            connection.execute('CREATE TABLE users(id TEXT, username TEXT, created_at INTEGER, password_hash TEXT)')
            connection.executemany('INSERT INTO users VALUES(?,?,?,?)', [
                ('u1', 'TestUser', int(self.start.timestamp()), 'DO_NOT_PRINT_PASSWORD_HASH'),
                ('u2', 'OlderUser', int(self.start.timestamp()) - 1, 'DO_NOT_PRINT_PASSWORD_HASH'),
            ])
            connection.commit()
        with closing(sqlite3.connect(reviews)) as connection:
            connection.execute('CREATE TABLE review_runs(owner_id TEXT, created_at TEXT, snapshot_json TEXT)')
            connection.executemany('INSERT INTO review_runs VALUES(?,?,?)', [
                ('u1', '2026-10-17T16:00:00.000000Z', 'DO_NOT_PRINT_DOCUMENT'),
                ('u1', '2026-10-17T15:59:59.000000Z', 'DO_NOT_PRINT_DOCUMENT'),
                (None, '2026-10-18T01:00:00.000000Z', 'DO_NOT_PRINT_DOCUMENT'),
            ])
            connection.commit()
        hashes = {path: hashlib.sha256(path.read_bytes()).digest() for path in (accounts, reviews)}
        data = report.read_databases(self.root, self.start, self.end)
        self.assertEqual(data['warnings'], [])
        self.assertEqual(sum(row['selected'] for row in data['reviews']), 2)
        self.assertEqual(sum(row['total'] for row in data['reviews']), 3)
        self.write_log([self.line(10, '/api/review', method='POST')])
        logs = report.read_logs(self.root, self.start, self.end, set())
        output = io.StringIO()
        with redirect_stdout(output):
            report.print_report(logs, data, self.start, self.end, True, '203.0.113.8')
        text = output.getvalue()
        self.assertIn('当前账号总数：2；所选时间内注册：1', text)
        self.assertIn('已保存审阅总数：3；所选时间内：2', text)
        self.assertIn('本期 1 / 总计 2', text)
        self.assertIn('仍为全站', text)
        self.assertNotIn('DO_NOT_PRINT', text)
        with closing(report.connect_readonly(accounts)) as connection:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute('DELETE FROM users')
        self.assertEqual(hashes, {path: hashlib.sha256(path.read_bytes()).digest() for path in hashes})

    def test_missing_data_is_unknown_and_never_creates_database(self):
        data = report.read_databases(self.root, self.start, self.end)
        logs = report.read_logs(self.root, self.start, self.end, set(), details=10)
        self.assertIsNone(data['users'])
        self.assertIsNone(data['reviews'])
        self.assertEqual(len(data['warnings']), 2)
        self.assertEqual(len(logs['warnings']), 1)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cli_detail_mode_does_not_need_databases_and_validates_arguments(self):
        self.start = datetime.now(report.CHINA) - timedelta(seconds=2)
        self.write_log([self.line(0, '/api/auth/login', method='POST')])
        script = str(Path(report.__file__).resolve())
        command = [sys.executable, script, '--log-dir', str(self.root), '--data-dir', str(self.root)]
        result = subprocess.run(command + ['--details', '10'], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('登录账号', result.stdout)
        self.assertNotIn('账号库读取失败', result.stdout)
        for arguments in (['--details', '0'], ['--details', '501'], ['--ip', 'no-ip'],
                          ['--details', '1', '--users'], ['--all-requests']):
            result = subprocess.run(command + arguments, capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 2, arguments)


if __name__ == '__main__':
    unittest.main()
