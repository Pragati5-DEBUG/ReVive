"""ReVive chat, answered by the Strands Agents SDK.

The agent reads saved reports through tools. Amazon Bedrock is the model,
which is the SDK default. A call needs AWS credentials with Bedrock access.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    from strands import Agent, tool
except ImportError:  # The site still opens if this package is missing on the server.
    Agent = None

    def tool(fn):
        return fn

CLUSTER_METRES = 400
UPLOADS = Path(__file__).resolve().parent / "data" / "uploads"
IMAGE_FORMATS = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg", "gif": "gif", "webp": "webp"}
PHOTO_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}

_local = threading.local()

SYSTEM = """You are the ReVive collection agent for a waste crew in India.
Use the tools to read the saved reports. Never invent a pile, a place, or a number.
Energy means two things only, and only when a tool says so:
- piles within 400 metres are one truck trip, so the truck burns less fuel
- wet or food waste can go to a biogas plant, and plastic should not be burned
Photos may be attached to the question. When a photo is attached, judge the waste from the picture. If the picture and the note disagree, trust the picture. If several reports share one photo, say that. Do not invent a weight or a gas amount.
Never mention coordinates, latitude, or longitude. Name the place from the tools, such as the Mess or the Library.
Answer in two or three short sentences.
"""

PLACES = [
    {"name": "Library", "lat": 31.7071, "lng": 76.5284},
    {"name": "Parvati hostel", "lat": 31.7039508, "lng": 76.5256693},
    {"name": "Hostel block", "lat": 31.7086, "lng": 76.5279},
    {"name": "Mess", "lat": 31.7074, "lng": 76.5264},
    {"name": "Main gate", "lat": 31.7064, "lng": 76.5259},
    {"name": "Market", "lat": 31.6906, "lng": 76.5406},
]


def _reports() -> list[dict]:
    return list(getattr(_local, "reports", []))


def _place_name(lat: float, lng: float) -> str:
    nearest = min(PLACES, key=lambda place: _metres(lat, lng, place["lat"], place["lng"]))
    return nearest["name"]


def _without_coordinates(text: str) -> str:
    cleaned = re.sub(r"-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}", "", text)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned.strip()


def _metres(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    earth = 6_371_000
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a1 = math.radians(lat1)
    a2 = math.radians(lat2)
    h = math.sin(d_lat / 2) ** 2 + math.cos(a1) * math.cos(a2) * math.sin(d_lng / 2) ** 2
    return 2 * earth * math.asin(min(1, math.sqrt(h)))


@tool
def list_reports() -> str:
    """List every saved waste report, with its note and place."""
    reports = _reports()
    if not reports:
        return "No piles have been reported yet."
    lines = []
    for item in reports:
        note = item.get("note") or "Pile with no note"
        lines.append(f"{note} at {_place_name(item['lat'], item['lng'])}")
    return f"{len(lines)} report(s).\n" + "\n".join(lines)


@tool
def plan_truck_trips() -> str:
    """Group reports within 400 metres into one truck trip and count the fuel trips saved."""
    pending = [dict(item) for item in _reports()]
    if not pending:
        return "No piles yet, so there is no truck trip to plan."
    groups: list[list[dict]] = []
    while pending:
        seed = pending.pop(0)
        group = [seed]
        for index in range(len(pending) - 1, -1, -1):
            other = pending[index]
            if _metres(seed["lat"], seed["lng"], other["lat"], other["lng"]) <= CLUSTER_METRES:
                group.append(pending.pop(index))
        groups.append(group)
    trips = len(groups)
    saved = len(_reports()) - trips
    lines = []
    for group in groups:
        notes = ", ".join(
            f"{item.get('note') or 'pile'} at {_place_name(item['lat'], item['lng'])}" for item in group
        )
        if len(group) >= 2:
            lines.append(f"{len(group)} piles within 400 m ({notes}). That is one truck trip.")
        else:
            lines.append(f"1 pile ({notes}). That is its own truck trip.")
    saving = (
        f"Grouping them saves {saved} trip(s), so the truck burns less fuel."
        if saved
        else "A second pile within 400 m of this one would turn two trips into one."
    )
    return f"{len(_reports())} pile(s), {trips} truck trip(s).\n" + "\n".join(lines) + "\n" + saving


@tool
def biogas_from_notes() -> str:
    """Read report notes and say which waste could make biogas and which should not be burned."""
    reports = _reports()
    if not reports:
        return "No notes yet."
    wet_words = ("food", "wet", "organic", "kitchen", "vegetable", "fruit", "leftover")
    plastic_words = ("plastic", "bag", "bottle", "wrapper")
    lines = []
    for item in reports:
        note = (item.get("note") or "").strip()
        place = _place_name(item["lat"], item["lng"])
        lowered = note.lower()
        if any(word in lowered for word in wet_words):
            lines.append(f"\"{note}\" at {place} looks like wet waste. Send it to biogas instead of a drain.")
        elif any(word in lowered for word in plastic_words):
            lines.append(f"\"{note}\" at {place} looks like plastic. Do not burn it.")
        else:
            lines.append(f"\"{note or 'no note'}\" at {place} does not say if the waste is wet or plastic.")
    return "\n".join(lines)


def _reply_text(result: object) -> str:
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        parts = message.get("content") or []
        texts = [part.get("text", "") for part in parts if isinstance(part, dict) and part.get("text")]
        joined = "\n".join(texts).strip()
        if joined:
            return joined
    return str(result).strip()


def _photo_message(question: str, reports: list[dict]) -> list[dict]:
    """Build a chat message that includes each distinct report photo."""
    groups: dict[str, dict] = {}
    order: list[str] = []
    for report in reports:
        name = Path(str(report.get("photoUrl") or "")).name
        path = UPLOADS / name
        if not name or not path.is_file():
            continue
        if name not in groups:
            groups[name] = {"path": path, "notes": []}
            order.append(name)
        groups[name]["notes"].append(report.get("note") or "Pile with no note")
    blocks: list[dict] = [{"text": question}]
    if not order:
        return blocks
    blocks.append({"text": "Judge the waste from these photos."})
    for name in order:
        item = groups[name]
        image_format = IMAGE_FORMATS.get(item["path"].suffix.lower().lstrip("."))
        if not image_format:
            continue
        notes = "; ".join(item["notes"])
        blocks.append({"text": f"Reports with this photo: {notes}"})
        blocks.append({"image": {"format": image_format, "source": {"bytes": item["path"].read_bytes()}}})
    return blocks


def ask_agent(question: str, reports: list[dict]) -> str:
    """Ask the Strands agent. Tools read the reports, and Claude sees the photos."""
    if Agent is None:
        raise RuntimeError("Strands is not installed on this server")
    _local.reports = reports
    agent = Agent(
        name="ReVive",
        system_prompt=SYSTEM,
        tools=[list_reports, plan_truck_trips, biogas_from_notes],
        callback_handler=None,
    )
    return _reply_text(agent(_photo_message(question, reports)))


def _gemini_text(payload: dict) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    return "".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()


def _wants_photos(question: str) -> bool:
    asked = question.lower()
    words = ("pile", "photo", "picture", "image", "energy", "biogas", "waste", "wet", "power", "kwh", "gas")
    return any(word in asked for word in words)


def _gemini_parts(question: str, facts: str, reports: list[dict], image: dict | None = None) -> list[dict]:
    if image:
        prompt = (
            "You are ReVive, chatting normally with someone in Hamirpur. "
            "A photo is attached. Look at that photo and answer the question they asked about it. "
            "You can describe what is in the picture, what kind of waste it is, or anything else they ask. "
            "If they ask about biogas or energy, only wet food or organic waste counts. "
            "Plastic and dry waste make none. Use about 0.1 cubic metres of biogas per kilogram of wet food, "
            "and say it is a rough estimate from the picture. "
            "Never mention coordinates. Answer in two or three short sentences.\n\n"
            f"Question: {question}"
        )
        return [
            {"text": prompt},
            {"text": "Photo the person just added."},
            {"inline_data": {"mime_type": image["mime"], "data": image["data"]}},
        ]
    prompt = (
        "You are ReVive, chatting normally with someone in Hamirpur. "
        "Answer the question they actually asked. "
        "If they greet you or ask something unrelated to the piles, reply like a normal chat. "
        "If they ask about piles, trucks, or biogas, use the saved reports and any photos attached. "
        "When they ask how much energy a pile can generate, look at that pile's photo. "
        "Only wet food or organic waste makes biogas. Plastic and dry mixed waste make little or none. "
        "Estimate the wet food you can see, using about 0.1 cubic metres of biogas per kilogram, and say it is a rough estimate from the picture. "
        "Never invent a pile. Never mention coordinates. Name the place instead. "
        "Answer in two or three short sentences.\n\n"
        f"Saved reports:\n{facts}\n\nQuestion: {question}"
    )
    parts: list[dict] = [{"text": prompt}]
    if not _wants_photos(question):
        return parts
        return parts
    seen: set[str] = set()
    for report in reports:
        name = Path(str(report.get("photoUrl") or "")).name
        path = UPLOADS / name
        if not name or name in seen or not path.is_file():
            continue
        mime = PHOTO_TYPES.get(path.suffix.lower().lstrip("."))
        if not mime:
            continue
        seen.add(name)
        note = report.get("note") or "Pile"
        place = _place_name(report["lat"], report["lng"])
        parts.append({"text": f'Photo of "{note}" at {place}.'})
        parts.append({
            "inline_data": {
                "mime_type": mime,
                "data": base64.b64encode(path.read_bytes()).decode(),
            }
        })
    return parts


def ask_gemini(question: str, reports: list[dict], image: dict | None = None) -> str:
    """Answer with Gemini, using the same report tools as the Strands agent."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Gemini key is missing")
    _local.reports = reports
    facts = "\n\n".join([list_reports(), plan_truck_trips(), biogas_from_notes()])
    parts = _gemini_parts(question, facts, reports, image)
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-3.8-flash:generateContent"
    )
    body = json.dumps({"contents": [{"parts": parts}]}).encode()
    last_error = RuntimeError("Gemini could not answer")
    for attempt in range(2):
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
        )
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                payload = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            last_error = RuntimeError(f"Gemini could not answer ({exc.code})")
            if exc.code not in {429, 500, 502, 503, 504} or attempt:
                raise last_error from exc
            time.sleep(8 if exc.code == 429 else 1)
            continue
        except urllib.error.URLError as exc:
            last_error = RuntimeError("Gemini could not answer")
            if attempt:
                raise last_error from exc
            time.sleep(1)
            continue
        except TimeoutError as exc:
            last_error = RuntimeError("Gemini could not answer")
            if attempt:
                raise last_error from exc
            time.sleep(1)
            continue
        text = _gemini_text(payload)
        if text:
            return _without_coordinates(text)
        last_error = RuntimeError("Gemini returned an empty answer")
        if attempt:
            raise last_error
        time.sleep(1)
    raise last_error
