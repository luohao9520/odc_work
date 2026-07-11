from __future__ import annotations

import argparse
import os
import sys

from backend.app import create_app

TRUTHY = {"1", "true", "yes", "on"}
FALSY = {"0", "false", "no", "off"}


def flag_enabled(name: str) -> bool:
    return os.environ.get(name, default="").strip().lower() in TRUTHY


def parse_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in TRUTHY:
        return True
    if normalized in FALSY:
        return False
    raise argparse.ArgumentTypeError(f"应为 true/false/1/0/yes/no/on/off，当前为: {value}")


def int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="启动月度出勤率计算器 Flask 服务")
    parser.add_argument("--hot-reload", nargs="?", type=parse_bool, help="快捷开关，true 开启 Debug+热加载，false 关闭")
    parser.add_argument("--debug", "-d", nargs="?", const=True, default=None, type=parse_bool, help="开启/关闭 Flask Debugger，开启时自动启用热加载")
    parser.add_argument("--reload", "-r", nargs="?", const=True, default=None, type=parse_bool, help="开启/关闭热加载，不必打开 Debugger")
    parser.add_argument("--host", default=None, help="监听地址，默认读取 ATTENDANCE_HOST 或 0.0.0.0")
    parser.add_argument("--port", type=int, default=None, help="监听端口，默认读取 ATTENDANCE_PORT 或 5000")
    parser.add_argument("--seat-booking-scheduler", nargs="?", const=True, default=None, type=parse_bool, help="开启/关闭内置座位预约调度器")
    parser.add_argument("--seat-booking-scheduler-interval", type=int, default=None, help="内置座位预约调度器检查间隔秒数，最小 10 秒")
    parser.add_argument("--data-cleanup-scheduler", nargs="?", const=True, default=None, type=parse_bool, help="开启/关闭数据清理调度器，真正清理由管理员页面开关控制")
    parser.add_argument("--data-cleanup-scheduler-interval", type=int, default=None, help="数据清理调度器检查间隔秒数，最小 60 秒")
    parser.add_argument("--true", dest="quick_true", action="store_true", help="兼容快捷写法，开启 Debug+热加载")
    parser.add_argument("--false", dest="quick_false", action="store_true", help="兼容快捷写法，关闭 Debug+热加载")
    return parser


def resolve_run_config(argv: list[str] | None = None) -> dict:
    args = build_parser().parse_args(argv)

    debug = flag_enabled("ATTENDANCE_DEBUG")
    reload = debug or flag_enabled("ATTENDANCE_RELOAD")

    if args.hot_reload is not None:
        debug = args.hot_reload
        reload = args.hot_reload

    if args.quick_true:
        debug = True
        reload = True

    if args.quick_false:
        debug = False
        reload = False

    if args.debug is not None:
        debug = args.debug
        if debug:
            reload = True

    if args.reload is not None:
        reload = args.reload

    return {
        "host": args.host or os.environ.get("ATTENDANCE_HOST", default="0.0.0.0"),
        "port": args.port if args.port is not None else int_env("ATTENDANCE_PORT", default=5000),
        "debug": debug,
        "use_reloader": reload,
        "seat_booking_scheduler_enabled": args.seat_booking_scheduler,
        "seat_booking_scheduler_interval": args.seat_booking_scheduler_interval,
        "data_cleanup_scheduler_enabled": args.data_cleanup_scheduler,
        "data_cleanup_scheduler_interval": args.data_cleanup_scheduler_interval,
    }


def is_reloader_parent(use_reloader: bool) -> bool:
    return bool(use_reloader and os.environ.get("WERKZEUG_RUN_MAIN") != "true")


def build_app_config(config: dict) -> dict:
    app_config = {}
    scheduler_enabled = config.get("seat_booking_scheduler_enabled")
    scheduler_interval = config.get("seat_booking_scheduler_interval")
    cleanup_scheduler_enabled = config.get("data_cleanup_scheduler_enabled")
    cleanup_scheduler_interval = config.get("data_cleanup_scheduler_interval")

    if is_reloader_parent(config.get("use_reloader", False)):
        app_config["SEAT_BOOKING_SCHEDULER_ENABLED"] = False
        app_config["DATA_CLEANUP_SCHEDULER_ENABLED"] = False
    elif scheduler_enabled is not None:
        app_config["SEAT_BOOKING_SCHEDULER_ENABLED"] = scheduler_enabled

    if not is_reloader_parent(config.get("use_reloader", False)) and cleanup_scheduler_enabled is not None:
        app_config["DATA_CLEANUP_SCHEDULER_ENABLED"] = cleanup_scheduler_enabled

    if scheduler_interval is not None:
        app_config["SEAT_BOOKING_SCHEDULER_INTERVAL"] = scheduler_interval

    if cleanup_scheduler_interval is not None:
        app_config["DATA_CLEANUP_SCHEDULER_INTERVAL"] = cleanup_scheduler_interval

    return app_config


def main(argv: list[str] | None = None) -> None:
    config = resolve_run_config(argv)
    app_config = build_app_config(config)
    config.pop("seat_booking_scheduler_enabled")
    config.pop("seat_booking_scheduler_interval")
    config.pop("data_cleanup_scheduler_enabled")
    config.pop("data_cleanup_scheduler_interval")

    runtime_app = create_app(app_config or None)
    runtime_app.run(**config)


app = create_app({"SEAT_BOOKING_SCHEDULER_ENABLED": False, "DATA_CLEANUP_SCHEDULER_ENABLED": False})

if __name__ == "__main__":
    main(sys.argv[1:])
