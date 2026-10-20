from django.db import models


class Room(models.Model):
    name = models.CharField(max_length=100)
    capacity = models.PositiveIntegerField(default=4)


class Booking(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="bookings")
    booked_by = models.EmailField()
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
