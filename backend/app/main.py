from __future__ import annotations

from flask import Flask, jsonify, send_from_directory

from .core.config import DATABASE, INSTANCE_DIR, SECRET_KEY, STATIC_DIR, TEMPLATE_DIR
from .core.database import close_db, init_db
from .jobs.data_cleanup_scheduler import start_data_cleanup_scheduler
from .jobs.seat_booking_scheduler import start_seat_booking_scheduler
from .modules.admin.routes import admin_bp
from .modules.attendance.routes import attendance_bp
from .modules.auth.routes import auth_bp
from .modules.holidays.routes import holidays_bp
from .modules.seat_booking.routes import seat_booking_bp


def create_app(test_config: dict | None = None) -> Flask:
    INSTANCE_DIR.mkdir(exist_ok=True)

    app = Flask(
        __name__,
        static_folder=STATIC_DIR,
        static_url_path="/static/",
    )
    app.config.update(
        SECRET_KEY=SECRET_KEY,
        DATABASE=str(DATABASE),
    )
    if test_config:
        app.config.update(test_config)

    app.teardown_appcontext(close_db)

    with app.app_context():
        init_db()

    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(attendance_bp)
    app.register_blueprint(holidays_bp)
    app.register_blueprint(seat_booking_bp)

    @app.route("/")
    def root():
        return send_from_directory(TEMPLATE_DIR, "index.html")

    @app.route("/manifest.webmanifest")
    def manifest():
        response = send_from_directory(STATIC_DIR, "manifest.webmanifest")
        response.mimetype = "application/manifest+json"
        return response

    @app.route("/service-worker.js")
    def service_worker():
        response = send_from_directory(STATIC_DIR, "service_worker.js")
        response.mimetype = "application/javascript"
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.route("/<path:filename>")
    def pages(filename: str):
        allowed = {"index.html", "holidays.html", "seat-booking.html", "admin.html", "login.html", "api-doc.html", "offline.html"}
        if filename not in allowed:
            return jsonify({"error": "not_found"}), 404
        return send_from_directory(TEMPLATE_DIR, filename)

    start_seat_booking_scheduler(app)
    start_data_cleanup_scheduler(app)

    return app
