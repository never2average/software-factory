from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Room",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=100)),
                ("capacity", models.PositiveIntegerField(default=4)),
            ],
        ),
        migrations.CreateModel(
            name="Booking",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("booked_by", models.EmailField(max_length=254)),
                ("starts_at", models.DateTimeField()),
                ("ends_at", models.DateTimeField()),
                ("room", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="bookings", to="rooms.room")),
            ],
        ),
    ]
