"""Local karaoke server.

Serves the web UI from ./static plus a small API:

    GET /api/search?q=<query>&n=<count>   search YouTube with yt-dlp (no API key)
    GET /api/prepare?id=<videoId>[&force=file]
        Decide how the TV should play a video. If YouTube allows embedding,
        returns {"mode": "embed"}. Otherwise (e.g. Sing King, KaraFun) it
        downloads the video into ./cache in the background and returns
        {"mode": "file", "status": "downloading"|"ready"|"error", "progress": 0..1}.
    GET /media/<videoId>.mp4              a downloaded video (supports seeking)
    GET /api/counter, POST /api/counter   read / bump the songs-played counter (data/counter.json)

Run with:  ./run.sh   (or .venv/bin/python server.py)
"""

import argparse
import json
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yt_dlp

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CACHE_DIR = ROOT / "cache"
CACHE_MAX_AGE_DAYS = 60
MAX_RESULTS = 30
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

# H.264 first so the file plays in every browser; cap at 720p to keep downloads quick.
DOWNLOAD_FORMAT = (
    "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/"
    "bv*[height<=720][ext=mp4]+ba[ext=m4a]/"
    "b[height<=720][ext=mp4]/b"
)
HAVE_FFMPEG = shutil.which("ffmpeg") is not None
if not HAVE_FFMPEG:  # can't merge separate video+audio streams; use single-file formats
    DOWNLOAD_FORMAT = "b[height<=720][ext=mp4]/b[ext=mp4]/b"


# ---------------------------------------------------------------- search
@lru_cache(maxsize=256)
def search_youtube(query: str, n: int) -> tuple:
    opts = {"extract_flat": True, "quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{n}:{query}", download=False)
    results = []
    for e in info.get("entries") or []:
        vid = e.get("id")
        if not vid or not VIDEO_ID.match(vid):  # skip channels/playlists
            continue
        results.append(
            {
                "id": vid,
                "title": e.get("title") or "",
                "channel": e.get("channel") or e.get("uploader") or "",
                "duration": e.get("duration"),
            }
        )
    return tuple(results)


# ---------------------------------------------------------------- embed check
_embed_cache: dict[str, bool] = {}


def embeddable(video_id: str) -> bool:
    """YouTube's oEmbed endpoint answers 401 when the uploader disabled embedding."""
    if video_id in _embed_cache:
        return _embed_cache[video_id]
    url = f"https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v={video_id}"
    try:
        with urllib.request.urlopen(url, timeout=8):
            ok = True
    except urllib.error.HTTPError as e:
        ok = e.code not in (401, 403)
    except Exception:
        ok = True  # network hiccup: try embedding; the TV reports back if it fails
    _embed_cache[video_id] = ok
    return ok


# ---------------------------------------------------------------- downloads
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_download_slots = threading.Semaphore(2)


def media_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.mp4"


def _download(video_id: str):
    job = _jobs[video_id]

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                # Two streams (video then audio) are fetched; count each as half.
                part = 0.5 if job.get("_second_stream") else 0.0
                job["progress"] = min(0.99, part + (d.get("downloaded_bytes", 0) / total) * (0.5 if HAVE_FFMPEG else 1))
        elif d.get("status") == "finished":
            job["_second_stream"] = True

    opts = {
        "format": DOWNLOAD_FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": str(CACHE_DIR / "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "overwrites": True,
    }
    with _download_slots:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            if not media_path(video_id).exists():
                raise RuntimeError("download finished but no mp4 was produced")
            job.update(status="ready", progress=1.0)
            print(f"downloaded {video_id}")
        except Exception as exc:
            job.update(status="error", error=str(exc).splitlines()[0][:300])
            print(f"download failed {video_id}: {exc}")


def prepare(video_id: str, force_file: bool) -> dict:
    if media_path(video_id).exists():
        return {"mode": "file", "status": "ready", "progress": 1.0}
    if not force_file and embeddable(video_id):
        return {"mode": "embed"}
    with _jobs_lock:
        job = _jobs.get(video_id)
        if job is None or job["status"] == "error" and force_file:
            job = _jobs[video_id] = {"status": "downloading", "progress": 0.0}
            threading.Thread(target=_download, args=(video_id,), daemon=True).start()
    out = {"mode": "file", "status": job["status"], "progress": round(job["progress"], 3)}
    if job.get("error"):
        out["error"] = job["error"]
    return out


# ---------------------------------------------------------------- song counter
# The "u r visitor #000028" counter: goes up by one every time a song starts playing.
COUNTER_FILE = ROOT / "data" / "counter.json"
COUNTER_START = 0
_counter_lock = threading.Lock()


def read_counter() -> int:
    try:
        return int(json.loads(COUNTER_FILE.read_text())["count"])
    except (OSError, ValueError, KeyError, TypeError):
        return COUNTER_START


def bump_counter() -> int:
    with _counter_lock:
        count = read_counter() + 1
        COUNTER_FILE.parent.mkdir(exist_ok=True)
        tmp = COUNTER_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"count": count}))
        tmp.replace(COUNTER_FILE)
        return count


def clean_cache():
    CACHE_DIR.mkdir(exist_ok=True)
    cutoff = time.time() - CACHE_MAX_AGE_DAYS * 86400
    for f in CACHE_DIR.iterdir():
        if f.is_file() and (f.suffix != ".mp4" or f.stat().st_mtime < cutoff):
            f.unlink(missing_ok=True)  # leftovers from interrupted downloads, or old songs


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):  # quiet, except for search
        if self.path.startswith("/api/search"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        params = parse_qs(url.query)
        if url.path == "/api/search":
            return self._search(params)
        if url.path == "/api/prepare":
            vid = (params.get("id") or [""])[0]
            if not VIDEO_ID.match(vid):
                return self._json(400, {"error": "bad id"})
            return self._json(200, prepare(vid, force_file=(params.get("force") or [""])[0] == "file"))
        if url.path == "/api/counter":
            return self._json(200, {"count": read_counter()})
        m = re.fullmatch(r"/media/([A-Za-z0-9_-]{11})\.mp4", url.path)
        if m:
            return self._media(media_path(m.group(1)))
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path == "/api/counter":
            return self._json(200, {"count": bump_counter()})
        self.send_error(404)

    def _search(self, params):
        query = (params.get("q") or [""])[0].strip()
        try:
            n = max(1, min(MAX_RESULTS, int((params.get("n") or ["20"])[0])))
        except ValueError:
            n = 20
        if not query:
            return self._json(400, {"error": "missing q"})
        try:
            t0 = time.time()
            results = list(search_youtube(query, n))
            self.log_message("search %r -> %d results in %.1fs", query, len(results), time.time() - t0)
            return self._json(200, {"results": results})
        except Exception as exc:
            return self._json(502, {"error": f"search failed: {exc}"})

    def _media(self, path: Path):
        """Serve an mp4 with HTTP Range support so the <video> element can seek."""
        if not path.exists():
            return self.send_error(404)
        size = path.stat().st_size
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:  # suffix range: last N bytes
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                return self.end_headers()
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = end - start + 1
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        try:
            with path.open("rb") as f:
                f.seek(start)
                while length > 0:
                    chunk = f.read(min(256 * 1024, length))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    length -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser cancelled (normal when seeking)

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Local karaoke machine")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="don't open the control panel")
    args = parser.parse_args()

    clean_cache()
    if not HAVE_FFMPEG:
        print("Note: ffmpeg not found; downloaded videos may be lower quality (brew install ffmpeg).")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    url = f"http://localhost:{args.port}/"
    print(f"Karaoke machine running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
