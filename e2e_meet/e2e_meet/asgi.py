"""
ASGI config for e2e_meet project.

Routes HTTP to Django and WebSocket through Channels with auth-aware
URL routing. The WebSocket routes are defined in meetings/routing.py.
"""

import os

from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from django.conf import settings
from django.contrib.staticfiles.handlers import ASGIStaticFilesHandler
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "e2e_meet.settings")

# Initialize the Django ASGI app early so apps are loaded before importing
# any modules (like meetings.routing) that may reference Django models.
django_asgi_app = get_asgi_application()

# In DEBUG, serve /static/ via Django (matches runserver behavior).
# In production, a real static-file server (nginx, whitenoise, S3) should
# serve these — Django won't.
http_app = (
    ASGIStaticFilesHandler(django_asgi_app) if settings.DEBUG else django_asgi_app
)

import meetings.routing  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": http_app,
        "websocket": AuthMiddlewareStack(
            URLRouter(meetings.routing.websocket_urlpatterns)
        ),
    }
)
