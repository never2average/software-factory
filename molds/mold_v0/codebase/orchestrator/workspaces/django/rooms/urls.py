from django.urls import path

from rooms import views

urlpatterns = [
    path("", views.room_list),
    path("<int:room_id>/bookings/", views.booking_list),
]
