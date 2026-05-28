from django.contrib import admin

from .models import Message, Participation, Room


@admin.register(Room)
class RoomAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "host", "is_active", "created_at")
    list_filter = ("is_active",)
    search_fields = ("code", "name", "host__username")


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ("room", "author", "short_body", "created_at")
    list_filter = ("room",)
    search_fields = ("body", "author__username")

    @admin.display(description="body")
    def short_body(self, obj):
        return obj.body[:60]


@admin.register(Participation)
class ParticipationAdmin(admin.ModelAdmin):
    list_display = ("room", "user", "guest_name", "joined_at")
    list_filter = ("room",)
    search_fields = ("user__username", "guest_name", "room__code")
