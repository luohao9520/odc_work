# scripts

运维脚本目录。

## init_db.py

初始化 SQLite 数据库表结构，可选创建初始用户并同步指定年份官方节假日/补班信息。

```powershell
python .\scripts\init_db.py
python .\scripts\init_db.py --username admin --password secret123 --sync-year 2026
```

默认不会清理已有数据。若需要清空所有用户和业务配置：

```powershell
python .\scripts\init_db.py --reset --yes
```

## check_holiday_api.py

诊断 Python 后端是否识别代理配置，以及能否获取指定年份节假日/补班信息。

```powershell
python .\scripts\check_holiday_api.py --year 2025
```

## seat_booking_scheduler.py

一次性执行已启用的座位预约到期任务，主要用于手工诊断。当前推荐推荐使用 Flask 内置轻量调度器，默认会随 `python .\run.py` 启动，不再需要额外配置 Windows 计划任务、Linux cron 或 systemd timer。

脚本会自行判断是否达到页面中配置的预约时间，并避免重复提交已成功或已达到次数限制的同一预约。脚本内部会关闭内置后台线程，避免手工执行时额外启动周期调度。

外部座位平台访问与节假日同步共用 `ATTENDANCE_HTTPS_PROXY` / `ATTENDANCE_HTTP_PROXY` / `instance\proxy.json` 代理配置。生产环境如需强制直连，可设置 `ATTENDANCE_DISABLE_PROXY=true`。

```powershell
Set-Location "C:\Users\45490415\Data\Code\Other\ODC"
python .\scripts\seat_booking_scheduler.py
```