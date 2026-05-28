from django.urls import path

from . import views

app_name = "meetings"

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("create/", views.create_room, name="create"),
    path("join/", views.join_room, name="join"),
    path("r/<str:code>/", views.room_view, name="room"),
    path("r/<str:code>/guest-join/", views.guest_join, name="guest_join"),
    path("r/<str:code>/delete/", views.delete_room, name="delete"),
]
