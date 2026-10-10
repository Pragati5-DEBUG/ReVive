"""ReVive chat, answered by the Strands Agents SDK.

The agent reads saved reports through tools. Amazon Bedrock is the model,
which is the SDK default. A call needs AWS credentials with Bedrock access.
"""

from __future__ import annotations

import math
import threading
from pathlib import Path

from strands import Agent, tool

CLUSTER_METRES = 400
UPLOADS = Path(__file__).resolve().parent / "data" / "uploads"
IMAGE_FORMATS = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg", "gif": "gif", "webp": "webp"}

_local = threading.local()

SYSTEM = """You are the ReVive collection agent for a waste crew in India.
Use the tools to read the saved reports. Never invent a pile, a place, or a number.
Energy means two things only, and only when a tool says so:
- piles within 400 metres are one truck trip, so the truck burns less fuel
- wet or food waste can go to a biogas plant, and plastic should not be burned
Photos may be attached to the question. When a photo is attached, judge the waste from the picture. If the picture and the note disagree, trust the picture. If several reports share one photo, say that. Do not invent a weight or a gas amount.
Answer in two or three short sentences.
"""


def _reports() -> list[dict]:
    return list(getattr(_local, "reports", []))


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
    """List every saved waste report, with its note and coordinates."""
    reports = _reports()
    if not reports:
        return "No piles have been reported yet."
    lines = []
    for item in reports:
        note = item.get("note") or "Pile with no note"
        lines.append(f"{note} at {item['lat']:.5f}, {item['lng']:.5f}")
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
        notes = ", ".join(item.get("note") or "pile" for item in group)
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
        lowered = note.lower()
        if any(word in lowered for word in wet_words):
            lines.append(f"\"{note}\" looks like wet waste. Send it to biogas instead of a drain.")
        elif any(word in lowered for word in plastic_words):
            lines.append(f"\"{note}\" looks like plastic. Do not burn it.")
        else:
            lines.append(f"\"{note or 'no note'}\" does not say if the waste is wet or plastic.")
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
    _local.reports = reports
    agent = Agent(
        name="ReVive",
        system_prompt=SYSTEM,
        tools=[list_reports, plan_truck_trips, biogas_from_notes],
        callback_handler=None,
    )
    return _reply_text(agent(_photo_message(question, reports)))
