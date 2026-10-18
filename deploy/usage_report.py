#!/usr/bin/env python3
"""Read-only usage summary. Run on the SERVER, not the developer database.

No dependencies beyond Python 3.10+. No credentials, session tokens, document
text or raw request query strings are printed. No new tracking is installed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, time, timedelta, timezone
import gzip
import ipaddress
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import urlsplit

CHINA = timezone(timedelta(hours=8))
LOG_LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "((?:\\.|[^"\\])*)" (\d{3}) (?:\d+|-)')
ROTATION = re.compile(r'costume-access\.log(?:\.\d+(?:\.gz)?)?\Z')
PAGES = {'/': '工作台首页', '/index.html': '工作台', '/login.html': '登录页',
         '/library.html': '资料馆', '/source.html': '资料详情',
         '/archive.html': '审阅档案页', '/guide.html': '使用指南'}


def action_for(method, path, status):
    if method == 'POST':
        exact = {
            ('/api/auth/register', 201): '注册成功',
            ('/api/auth/login', 200): '登录成功',
            ('/api/auth/logout', 200): '退出登录成功',
            ('/api/extract', 200): '文稿提取成功',
            ('/api/review', 200): '审阅请求返回200（不等于完成）',
            ('/api/verify', 200): '单句核验请求返回200（不等于运行模型）',
            ('/api/search', 200): '资料检索请求返回200',
        }
        if (path, status) in exact:
            return exact[path, status]
        if status == 200 and re.fullmatch(r'/api/reviews/[0-9a-f]{32}/decisions', path):
            return '保存人工意见成功'
    elif method == 'GET' and status == 200 and re.fullmatch(r'/api/reviews/[0-9a-f]{32}/report', path):
        return '报告请求成功（不代表用户已保存文件）'
    return None


def read_logs(log_dir, start, end, exclude):
    stats = {'requests': 0, 'page_requests': 0, 'ip': set(), 'page_ip': set(),
             'pages': Counter(), 'actions': Counter(), 'statuses': Counter(),
             'daily': defaultdict(lambda: {'requests': 0, 'ip': set(), 'pages': 0}),
             'files': 0, 'malformed': 0, 'first': None, 'last': None, 'warnings': []}
    files = sorted(path for path in log_dir.glob('costume-access.log*') if ROTATION.fullmatch(path.name))
    if not files:
        stats['warnings'].append('没有找到 Nginx 日志；访问量未知，不能解释为0人。')
    for path in files:
        opener = gzip.open if path.suffix == '.gz' else open
        try:
            with opener(path, 'rt', encoding='utf-8', errors='replace') as stream:
                stats['files'] += 1
                for line in stream:
                    match = LOG_LINE.match(line)
                    if not match:
                        stats['malformed'] += 1
                        continue
                    peer, raw_time, request, raw_status = match.groups()
                    try:
                        stamp = datetime.strptime(raw_time, '%d/%b/%Y:%H:%M:%S %z')
                        address = ipaddress.ip_address(peer)
                        fields = request.split()
                        if len(fields) != 3 or not fields[2].startswith('HTTP/'):
                            raise ValueError('Invalid request line')
                        method, target, _ = fields
                        route = urlsplit(target).path
                    except ValueError:
                        stats['malformed'] += 1
                        continue
                    if address.is_loopback or peer in exclude or not start <= stamp <= end:
                        continue
                    status = int(raw_status)
                    day = stamp.astimezone(CHINA).date().isoformat()
                    stats['requests'] += 1
                    stats['ip'].add(peer)
                    stats['statuses'][f'{status // 100}xx'] += 1
                    stats['daily'][day]['requests'] += 1
                    stats['daily'][day]['ip'].add(peer)
                    stats['first'] = min(stats['first'] or stamp, stamp)
                    stats['last'] = max(stats['last'] or stamp, stamp)
                    if method == 'GET' and 200 <= status < 300 and route in PAGES:
                        stats['page_requests'] += 1
                        stats['page_ip'].add(peer)
                        stats['pages'][PAGES[route]] += 1
                        stats['daily'][day]['pages'] += 1
                    action = action_for(method, route, status)
                    if action:
                        stats['actions'][action] += 1
        except (OSError, EOFError) as exc:
            stats['warnings'].append(f'日志未完整读取 {path.name}: {exc}')
    return stats


def connect_readonly(path):
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    return connection


def read_databases(data_dir, start, end):
    result = {'users': None, 'reviews': None, 'warnings': []}
    try:
        with closing(connect_readonly(data_dir / 'accounts.db')) as connection:
            result['users'] = [dict(row) for row in connection.execute('SELECT id, username, created_at FROM users')]
    except sqlite3.Error as exc:
        result['warnings'].append(f'账号库读取失败，人数未知：{exc}')
    try:
        with closing(connect_readonly(data_dir / 'review_history.db')) as connection:
            result['reviews'] = [dict(row) for row in connection.execute('''
                SELECT owner_id, COUNT(*) AS total,
                  SUM(CASE WHEN julianday(created_at) >= julianday(?)
                            AND julianday(created_at) <= julianday(?) THEN 1 ELSE 0 END) AS selected,
                  MAX(created_at) AS latest
                FROM review_runs GROUP BY owner_id
            ''', (start.isoformat(), end.isoformat()))]
    except sqlite3.Error as exc:
        result['warnings'].append(f'档案库读取失败，已保存审阅数未知：{exc}')
    return result


def local_time(value):
    if value is None:
        return '无'
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    elif isinstance(value, (int, float)):
        value = datetime.fromtimestamp(value, tz=timezone.utc)
    return value.astimezone(CHINA).strftime('%Y-%m-%d %H:%M:%S')


def print_report(logs, database, start, end, show_users):
    print(f'网站使用统计 | 北京时间 {local_time(start)} 至 {local_time(end)}')
    print('只读取已有日志和数据库；不会停止服务或修改账号。\n')
    print('【访问：限仍保留的日志】')
    if logs['files']:
        print(f"读取日志文件：{logs['files']}；无法解析的行：{logs['malformed']}")
        print(f"请求总数：{logs['requests']}（含接口、静态资源、扫描与失败请求）")
        print(f"请求来源独立IP：{len(logs['ip'])}；成功打开网页的独立IP：{len(logs['page_ip'])}")
        print(f"成功网页请求：{logs['page_requests']}（不含CSS/JS/图片/API，不等于人数）")
        print(f"范围内最早/最晚请求：{local_time(logs['first'])} / {local_time(logs['last'])}")
        print('状态：' + '，'.join(f'{key}={count}' for key, count in sorted(logs['statuses'].items())))
        print('\n日期          请求数    独立IP    网页请求')
        day = start.date()
        while day <= end.astimezone(CHINA).date():
            item = logs['daily'][day.isoformat()]
            print(f"{day}  {item['requests']:8}  {len(item['ip']):8}  {item['pages']:8}")
            day += timedelta(days=1)
        print('\n【成功打开的页面】')
        for name, count in logs['pages'].most_common():
            print(f'{name}：{count}')
        print('\n【接口操作：日志可确认的范围】')
        for name, count in logs['actions'].most_common():
            print(f'{name}：{count}')
    print('\n【账号与实际保存的审阅】')
    users, reviews = database['users'], database['reviews']
    if users is not None:
        new_users = sum(start.timestamp() <= row['created_at'] <= end.timestamp() for row in users)
        print(f'当前账号总数：{len(users)}；所选时间内注册：{new_users}')
    if reviews is not None:
        print(f"已保存审阅总数：{sum(row['total'] for row in reviews)}；所选时间内：{sum(row['selected'] for row in reviews)}")
        print(f"所选时间内有已保存审阅的账号数：{sum(row['owner_id'] is not None and row['selected'] > 0 for row in reviews)}")
        print('每次复核也保存一个新版本，因此审阅条数不等于独立文稿数。')
    if show_users and users is not None and reviews is not None:
        mapping = {row['owner_id']: row for row in reviews}
        print('\n【每个账号的已保存审阅（最多20名）】')
        ranked = sorted(users, key=lambda row: (mapping.get(row['id'], {}).get('selected', 0), row['created_at']), reverse=True)
        for user in ranked[:20]:
            item = mapping.get(user['id'], {})
            print(f"{user['username']} | 注册 {local_time(user['created_at'])} | 本期 {item.get('selected', 0)} / 总计 {item.get('total', 0)} | 最近保存 {local_time(item.get('latest'))}")
    for warning in logs['warnings'] + database['warnings']:
        print('\n注意：' + warning)
    print('\n口径：IP不等于人数；共用Wi-Fi、多设备、动态IP和机器人都会影响统计。')
    print('日志不包含应用账号，无法把全部页面/登录/上传操作可靠归到某个账号。')
    print('200审阅响应可能在流式处理中失败，完成量以数据库中的已保存记录为准。')
    print('未记录页面停留、点击、未提交的修改，也无法补查已删除日志中的访问。')
    print('已排除回环地址；仍包含你自己从公网访问及其他探测流量。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--days', type=int, default=7, help='Beijing calendar days including today (default 7)')
    parser.add_argument('--users', action='store_true', help='Show usernames and saved-review counts, max 20')
    parser.add_argument('--data-dir', type=Path, default=Path('/opt/costume-verifier/data'))
    parser.add_argument('--log-dir', type=Path, default=Path('/var/log/nginx'))
    parser.add_argument('--exclude-ip', action='append', default=[], help='Exclude your own IP from access counts; repeatable')
    args = parser.parse_args()
    if not 1 <= args.days <= 366:
        parser.error('--days must be between 1 and 366')
    end = datetime.now(CHINA)
    start = datetime.combine(end.date() - timedelta(days=args.days - 1), time.min, CHINA)
    logs = read_logs(args.log_dir, start, end, set(args.exclude_ip))
    database = read_databases(args.data_dir, start, end)
    print_report(logs, database, start, end, args.users)
    return 1 if logs['warnings'] or database['warnings'] else 0


if __name__ == '__main__':
    sys.exit(main())
