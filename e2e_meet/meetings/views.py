from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import HttpResponseNotAllowed
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_POST

from .models import Message, Room


def dashboard(request):
    # Anonymous users see a minimal join-with-code form (Phase 13). Logged-in
    # users see the full dashboard (create + recent + my meetings).
    if request.GET.get("ended") == "1":
        messages.info(request, "The host ended that meeting.")

    recent_rooms = []
    my_rooms = []
    if request.user.is_authenticated:
        user = request.user
        recent_rooms = (
            Room.objects.filter(participations__user=user, is_active=True)
            .exclude(host=user)
            .distinct()
            .order_by("-created_at")[:10]
        )
        my_rooms = Room.objects.filter(host=user, is_active=True).order_by("-created_at")

    return render(
        request,
        "meetings/dashboard.html",
        {"recent_rooms": recent_rooms, "my_rooms": my_rooms},
    )


@login_required
def create_room(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    name = (request.POST.get("name") or "").strip()
    room = Room.objects.create(host=request.user, name=name)
    return redirect("meetings:room", code=room.code)


def join_room(request):
    # Open to both authenticated users and guests — the redirect lands on
    # room_view, which then routes guests through the guest-landing flow.
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    code = (request.POST.get("code") or "").strip()
    room = Room.objects.filter(code=code, is_active=True).first()
    if not room:
        messages.error(request, "No active room with that code.")
        return redirect("meetings:dashboard")
    return redirect("meetings:room", code=room.code)


def room_view(request, code):
    # No @login_required: guests can land here and provide a typed name.
    room = get_object_or_404(Room, code=code, is_active=True)

    if request.user.is_authenticated:
        display_name = request.user.username
        is_host = room.host_id == request.user.id
    else:
        guest_name = (request.session.get(f"guest_name_{code}") or "").strip()
        if not guest_name:
            # First time here without an account → ask for a name.
            return render(request, "meetings/guest_landing.html", {"room": room})
        display_name = guest_name
        is_host = False  # guests can never host

    recent = room.messages.select_related("author").order_by("-created_at")[:50]
    history = list(reversed(recent))
    return render(
        request,
        "meetings/room.html",
        {
            "room": room,
            "history": history,
            "display_name": display_name,
            "is_host": is_host,
        },
    )


@require_POST
def guest_join(request, code):
    room = get_object_or_404(Room, code=code, is_active=True)
    name = (request.POST.get("name") or "").strip()[:80]
    if not name:
        messages.error(request, "Please enter your name to join.")
        return redirect("meetings:room", code=room.code)
    # Per-room session key — joining room A doesn't leak a name into room B.
    request.session[f"guest_name_{code}"] = name
    return redirect("meetings:room", code=room.code)


@login_required
@require_POST
def delete_room(request, code):
    # host-scoped lookup doubles as authorization: non-hosts get a 404, which
    # is preferable to a 403 since it doesn't leak room existence.
    room = get_object_or_404(Room, code=code, host=request.user, is_active=True)
    room.is_active = False
    room.save(update_fields=["is_active"])

    # Kick anyone currently in the room. The consumer's room_closed handler
    # pushes a {type: "room-closed"} frame and closes the socket with 4005.
    async_to_sync(get_channel_layer().group_send)(
        f"room_{room.code}",
        {"type": "room.closed"},
    )

    messages.success(request, f"Meeting “{room}” ended.")
    return redirect("meetings:dashboard")
