# 项目结构
```text
ODC/
├── backend                      # 后端主包（新的规范入口）
│  └─ app/
│     ├─ main.py                 # create_app()、蓝图注册、页面/PWA路由
│     ├─ core/                   # 配置、数据库、加密等基础设施
│     ├─ shared/                 # 日期、日历、代理、节假日获取等共享工具
│     ├─ domain/                 # 领域计算逻辑，例如输出统计与智能排班
│     ├─ modules/                # 按业务边界拆分的 Flask Blueprint
│     ├─ integrations/           # 外部系统客户端，例如座位预约平台
│     └─ jobs/                   # 后台/定时任务，例如作为预约调度器
├─ frontend/                      # 前端页面与静态资源（Flask 以 /static 和根页面路由托管）
│   ├─ templates/                # HTML 页面，包含出勤、节假日、登录、接口测试页、离线页
│   └─ static/                   # CSS/JS 静态资源、PWA manifest、service worker、图标
├─ tests/                         # 前后端测试
├─ instance/                      # SQLite 数据库、代理配置示例与运行时数据
├─ docs/                          # 项目文档
├─ scripts/                       # 运维和诊断脚本，详见 scripts/README.md
├─ run.py                        # 本地启动入口
├─ requirements.txt              # 依赖列表
├─ package.json                  # 前端依赖列表
├─ README.md                     # 项目说明
```


# 设计原则

- `backend/app` 是后端唯一主实现；`run.py`、脚本和测试都应 import `backend.app'`。
- 后端与前端都有只一份源文件位置，避免双份源文件冲突。
- 前端资源以 `frontend/templates` 和 `frontend/static` 为准；Flask 仍对外提供 `/static/*`、`/*.html`、`/manifest.webmanifest` 与 `/service-worker.js`，所以浏览器访问路径保持不变。
- 业务逻辑按 `core`、`shared`、`domain`、`modules`、`integrations`、`jobs` 拆分，降低 Blueprint 与基础设施耦合。
- SQLite 数据放在 `instance/attendance.sqlite3`，便于备份和忽略。
- 真实代理配置放在 `instance/proxy.json`，该文件被 `.gitignore` 忽略；示例见 `/instance/proxy.example.json`。
- 日期计算和节假日获取放在 `backend/app/shared/calendar_utils.py`，便于单元测试。
- 出勤统计和公式放在 `backend/app/domain/attendance/calculator.py`，由后端 API 返回权威 `summary`，前端只展示结果。
- PWA 的 `manifest.webmanifest` 放在 `frontend/static/`；`service-worker.js` 由 Flask 以根路径 `/service-worker.js` 提供，确保作用域覆盖整个应用。
- 出勤和节假日 API 分离，减少单文件膨胀。