# 月度出勤率计算器

本项目是一个本地运行的 Flask + SQLite 小应用，用于按登录用户登记“公司打卡 / 居家办公 / 请假”，并按月计算公司出勤率是否达标。

## 文档索引

- [项目结构说明](docs/project-structure.md)
- [运维脚本说明](scripts/README.md)
- [代理配置示例](instance/proxy.example.json)
- [依赖清单](requirements.txt)
- [前后端测试脚本](package.json)

## 功能概览

- 按月列出可登记日期，支持“公司打卡 / 居家办公 / 请假”。
- 支持“智能排班”：自动分配公司打卡和居家办公，按周尽量满足目标公司打卡比例，并保留已登记请假。
- 出勤达标天数按 `ceil(应统计工作日 × 目标出勤率)` 计算，默认目标出勤率为 60%。
- 出勤率按 `公司打卡天数 / 应统计工作日` 计算；居家办公计入分母但不计入分子，请假按休息日处理，不计入分母也不计入分子。
- 周末默认不计入分母；调休放假日不计入分母；周末补班日计入分母且可登记。
- 支持用户注册/登录，不同用户的数据互相隔离。
- 登记情况、目标出勤率、节假日调整保存到 `instance/attendance.sqlite3`。
- 出勤统计由 Flask 后端统一计算并通过 `api/attendance` 返回，前端只负责展示。
- 可自动获取中国法定节假日、调休放假和补班信息，在线不可用时使用内置兜底数据。
- 可在独立节假日页面维护完整年度日历。
- 可选择某个用户，将其某年的节假日/补班配置同步到当前用户。
- 支持外部座位平台预约助手：保存预约日期、首选座位和定时提交时间，可立即预约或通过本地定时脚本自动提交。
- 提供系统管理页面：管理员可分配用户角色、控制可访问页面、停用/启用用户、删除用户及其数据。
- 提供数据清理策略：可由管理员开启定期清理，默认考勤/加班保留 12 个月、座位计划保留 6 个月、运行日志保留 3 个月。
- 提供本地接口文档与测试页面，可使用当前登录会话测试 API。
- 支持 PWA 应用清单与 Service Worker，可在支持的浏览器中添加到手机主屏幕。

## 架构概览

- 后端主实现位于 `backend/app`，本地启动入口 `run.py` 会从 `backend.app` 创建 Flask 应用。
- 前端页面和静态资源位于 `frontend/templates`、`frontend/static`；Flask 仍按原 URL 暴露 `/static/*`、`/*.html`、`/manifest.webmanifest` 和 `/service-worker.js`。
- `backend/` 与 `frontend/` 是唯一源目录，后续开发和维护都围绕这两个目录进行。
- 详细目录职责见 [项目结构说明](docs/project-structure.md)。

## 快速开始

### 1. 安装依赖

```powershell
Set-Location "C:\Users\45498415\Data\Code\Other\ODC"
python -m pip install -r requirements.txt
```

`requirements.txt` 已包含 `waitress`，可用于本机生产模拟或阿里云简单 HTTP 部署。

### 2. 初始化数据库

```powershell
python .\scripts\init_db.py
```

默认初始化只创建表结构，不会删除已有用户、出勤登记或节假日配置。

如果需要清空所有数据并重新初始化，必须显式确认：

```powershell
python .\scripts\init_db.py --reset --yes
```

可选：初始化时创建初始用户，并同步指定年份官方节假日/补班信息：

```powershell
python .\scripts\init_db.py --username luohao --password secret123 --sync-year 2026
```

用户名 `luohao` 会自动设置为管理员。生产环境请使用强密码。

更多脚本说明见 [scripts/README.md](scripts/README.md)。

### 3. 启动服务

#### 开发/普通本地启动

```powershell
python .\run.py
```

默认启动适合普通运行或公网测试：关闭 Flask Debugger 和热加载。

开发时如需热加载，推荐直接使用启动参数：

```powershell
python .\run.py --reload
```

如果想同时开启 Flask Debugger 和热加载：

```powershell
python .\run.py --debug
```

也支持快捷写法：

```powershell
python .\run.py true
python .\run.py -true
```

如果只想通过环境变量开启，也可以在当前 PowerShell 会话中设置：

```powershell
$env:ATTENDANCE_DEBUG = "1"
python .\run.py
```

这会同时启用：

```text
debug=True
use_reloader=True
```

如果只想开启自动重载、不打开 Debugger：

```powershell
$env:ATTENDANCE_RELOAD = "1"
python .\run.py
```

可选调整监听地址和端口：

```powershell
python .\run.py --host 0.0.0.0 --port 8080
```

或使用环境变量：

```powershell
$env:ATTENDANCE_HOST = "0.0.0.0"
$env:ATTENDANCE_PORT = "5000"
python .\run.py
```

公网环境不要开启 `ATTENDANCE_DEBUG=1`。

#### 推荐生产模拟 / 阿里云简单 HTTP 启动

如果需要更接近生产运行，推荐使用 Waitress：

```powershell
$env:ATTENDANCE_SECRET_KEY = "换成你自己生成的随机密钥"
python -m waitress --host=127.0.0.1 --port=5055 --call backend.app.main:create_app
```

阿里云公网 IP 简单部署、不使用域名和 HTTPS 时，可监听所有网卡：

```bash
export ATTENDANCE_SECRET_KEY="换成你自己生成的随机密钥"
python -m waitress --host=0.0.0.0 --port=5000 --call backend.app.main:create_app
```

然后访问：

```text
http://公网IP:5000
```

注意：生产不要使用默认 `local-dev-attendance-secret`；可用下面命令生成密钥：

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

使用 Waitress 时不要用 `waitress-serve run:app`，因为 `run.py` 中的模块级 `app` 会禁用内置调度器。请使用 `--call backend.app.main:create_app`。

#### Linux systemd / systemctl 生产部署示例

生产环境可以用 `systemd` 托管 Waitress 进程，实现开机自启、异常退出自动拉起和统一日志管理。以下示例假设项目部署在 `/opt/odc`，运行用户为 `odc`，Python 虚拟环境在 `/opt/odc/.venv`。

创建服务文件：

```bash
sudo tee /etc/systemd/system/odc-attendance.service >/dev/null <<'EOF'
[Unit]
Description=ODC Attendance Web Service
After=network.target

[Service]
Type=simple
User=odc
Group=odc
WorkingDirectory=/opt/odc
Environment="ATTENDANCE_SECRET_KEY=换成你自己生成的随机密钥"
Environment="ATTENDANCE_DISABLE_PROXY=true"
Environment="PYTHONUNBUFFERED=1"
ExecStart=/opt/odc/.venv/bin/python -m waitress --host=0.0.0.0 --port=5000 --call backend.app.main:create_app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

如果生产环境确实需要代理访问节假日 API 或座位预约平台，不要设置 `ATTENDANCE_DISABLE_PROXY=true`，改为在服务文件中配置 `ATTENDANCE_HTTP_PROXY` / `ATTENDANCE_HTTPS_PROXY`。

启用并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable odc-attendance
sudo systemctl start odc-attendance
```

常用运维命令：

```bash
sudo systemctl status odc-attendance
sudo journalctl -u odc-attendance -f
sudo systemctl restart odc-attendance
sudo systemctl stop odc-attendance
```

更新代码或修改服务文件后，建议执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart odc-attendance
```

访问：

- 登录/注册：<http://127.0.0.1:5000/login.html>
- 出勤登记：<http://127.0.0.1:5000/index.html>
- 节假日调整：<http://127.0.0.1:5000/holidays.html>
- 座位预约：<http://127.0.0.1:5000/seat-booking.html>
- 系统管理：<http://127.0.0.1:5000/admin.html>
- 接口文档/测试：<http://127.0.0.1:5000/api-docs.html>

#### Docker 部署

项目提供了 `Dockerfile` 和 `docker-compose.yml`，也支持纯 `docker run` 方式部署。

**构建镜像**

```bash
docker build -t odc-work:latest .
```

**启动容器**

```bash
docker run -d \
  --name odc-work \
  -p 5000:5000 \
  -v /root/service/odc_work/instance:/app/instance \
  -e ATTENDANCE_SECRET_KEY="qwertyuiop" \
  --restart unless-stopped \
  odc-work:latest
```

> `-v /root/service/odc_work/instance:/app/instance` 将 SQLite 数据库持久化到宿主机，容器删除重建不会丢失数据。
> `ATTENDANCE_SECRET_KEY` 生产环境请替换为强随机密钥，生成方式见上文。

**更新镜像**

代码更新后，重新构建镜像并替换容器，数据不受影响：

```bash
# 1. 构建新镜像
docker build -t odc-work:latest .

# 2. 导出镜像（如需迁移到其他平台）
docker save odc-work:latest -o odc-work.tar

# 3. 停旧容器、删容器（不删数据）
docker stop odc-work
docker rm odc-work

# 4. 用新镜像启动（挂载路径不变，数据完好）
docker run -d \
  --name odc-work \
  -p 5000:5000 \
  -v /root/service/odc_work/instance:/app/instance \
  -e ATTENDANCE_SECRET_KEY="qwertyuiop" \
  --restart unless-stopped \
  odc-work:latest
```

**迁移到其他平台**

```bash
# 源机器：导出镜像
docker save odc-work:latest -o odc-work.tar

# 将 odc-work.tar 和宿主机 instance/ 目录拷贝到目标机器

# 目标机器：加载镜像
docker load -i odc-work.tar

# 启动容器（挂载拷贝过来的 instance/ 目录）
docker run -d \
  --name odc-work \
  -p 5000:5000 \
  -v /root/service/odc_work/instance:/app/instance \
  -e ATTENDANCE_SECRET_KEY="qwertyuiop" \
  --restart unless-stopped \
  odc-work:latest
```

> 注意：`.dockerignore` 已排除 `instance/`，SQLite 数据库不会打包进镜像。运行时通过 `-v` 挂载宿主机目录实现数据持久化。

## 系统管理

系统管理页面仅管理员可访问。初始化或注册用户名为 `luohao` 的账号会自动成为管理员。

管理员可在 <http://127.0.0.1:5000/admin.html> 执行：

- 设置用户角色：普通用户 / 管理员。
- 设置用户可访问页面：出勤登记、节假日调整、座位预约、接口测试、系统管理。
- 停用或启用用户：停用后用户无法登录，已有会话也会失效；历史业务数据保留。
- 删除用户：永久删除该用户及其出勤、加班、节假日、座位预约、页面权限等关联数据；执行前建议先备份 SQLite。
- 配置数据清理策略和定期清理开关。

保护规则：

- 不能停用或删除当前登录用户。
- 不能停用或删除内置管理员 `luohao`。
- 至少保留一个启用状态的管理员。
- 普通用户不能获得“系统管理”页面权限；只有管理员可访问系统管理。

相关 API：

```text
GET    /api/admin/users
PUT    /api/admin/users/<user_id>
PATCH  /api/admin/users/<user_id>/status
DELETE /api/admin/users/<user_id>
```

## PWA 手机网页应用

本项目已内置 PWA 资源：

- `/manifest.webmanifest`：应用名称、图标、启动地址、主题色。
- `/service-worker.js`：缓存应用外壳页面和静态资源。
- `/offline.html`：离线兜底页面。

在手机浏览器中打开应用后，可通过浏览器菜单选择“添加到主屏幕”或“安装应用”。

重要限制：Service Worker 和标准 PWA 安装能力通常要求安全上下文：

```text
HTTPS 域名
或 localhost 开发环境
```

如果你只用阿里云公网 IP 且没有 HTTPS，例如：

```text
http://公网IP:5000
```

页面可以正常访问，但多数手机浏览器不会启用 Service Worker，因此离线缓存和标准安装能力可能不可用。短期可以先作为普通手机网页使用；如果后续要稳定 PWA 安装和离线能力，建议配置 HTTPS，或使用临时 HTTPS 隧道做演示

## 出勤计算规则

出勤计算以 Flask 后端返回的 `summary` 为准，前端不再自行判断是否达标。

```text
应统计工作日（分母）= 普通工作日 - 调休放假日 + 周末补班日 - 请假日
公司打卡天数（分子）= 选择“公司打卡”的日期数
整月出勤率 = 整月公司打卡天数 ÷ 整月应统计工作日
截至今日出勤率 = 截至今日公司打卡天数 ÷ 截至今日应统计工作日
最低需公司打卡天数 = ceil(应统计工作日 × 目标出勤率)
```

登记状态对公式的影响：

| 状态           | 是否计入分母 | 是否计入分子  |
|--------------|--------|---------|
| 公司打卡         | 是      | 是       |
| 居家办公         | 是      | 否       |
| 请假           | 否      | 否       |
| 未选择的可统计工作日   | 是      | 否       |
| 普通周末         | 否      | 否       |
| 调休放假 / 法定休息日 | 否      | 否       |
| 周末补班日        | 是      | 按选择状态判断 |

示例：

- 普通周末：不可选择，不计入分母。
- 工作日调休放假：不可选择，不计入分母。
- 周末补班：可选择，计入分母。

## 智能排班

- 点击出勤登记页的“智能排班”后，后端会按当前目标出勤率自动分配当月可统计工作日的“公司 / 居家”。
- 用户手动选择的日期会被保留，不会被智能排班或“工作日全设为公司”覆盖；智能排班和批量设置产生的日期可以互相覆盖
- “工作日全设为公司”和“智能排班”默认只调整明天及之后的非手动选择日期；勾选“包含过去日期”后才会重排整个月的非手动选择日期。
- 智能排班以一周为周期，优先让每个周期也满足目标公司打卡比例；由于每周独立向上取整，最终公司打卡天数可能略高于月度最低要求。
- 可选择排班方式包括：智能排班、周一三优先、周二四优先、周三周五优先、周三四五优先、周一三五分散。
- 智能排班使用日期预演优化，根据历史和当前的手动公司/居家记录建立近期加权偏好画像，对每个候选工作日预测公司打卡适合度，并在每周达标、手动保护、请假排除和分散排班约束下生成推荐日期。样本不足时使用温和无先验生成、分散的安排。

## 座位预约

- “座位预约”页面会连接外部平台：
    - 登录：`http://meet.fxodc.clps.com.cn/Mobile/login/login`
    - 座位列表：`http://meet.fxodc.clps.com.cn/Mobile/seat/getseatList`
    - 提交预约：`http://meet.fxodc.clps.com.cn/Mobile/seat/bookseat`
- 平台可用账号密码保存在本地 SQLite，仅用于调用外部预约接口；读取接口 API 只返回 `hasPassword`，不会返回密码。
- 座位预约目标日期通过页面保存在月历选择：月历支持月份切换。跨月周中的其他月份日期会以虚化状态显示，点击后会跳转到对应月份并选中该日期。
- 点击月日历日期会直接打开日历区域内该日期的预约座位；座位列表支持按座位号关键字筛选、只显示可用座位。点击某个座位即确认该日期的预约计划。
- 日历日期会按状态显示：`预约中` 表示已保存计划等待定时提交， `成功` 表示外部平台预约成功并显示实际座位号。
- 预约成功日期会显示“取消预约”按钮，点击后需要确认；取消后会移除本地成功记录，该日期不再计入同周成功预约上限。
- “定时提交时间”和“提前预约天数”统一配置在月历外：提前天数范围为 0 到 7 天。保存配置后，调度器会按 `预约日期 - 提前天数 + 定时提交时间` 判断是否需要自动提交。
- 不支持预约当前日期之前的日期：启用定时预约时，`预约日期 - 提前天数 + 定时提交时间` 也不能早于当前时间。
- 自动预约前会再次尝试获取目标日期座位列表；如果首选座位已不可用，会按座位号就近选择仍可预约的座位。
- 同一自然周最多保留 3 天成功预约。如果该周已有 3 天成功预约，调度器不会继续为该周其他计划提交预约，除非先取消某天成功预约。
- 预约成功后，座位号会显示在座位预约日历日期和出勤登记日历对应日期中。
- 若外部平台返回“预定次数不可超过 3 次”，系统会记录为 `Limited`，视为正常限制结果。
- Flask 服务默认启用内置轻量调度器，调度器使用 SQLite 租约锁降低多进程重复执行风险。默认每 60 秒检查一次：

```powershell
python .\run.py
```

如果需要调整检查间隔：

```powershell
python .\run.py --seat-booking-scheduler-interval 60
```

如果需要显式关闭内置调度器：

```powershell
python .\run.py --seat-booking-scheduler false
```

开启热加载时，启动器会避免在 Flask reloader 父进程中启动调度线程，只让实际服务子进程运行调度器：

```powershell
python .\run.py --reload
```

内置调度器会自动检查已启用配置，达到“预约日期 - 提前天数 + 定时提交时间”且尚未成功/达到次数限制时才会提交。

## 节假日与补班

应用会优先调用在线中国节假日接口获取年度节假日及名称；若网络不可用，会使用内置离线兜底数据。目前内置兜底覆盖 2025、2026 年。

自动命名规则：

- 法定节假日当天显示节假日名，例如：`春节`。
- 春节假期中的 `除夕`、`初一`、`初二` 等统一显示为 `春节`。
- 因法定节假日调休而放假的日期显示为 `节假日名称 + 调休`，例如：`春节调休`。
- 因法定节假日调休而补班的日期显示为 `节假日名称 + 补班`，例如：`春节补班`。
- 补班只表示国家法定节假日调休产生的补班，不用于日常加班。

### 手动调整年度日历

打开 <http://127.0.0.1:5000/holidays.html>：

1. 选择年份。
2. 点击“自动获取中国节假日”。
3. 在完整年度日历中点击要调整的日期。
4. 选择日期类型：普通日、休息日 / 调休放假、补班日。
5. 点击“保存这一天”。
6. 返回出勤登记页后，该年份所有月份都会使用调整后的节假日。

### 从其他用户同步配置

1. 打开 <http://127.0.0.1:5000/holidays.html>。
2. 选择年份。
3. 在“从其他用户同步”下拉框中选择源用户。
4. 点击“同步所选用户配置”。
5. 同步后的配置只保存到当前登录用户，不会修改源用户。

## 内网代理配置

如果浏览器可以访问节假日 API 或座位预约平台，但 Python 后端无法获取，通常是因为浏览器/系统有代理，而 Python 进程没有显式代理配置。节假日同步和座位预约外部访问共用同一套代理配置。

### 方式一：环境变量

```powershell
$env:ATTENDANCE_HTTPS_PROXY = "http://proxy.company.com:8080"
$env:ATTENDANCE_HTTP_PROXY = "http://proxy.company.com:8080"
$env:ATTENDANCE_NO_PROXY = "*.hsbc"
python .\run.py
```

### 方式二：配置文件

复制示例文件：

```powershell
Copy-Item .\instance\proxy.example.json .\instance\proxy.json
```

编辑 `instance\proxy.json`：

```json
{
  "https": "http://你的用户名:你的密码@intproxy1.hk.hsbc:8080",
  "http": "http://你的用户名:你的密码@intproxy1.hk.hsbc:8080",
  "no_proxy": "*.hsbc"
}
```

注意：如果用户名或密码包含 `@`、`:`、`#`、空格等特殊字符，需要 URL encode。真实代理配置文件 `instance\proxy.json` 已加入 `.gitignore`，不要提交真实密码。

诊断代理和节假日 API：

```powershell
python .\scripts\check_holiday_api.py --year 2025
```

诊断输出会隐藏代理账号密码。

### 生产环境直连

后续部署到生产环境后，如果节假日 API 和座位预约平台都可以直接访问，可以不创建 `instance\proxy.json`，也不要设置 `ATTENDANCE_HTTPS_PROXY` / `ATTENDANCE_HTTP_PROXY`。如果运行环境里存在系统代理变量但本应用需要强制直连，可以设置：

```powershell
$env:ATTENDANCE_DISABLE_PROXY = "true"
python .\run.py
```

该开关会同时作用于节假日同步和座位预约。

## 数据与备份

所有运行数据都保存在：

```text
instance\attendance.sqlite3
```

备份或迁移时复制该文件即可。

建议在删除用户、清空数据、迁移服务器前先备份：

```powershell
$today = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item .\instance\attendance.sqlite3 ".\instance\attendance-$today.sqlite3"
```

Linux 示例：

```bash
mkdir -p ./backups
cp ./instance/attendance.sqlite3 "./backups/attendance-$(date +%Y%m%d-%H%M%S).sqlite3"
```

### 用户停用、启用与删除

- 停用用户：保留该用户历史数据，但禁止登录；如果该用户已有登录会话，下一次请求会变为未授权。
- 启用用户：恢复登录能力，原有历史数据仍可继续使用。
- 删除用户：永久删除该用户及其关联业务数据，包括出勤、加班、节假日配置、座位预约设置/计划/运行记录、页面权限等。

删除用户前建议先备份 `instance\attendance.sqlite3`。

### 数据定期清理

系统管理页可开启定期清理。默认策略：

| 数据       | 默认保留     |
|----------|----------|
| 考勤记录     | 最近 12 个月 |
| 加班记录     | 最近 12 个月 |
| 座位预订计划   | 最近 6 个月  |
| 座位预订运行日志 | 最近 3 个月  |

清理会删除过期业务记录，并可执行 SQLite `VACUUM` 回收空间。20G 小磁盘部署时，建议开启该开关并定期备份。

清空全部业务数据：

```powershell
python .\scripts\init_db.py --reset --yes
```

该命令会清空：

- 用户
- 用户页面权限
- 目标出勤率设置
- 出勤登记
- 加班记录
- 节假日 / 补班配置
- 节假日同步元信息
- 座位预约配置、计划和运行记录
- 数据清理配置

## 项目结构

核心目录：

```text
backend/app/    Flask 后端主实现，按 core/shared/domain/modules/integrations/jobs 分层
frontend/       HTML 页面、CSS/JS 静态资源和 PWA 文件
tests/          前后端测试
instance/       SQLite 数据库与本地配置
docs/           项目文档
scripts/        运维和诊断脚本
```

更详细说明见 [docs/project-structure.md](docs/project-structure.md)。

## 测试

运行完整测试：

```powershell
npm test
```

分别运行：

```powershell
node .\tests\test_frontend_logic.js
python -m unittest tests.test_backend tests.test_init_db tests.test_run_config
```

语法检查：

```powershell
npm run lint
```

等价于分别执行：

```powershell
node --check .\frontend\static\js\app.js
python -m compileall -q .\backend .\tests .\scripts .\run.py
```

## 故障排查

### 选择年份后获取不到在线节假日

先运行：

```powershell
python .\scripts\check_holiday_api.py --year 2025
```

- 如果显示 `timor.tech 中国节假日接口`：在线获取正常。
- 如果显示 `Nager.Date Public Holidays API`：备用接口可用，但可能缺少完整调休/补班。
- 如果显示 `内置离线兜底数据`：在线接口不可用，检查代理配置。

### Python 未识别代理

确认以下二选一配置已生效：

- 当前 PowerShell 会话中设置了 `ATTENDANCE_HTTPS_PROXY` / `ATTENDANCE_HTTP_PROXY`。
- 已创建 `instance\proxy.json`，且 JSON 格式正确。

### 初始化没有清空已有用户

这是默认安全行为。若需要清空，必须执行：

```powershell
python .\scripts\init_db.py --reset --yes
```

## 注意事项

- 自动节假日接口依赖网络、代理和第三方服务可用性。
- 建议每年年初打开节假日调整页，确认公司认可的全年日历。
- `instance\attendance.sqlite3` 和 `instance\proxy.json` 都属于本地运行数据，不应提交到代码仓库。