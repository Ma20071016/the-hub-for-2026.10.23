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
import heapq
import ipaddress
from pathlib import Path
import re
import sqlite3
import sys
import unicodedata
from urllib.parse import urlsplit

CHINA = timezone(timedelta(hours=8))
LOG_LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "((?:\\.|[^"\\])*)" (\d{3}) (?:\d+|-)')
LOG_EXTRA = re.compile(r'\s+"((?:\\.|[^"\\])*)"\s+"((?:\\.|[^"\\])*)"')
ROTATION = re.compile(r'costume-access\.log(?:\.\d+(?:\.gz)?)?\Z')
PAGES = {'/': '工作台首页', '/index.html': '工作台', '/login.html': '登录页',
         '/library.html': '资料馆', '/source.html': '资料详情',
         '/archive.html': '审阅档案页', '/guide.html': '使用指南'}


def safe_text(value, limit=120):
    """Never emit terminal controls from client-controlled log fields."""
    return ''.join(char for char in str(value) if not unicodedata.category(char).startswith('C'))[:limit]


def ip_argument(value):
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as exc:
        raise argparse.ArgumentTypeError('请输入有效的 IPv4 或 IPv6 地址') from exc


def request_label(method, path):
    """Describe requests, including failures; do not infer a human click."""
    if method == 'POST':
        labels = {
            '/api/auth/register': '注册账号', '/api/auth/login': '登录账号',
            '/api/auth/logout': '退出登录', '/api/extract': '上传并解析文稿',
            '/api/review': '提交整篇审阅', '/api/verify': '单句核验',
            '/api/search': '检索资料',
        }
        if path in labels:
            return labels[path]
        if re.fullmatch(r'/api/reviews/[0-9a-f]{32}/decisions', path):
            return '保存人工意见'
    if method == 'GET':
        if path in PAGES:
            return '访问' + PAGES[path]
        if path == '/api/reviews':
            return '读取审阅档案列表（页面也会自动请求）'
        if re.fullmatch(r'/api/reviews/[0-9a-f]{32}/report', path):
            return '获取审阅报告'
        if re.fullmatch(r'/api/reviews/[0-9a-f]{32}', path):
            return '读取已保存的审阅'
        match = re.fullmatch(r'/api/library/([1-9][0-9]{0,18})', path)
        if match:
            return '读取资料详情 #' + match[1]
        if path == '/downloads/robe-review-practice.docx':
            return '获取体验示例文稿'
    return None


def request_result(method, path, status):
    if status == 200 and method == 'POST' and path == '/api/review':
        return '返回200；是否完成须查已保存档案'
    if status == 200 and method == 'POST' and path == '/api/verify':
        return '返回200；不代表已运行模型或核验通过'
    if status == 200 and path.endswith(('.docx', '/report')):
        return '响应成功(200)；不代表已保存到访客电脑'
    if 200 <= status < 300:
        return f'响应成功({status})'
    results = {304: '使用浏览器缓存', 400: '请求内容有误', 401: '未登录或登录验证失败',
               403: '访问被拒绝', 404: '地址或记录不存在', 408: '请求超时',
               409: '内容冲突或账号已存在', 413: '提交内容过大',
               429: '请求过于频繁，已限流', 499: '客户端提前断开'}
    if status in results:
        return f'{results[status]}({status})'
    if 300 <= status < 400:
        return f'页面跳转({status})'
    return f'{"服务器错误" if status >= 500 else "请求未成功"}({status})'


def client_summary(agent):
    agent = agent.lower()
    if not agent or agent == '-':
        return '未提供'
    if any(word in agent for word in ('bot', 'spider', 'crawler', 'curl/', 'wget/', 'python-requests')):
        return '自动化客户端（按UA识别）'
    browser = next((name for marker, name in (
        ('micromessenger', '微信'), ('edg/', 'Edge'), ('edga/', 'Edge'), ('edgios/', 'Edge'),
        ('opr/', 'Opera'), ('firefox/', 'Firefox'), ('fxios/', 'Firefox'),
        ('chrome/', 'Chrome'), ('crios/', 'Chrome'), ('safari/', 'Safari')) if marker in agent), '未知浏览器')
    system = next((name for marker, name in (
        ('android', 'Android'), ('iphone', 'iOS'), ('ipad', 'iPadOS'),
        ('windows', 'Windows'), ('macintosh', 'macOS'), ('linux', 'Linux')) if marker in agent), '未知系统')
    return browser + ' / ' + system


def referrer_host(raw):
    try:
        parsed = urlsplit(raw)
        if parsed.scheme in ('http', 'https') and parsed.hostname:
            return safe_text(parsed.hostname, 90)
    except ValueError:
        pass
    return '未提供或无法识别'


def display_path(path):
    path = re.sub(r'(?<=/api/reviews/)[0-9a-f]{32}(?=/|$)', '[记录编号已隐藏]', path)
    return safe_text(path)


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


def read_logs(log_dir, start, end, exclude, details=0, only_ip=None, all_requests=False):
    stats = {'requests': 0, 'page_requests': 0, 'ip': set(), 'page_ip': set(),
             'pages': Counter(), 'actions': Counter(), 'statuses': Counter(),
             'daily': defaultdict(lambda: {'requests': 0, 'ip': set(), 'pages': 0}),
             'files': 0, 'malformed': 0, 'first': None, 'last': None, 'warnings': [],
             'events': [], 'detail_matches': 0}
    exclude = {str(ipaddress.ip_address(value)) for value in exclude}
    only_ip = str(ipaddress.ip_address(only_ip)) if only_ip else None
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
                        peer = str(address)
                        fields = request.split()
                        if len(fields) != 3 or not fields[2].startswith('HTTP/'):
                            raise ValueError('Invalid request line')
                        method, target, _ = fields
                        route = urlsplit(target).path
                    except ValueError:
                        stats['malformed'] += 1
                        continue
                    if (address.is_loopback or peer in exclude or not start <= stamp <= end
                            or (only_ip is not None and peer != only_ip)):
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
                    label = request_label(method, route)
                    if details and (label or all_requests):
                        stats['detail_matches'] += 1
                        extra = LOG_EXTRA.match(line, match.end())
                        referer, agent = extra.groups() if extra else ('-', '-')
                        if label is None and route in ('/api/auth/session', '/api/sources', '/api/library'):
                            label = '页面辅助请求（通常自动触发）'
                        event = {'ip': peer, 'action': label or '其他HTTP请求',
                                 'path': display_path(route), 'method': safe_text(method, 12),
                                 'result': request_result(method, route, status),
                                 'client': client_summary(agent), 'source': referrer_host(referer)}
                        entry = (stamp, stats['detail_matches'], event)
                        if len(stats['events']) < details:
                            heapq.heappush(stats['events'], entry)
                        else:
                            heapq.heappushpop(stats['events'], entry)
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


def print_report(logs, database, start, end, show_users, only_ip=None):
    print(f'网站使用统计 | 北京时间 {local_time(start)} 至 {local_time(end)}')
    print('只读取已有日志和数据库；不会停止服务或修改账号。\n')
    print('【访问：限仍保留的日志】')
    if only_ip:
        print(f'访问记录仅筛选 IP：{only_ip}；下方账号与审阅统计仍为全站，不能按IP关联账号。')
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
            print(f"{safe_text(user['username'], 60)} | 注册 {local_time(user['created_at'])} | 本期 {item.get('selected', 0)} / 总计 {item.get('total', 0)} | 最近保存 {local_time(item.get('latest'))}")
    for warning in logs['warnings'] + database['warnings']:
        print('\n注意：' + warning)
    print('\n口径：IP不等于人数；共用Wi-Fi、多设备、动态IP和机器人都会影响统计。')
    print('日志不包含应用账号，无法把全部页面/登录/上传操作可靠归到某个账号。')
    print('200审阅响应可能在流式处理中失败，完成量以数据库中的已保存记录为准。')
    print('未记录页面停留、点击、未提交的修改，也无法补查已删除日志中的访问。')
    print('已排除回环地址；仍包含你自己从公网访问及其他探测流量。')


def print_details(logs, start, end, only_ip, all_requests):
    print(f'访问明细 | 北京时间 {local_time(start)} 至 {local_time(end)}')
    if only_ip:
        print(f'只看来源 IP：{only_ip}')
    print('显示所有HTTP请求。' if all_requests else '仅显示已知页面和业务请求；已隐藏图片、样式、会话检查等背景请求。')
    if logs['files']:
        print(f"保留日志中匹配 {logs['detail_matches']} 条；显示最近 {len(logs['events'])} 条，按时间从早到晚排列。")
        for stamp, _, event in sorted(logs['events']):
            print(f"\n{local_time(stamp)} | IP {event['ip']}")
            print(f"  {event['action']} → {event['result']}")
            print(f"  客户端识别：{event['client']} | 来源站点：{event['source']}")
            print(f"  {event['method']} {event['path']}")
        if not logs['events']:
            print('没有匹配记录；不代表网站从未有人访问。可扩大 --days 或加 --all-requests。')
    if logs['malformed']:
        print(f"\n无法解析的日志行：{logs['malformed']}（未计入）。")
    for warning in logs['warnings']:
        print('\n注意：' + safe_text(warning, 300))
    print('\n说明：时间是响应写入日志的时间；请求不等于点击，IP不等于某个人或账号。')
    print('浏览器/系统/来源由客户端提供，可缺失或伪造；只显示来源站点，不显示查询参数。')
    print('未记录的点击、停留时长、浏览器本地草稿与导出无法补查。不要公开分享含访客IP的明细。')


def main():
    parser = argparse.ArgumentParser(description='只读网站统计与中文访问明细：请在云服务器运行，无需安装依赖或重启网站。')
    parser.add_argument('--days', type=int, default=7, help='北京时间自然日，包含今天，默认7天')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--users', action='store_true', help='汇总中显示用户名与已保存审阅数，最多20名')
    mode.add_argument('--details', type=int, metavar='N', help='只显示最近N条中文访问明细，1至500')
    parser.add_argument('--ip', type=ip_argument, help='只筛选这个来源IP的访问记录，不用于推断账号')
    parser.add_argument('--all-requests', action='store_true', help='明细中也显示静态文件、自动请求与未知地址')
    parser.add_argument('--data-dir', type=Path, default=Path('/opt/costume-verifier/data'))
    parser.add_argument('--log-dir', type=Path, default=Path('/var/log/nginx'))
    parser.add_argument('--exclude-ip', type=ip_argument, action='append', default=[], help='排除指定IP，可重复使用')
    args = parser.parse_args()
    if not 1 <= args.days <= 366:
        parser.error('--days 必须在1至366之间')
    if args.details is not None and not 1 <= args.details <= 500:
        parser.error('--details 必须在1至500之间')
    if args.all_requests and not args.details:
        parser.error('--all-requests 需要同时指定 --details N')
    end = datetime.now(CHINA)
    start = datetime.combine(end.date() - timedelta(days=args.days - 1), time.min, CHINA)
    logs = read_logs(args.log_dir, start, end, set(args.exclude_ip), args.details or 0, args.ip, args.all_requests)
    if args.details:
        print_details(logs, start, end, args.ip, args.all_requests)
        return 1 if logs['warnings'] else 0
    database = read_databases(args.data_dir, start, end)
    print_report(logs, database, start, end, args.users, args.ip)
    return 1 if logs['warnings'] or database['warnings'] else 0


if __name__ == '__main__':
    sys.exit(main())
