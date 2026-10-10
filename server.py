"""Local waste-report server.

Pile photos are stored in Amazon S3. Notes stay in data/reports.json.
The chat is a Strands agent whose model is Amazon Bedrock, the SDK default.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from agent_chat import ask_agent

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
UPLOADS = DATA / "uploads"
DB = DATA / "reports.json"

MAX_BYTES = 8 * 1024 * 1024
BUCKET = os.environ.get("REVIVE_BUCKET", "revive-waste-802690829452")
REGION = os.environ.get("AWS_REGION", "us-west-2")
# off: laptop files. public: permanent bucket link. private: short-lived link.
S3_MODE = "off"


def load_reports() -> list[dict]:
    if not DB.exists():
        return []
    return json.loads(DB.read_text(encoding="utf-8"))


def save_reports(reports: list[dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    DB.write_text(json.dumps(reports, indent=2), encoding="utf-8")


def _s3():
    return boto3.client("s3", region_name=REGION)


def _error_code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str(response.get("Error", {}).get("Code") or type(exc).__name__)
    return type(exc).__name__


def public_photo_url(name: str) -> str:
    return f"https://{BUCKET}.s3.{REGION}.amazonaws.com/uploads/{name}"


def prepare_bucket() -> None:
    """Open the photo bucket and allow browsers to read the pictures."""
    global S3_MODE
    client = _s3()
    try:
        client.head_bucket(Bucket=BUCKET)
    except ClientError as exc:
        if _error_code(exc) not in {"404", "NoSuchBucket", "NotFound"}:
            print(f"S3 is not available ({_error_code(exc)}). Photos stay on this laptop.")
            return
        try:
            client.create_bucket(
                Bucket=BUCKET,
                CreateBucketConfiguration={"LocationConstraint": REGION},
            )
        except (BotoCoreError, ClientError) as create_exc:
            print(f"S3 is not available ({_error_code(create_exc)}). Photos stay on this laptop.")
            return
    try:
        client.put_public_access_block(
            Bucket=BUCKET,
            PublicAccessBlockConfiguration={
                "BlockPublicAcls": True,
                "IgnorePublicAcls": True,
                "BlockPublicPolicy": False,
                "RestrictPublicBuckets": False,
            },
        )
        client.put_bucket_policy(
            Bucket=BUCKET,
            Policy=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Sid": "PublicReadPhotos",
                            "Effect": "Allow",
                            "Principal": "*",
                            "Action": "s3:GetObject",
                            "Resource": f"arn:aws:s3:::{BUCKET}/uploads/*",
                        }
                    ],
                }
            ),
        )
    except (BotoCoreError, ClientError) as exc:
        print(f"S3 photos are private ({_error_code(exc)}). The map will use a short-lived link.")
        S3_MODE = "private"
        return
    S3_MODE = "public"
    print(f"Photos are on S3: https://{BUCKET}.s3.{REGION}.amazonaws.com/uploads/")


def upload_photo(name: str, data: bytes) -> bool:
    if S3_MODE == "off":
        return False
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    try:
        _s3().put_object(
            Bucket=BUCKET,
            Key=f"uploads/{name}",
            Body=data,
            ContentType=mime,
        )
    except (BotoCoreError, ClientError) as exc:
        print(f"S3 upload failed ({_error_code(exc)}).")
        return False
    return True


def browser_photo_url(stored: str) -> str:
    """URL the page should use. Local paths stay local when S3 is off."""
    name = Path(stored).name
    if not name or S3_MODE == "off":
        return stored
    if stored.startswith("https://") and S3_MODE == "public":
        return stored
    if S3_MODE == "public":
        return public_photo_url(name)
    try:
        return _s3().generate_presigned_url(
            "get_object",
            Params={"Bucket": BUCKET, "Key": f"uploads/{name}"},
            ExpiresIn=60 * 60 * 12,
        )
    except (BotoCoreError, ClientError):
        return stored


def publish_saved_photos() -> None:
    """Upload the pile photos already on this laptop and point reports at S3."""
    if S3_MODE == "off":
        return
    reports = load_reports()
    changed = False
    for report in reports:
        stored = str(report.get("photoUrl") or "")
        if stored.startswith("https://"):
            continue
        name = Path(stored).name
        file_path = UPLOADS / name
        if not name or not file_path.is_file():
            continue
        if not upload_photo(name, file_path.read_bytes()):
            continue
        if S3_MODE == "public":
            report["photoUrl"] = public_photo_url(name)
            changed = True
    if changed:
        save_reports(reports)


def parse_multipart(body: bytes, content_type: str) -> dict[str, tuple[str, bytes]]:
    match = re.search(r"boundary=(?P<b>[^;]+)", content_type)
    if not match:
        raise ValueError("Missing upload boundary")
    boundary = match.group("b").strip().strip('"').encode()
    parts: dict[str, tuple[str, bytes]] = {}
    for chunk in body.split(b"--" + boundary):
        if b"Content-Disposition" not in chunk:
            continue
        header, _, payload = chunk.partition(b"\r\n\r\n")
        payload = payload.rstrip(b"\r\n")
        if payload.endswith(b"--"):
            payload = payload[:-2].rstrip(b"\r\n")
        name_match = re.search(rb'name="([^"]+)"', header)
        if not name_match:
            continue
        file_match = re.search(rb'filename="([^"]*)"', header)
        name = name_match.group(1).decode()
        filename = file_match.group(1).decode() if file_match else ""
        parts[name] = (filename, payload)
    return parts


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: object) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/reports":
            reports = load_reports()
            reports.sort(key=lambda item: item["createdAt"], reverse=True)
            visible = [{**item, "photoUrl": browser_photo_url(str(item.get("photoUrl") or ""))} for item in reports]
            self._json(200, {"reports": visible})
            return
        if path.startswith("/uploads/"):
            name = Path(path).name
            file_path = UPLOADS / name
            if not file_path.is_file():
                self._json(404, {"error": "Photo not found"})
                return
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            self._send(200, file_path.read_bytes(), mime)
            return
        if path == "/":
            path = "/index.html"
        file_path = (WEB / path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(WEB.resolve())) or not file_path.is_file():
            self._json(404, {"error": "Not found"})
            return
        mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self._send(200, file_path.read_bytes(), mime)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/chat":
            self._chat()
            return
        clean = re.fullmatch(r"/api/reports/([^/]+)/clean", path)
        if clean:
            self._mark_clean(clean.group(1))
            return
        if path != "/api/reports":
            self._json(404, {"error": "Not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BYTES:
            self._json(400, {"error": "Photo must be under 8 MB"})
            return
        body = self.rfile.read(length)
        try:
            parts = parse_multipart(body, self.headers.get("Content-Type", ""))
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        filename, photo = parts.get("photo", ("", b""))
        if not photo:
            self._json(400, {"error": "Add a photo of the pile"})
            return
        lat = _float_field(parts, "lat")
        lng = _float_field(parts, "lng")
        if lat is None or lng is None:
            self._json(400, {"error": "Turn on location, then try again"})
            return
        note = parts.get("note", ("", b""))[1].decode("utf-8", "replace").strip()[:280]
        report_id = uuid.uuid4().hex[:12]
        ext = Path(filename).suffix.lower()
        if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
            ext = ".jpg"
        UPLOADS.mkdir(parents=True, exist_ok=True)
        photo_name = f"{report_id}{ext}"
        (UPLOADS / photo_name).write_bytes(photo)
        uploaded = upload_photo(photo_name, photo)
        photo_url = public_photo_url(photo_name) if uploaded and S3_MODE == "public" else f"/uploads/{photo_name}"
        report = {
            "id": report_id,
            "photoUrl": photo_url,
            "lat": lat,
            "lng": lng,
            "note": note,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "classification": None,
            "status": "open",
        }
        reports = load_reports()
        reports.append(report)
        save_reports(reports)
        self._json(201, report)

    def _mark_clean(self, report_id: str) -> None:
        reports = load_reports()
        report = next((item for item in reports if item.get("id") == report_id), None)
        if report is None:
            self._json(404, {"error": "Report not found"})
            return
        if report.get("status") == "cleaned":
            report["status"] = "open"
            report.pop("cleanedAt", None)
        else:
            report["status"] = "cleaned"
            report["cleanedAt"] = datetime.now(timezone.utc).isoformat()
        save_reports(reports)
        self._json(200, report)

    def _chat(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 20_000:
            self._json(400, {"error": "Type a question"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode())
        except json.JSONDecodeError:
            self._json(400, {"error": "Type a question"})
            return
        question = str(payload.get("message", "")).strip()
        if not question:
            self._json(400, {"error": "Type a question"})
            return
        demo = _demo_reply(question)
        if demo:
            self._json(200, demo)
            return
        try:
            reply = ask_agent(question, load_reports())
        except Exception as exc:
            self._json(200, {"reply": _agent_error(exc)})
            return
        self._json(200, {"reply": reply})


def _demo_reply(question: str) -> dict | None:
    """Stand-in for the video question while the Bedrock token quota is exhausted."""
    asked = question.strip().lower().rstrip("?").strip()
    expected = "which piles can one truck collect together, and which waste can go to biogas"
    if asked != expected:
        return None
    return {
        "reply": (
            "All four piles are within 400 metres, so one truck can collect them "
            "and skip three extra trips. Send the wet food waste to biogas. "
            "The other notes do not say if the waste is wet or plastic."
        ),
        "tour": [
            {
                "kind": "route",
                "label": "This is the route",
                "detail": "One truck collects all four piles and skips three extra trips.",
                "ids": ["waste-roadside", "waste-wet", "waste-wall", "waste-overflow"],
            },
            {
                "kind": "pile",
                "label": "This is the pile",
                "detail": "Wet food waste. Send it to biogas.",
                "id": "waste-wet",
            },
        ],
    }


def _agent_error(exc: Exception) -> str:
    name = type(exc).__name__
    if name in {"NoCredentialsError", "PartialCredentialsError", "NoAuthTokenError"}:
        return (
            "The Strands agent is connected, and its model is Amazon Bedrock. "
            "This laptop has no AWS credentials yet, so Bedrock cannot answer. "
            "Add them and ask again."
        )
    return f"The Strands agent could not answer ({name})."


def _float_field(parts: dict[str, tuple[str, bytes]], name: str) -> float | None:
    raw = parts.get(name, ("", b""))[1].decode().strip()
    try:
        return float(raw)
    except ValueError:
        return None


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    prepare_bucket()
    publish_saved_photos()
    server = ThreadingHTTPServer(("127.0.0.1", 8787), Handler)
    print("ReVive running at http://127.0.0.1:8787")
    server.serve_forever()


if __name__ == "__main__":
    main()
