from django.http import JsonResponse
from django.shortcuts import get_object_or_404

from rooms.models import Room


def room_list(request):
    return JsonResponse([{"id": r.id, "name": r.name, "capacity": r.capacity} for r in Room.objects.all()], safe=False)


def booking_list(request, room_id: int):
    room = get_object_or_404(Room, pk=room_id)
    data = [{"id": b.id, "booked_by": b.booked_by, "starts_at": b.starts_at.isoformat(), "ends_at": b.ends_at.isoformat()}
            for b in room.bookings.order_by("starts_at")]
    return JsonResponse(data, safe=False)
