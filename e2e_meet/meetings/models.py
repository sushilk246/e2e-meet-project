import secrets

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


def generate_room_code() -> str:
    """Unique URL-safe room code. Retries on the (very rare) collision."""
    while True:
        code = secrets.token_urlsafe(6)
        if not Room.objects.filter(code=code).exists():
            return code


class Room(models.Model):
    code = models.CharField(max_length=16, unique=True, default=generate_room_code)
    name = models.CharField(max_length=120, blank=True)
    host = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="hosted_rooms",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.name or self.code


class Message(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="messages")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="meeting_messages",
    )
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"{self.author.username}: {self.body[:32]}"


class Participation(models.Model):
    """One row per joiner the room has seen (user or guest).

    Written by ``SignalingConsumer.connect`` so the dashboard can show
    "rooms I've joined" without depending on whether the user typed a
    chat message. Hosts also get a row (they're a participant in their
    own room), but the dashboard query excludes hosted rooms from the
    "Recent rooms" list since they have a dedicated "My meetings" panel.

    Phase 13: a participation row represents either a registered ``user``
    (FK to AUTH_USER_MODEL) or an anonymous ``guest_name`` typed on the
    landing page — exactly one of the two is set.
    """

    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="participations")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="participations",
        null=True,
        blank=True,
    )
    guest_name = models.CharField(max_length=80, blank=True)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("room", "user")
        ordering = ["-joined_at"]

    def clean(self) -> None:
        if bool(self.user) == bool(self.guest_name):
            raise ValidationError("Exactly one of user / guest_name must be set.")

    def __str__(self) -> str:
        who = self.user.username if self.user_id else f"guest:{self.guest_name}"
        return f"{who} ↔ {self.room.code}"
