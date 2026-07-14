from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import urlunsplit, urlsplit

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app.core.config import PROXY_CONFIG
from backend.app.shared.calendar_utils import fetch_china_holidays, resolve_proxy_map  # noqa: E402


def mask_proxy(proxy_url: str) -> str:  # Ethan Luo
    parts = urlsplit(proxy_url)
    if not parts.username and not parts.password:
        return proxy_url
    host = parts.hostname or ""
    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, f"***:***@{netloc}", parts.path, parts.query, parts.fragment))


def parse_args() -> argparse.Namespace:  # Ethan Luo
    parser = argparse.ArgumentParser(description="诊断 Python 后端节假日 API 访问与代理配置。")
    parser.add_argument("--year", type=int, default=2025, help="要测试的年份，默认 2025。")
    return parser.parse_args()


def main() -> int:  # Ethan Luo
    args = parse_args()
    proxies = resolve_proxy_map()
    print(f"代理配置文件：{PROXY_CONFIG}")
    if proxies:
        print(f"当前 Python 识别到的代理：")
        for scheme, proxy in proxies.items():
            print(f" {scheme}: {mask_proxy(proxy)}")
    else:
        print(f"当前 Python 未识别到代理配置。")

    holidays, source = fetch_china_holidays(args.year)
    print(f"获取结果：{source}, 共 {len(holidays)} 条。")
    for item in holidays[:10]:
        day_type = "休息" if item.get("isHoliday") else "补班"
        print(f"   {item['date']} {item['name']} [{day_type}]")
    return 0 if holidays else 1


if __name__ == "__main__":
    raise SystemExit(main())
