# bookings

Django project for meeting-room bookings.

```
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
python manage.py test
```

App `rooms`: rooms and bookings, JSON views at `/rooms/` and `/rooms/<id>/bookings/`.
