from django.test import TestCase

from rooms.models import Room


class RoomListTests(TestCase):
    def test_lists_rooms(self):
        Room.objects.create(name="Blue", capacity=6)
        r = self.client.get("/rooms/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()[0]["name"], "Blue")
