# WebSocket routes for the meetings app.

from django.urls import re_path

from .consumers import SignalingConsumer

websocket_urlpatterns = [
    re_path(r"^ws/room/(?P<code>[\w-]+)/$", SignalingConsumer.as_asgi()),
]
