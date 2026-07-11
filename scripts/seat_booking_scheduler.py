from __future__ import annotations

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app import create_app  # noqa: E402
from backend.app.modules.seat_booking.routes import run_due_seat_bookings  # noqa: E402


def main() -> int:  # Ethan Luo
    app = create_app({"SEAT_BOOKING_SCHEDULER_ENABLED": False})
    with app.app_context():
        results = run_due_seat_bookings()
    print(f"Seat booking scheduler finished: {len(results)} job(s) executed.")
    for result in results:
        run = result.get('run', {})
        print(f"{run.get('bookingDate', '')} {run.get('seatName') or run.get('seatId', '')}: {run.get('status', '')} {run.get('message', '')}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())