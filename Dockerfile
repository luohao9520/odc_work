FROM python:3.12-slim

WORKDIR /app

# 安装系统依赖（SQLite 已内置在 python:slim 镜像中）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目代码
COPY . .

# 创建数据目录并初始化数据库
RUN mkdir -p instance && \
    python scripts/init_db.py

# 暴露端口
EXPOSE 5000

# 使用 Waitress 作为生产级 WSGI 服务器启动
# 可通过环境变量覆盖：SECRET_KEY, ATTENDANCE_HOST, ATTENDANCE_PORT
CMD ["python", "-m", "waitress", "--host=0.0.0.0", "--port=5000", "--call", "backend.app.main:create_app"]
