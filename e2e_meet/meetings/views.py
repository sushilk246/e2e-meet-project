from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db.models import Q
from django.http import HttpResponseNotAllowed
from django.shortcuts import get_object_or_404, redirect, render

from .models import Message, Room


@login_required
def dashboard(request):
    user = request.user
    hosted = Room.objects.filter(host=user, is_active=True)
    recent = (
        Room.objects.filter(
            Q(messages__author=user) | Q(host=user),
            is_active=True,
        )
        .distinct()
        .order_by("-created_at")[:10]
    )
    return render(
        request,
        "meetings/dashboard.html",
        {"hosted_rooms": hosted, "recent_rooms": recent},
    )


@login_required
def create_room(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    name = (request.POST.get("name") or "").strip()
    room = Room.objects.create(host=request.user, name=name)
    return redirect("meetings:room", code=room.code)


@login_required
def join_room(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    code = (request.POST.get("code") or "").strip()
    room = Room.objects.filter(code=code, is_active=True).first()
    if not room:
        messages.error(request, "No active room with that code.")
        return redirect("meetings:dashboard")
    return redirect("meetings:room", code=room.code)


@login_required
def room_view(request, code):
    room = get_object_or_404(Room, code=code, is_active=True)
    # Most recent 50 messages, reversed so the template displays chronologically.
    recent = room.messages.select_related("author").order_by("-created_at")[:50]
    history = list(reversed(recent))
    return render(
        request,
        "meetings/room.html",
        {"room": room, "history": history},
    )
