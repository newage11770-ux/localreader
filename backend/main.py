"""FastAPI backend server for LocalReader — Studio-grade local TTS reader."""

from __future__ import annotations

import os
import re
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .network_utils import generate_qr_png_bytes, get_network_info
from .pdf_extractor import extract_document
from .tts_engine import (
    DEFAULT_VOICE,
    export_full_mp3,
    get_available_voices,
    synthesize_chunk,
)


ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
IS_DOCKER = (
    os.environ.get("LOCALREADER_DOCKER") == "1"
    or Path("/.dockerenv").exists()
    or bool(os.environ.get("SPACE_ID"))
)
DEFAULT_PORT = int(
    os.environ.get("LOCALREADER_PORT")
    or os.environ.get("PORT")
    or ("7860" if IS_DOCKER else "8765")
)


def _resolve_exports_dir() -> Path:
    """Use /tmp in Docker / Hugging Face Spaces (non-root UID 1000 safe) and local temp otherwise."""
    target = (
        Path("/tmp/localreader_exports")
        if IS_DOCKER
        else Path(tempfile.gettempdir()) / "localreader_exports"
    )
    try:
        target.mkdir(parents=True, exist_ok=True)
        return target
    except OSError:
        fallback = Path(tempfile.gettempdir())
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


EXPORTS_DIR = _resolve_exports_dir()


def _detect_public_url(request: Request | None = None) -> str | None:
    """Return the public HTTPS URL when running on Hugging Face Spaces or behind a reverse proxy."""
    space_host = (os.environ.get("SPACE_HOST") or "").strip()
    if space_host:
        return space_host if space_host.startswith("http") else f"https://{space_host}"

    if request is not None:
        host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").strip()
        hostname = host.split(":")[0].lower()
        if host and (
            hostname.endswith(".hf.space")
            or (IS_DOCKER and hostname not in ("localhost", "127.0.0.1", "0.0.0.0"))
        ):
            proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "https").split(",")[0].strip()
            return f"{proto}://{host}"
    return None


class TTSChunkRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Exact verbatim text chunk to synthesize")
    voice: str = Field(default=DEFAULT_VOICE, description="Microsoft Edge Neural voice ShortName")
    rate: str = Field(default="+0%", description="Speech rate string, e.g., +0%, +25%, -15%")
    chunk_index: int = Field(default=0, ge=0)


class TTSExportRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Full verbatim text to export as MP3")
    voice: str = Field(default=DEFAULT_VOICE)
    speed: float = Field(default=1.0, ge=0.5, le=2.5)
    skip_markdown: bool = Field(default=False)
    filename: str = Field(default="LocalReader_Audio.mp3")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    public_url = _detect_public_url()
    print("\n" + "=" * 64)
    print("  LocalReader Studio TTS Server")
    print("=" * 64)
    if IS_DOCKER:
        print(f"  Mode        : Docker / Hugging Face Spaces (port {DEFAULT_PORT})")
        if public_url:
            print(f"  Public URL  : {public_url}")
        print(f"  Exports Dir : {EXPORTS_DIR}")
    else:
        net = get_network_info(port=DEFAULT_PORT)
        print(f"  PC Desktop  : http://127.0.0.1:{DEFAULT_PORT}")
        print(f"  iPhone Wi-Fi: {net['url']}")
        print("-" * 64)
        print("  If your iPhone cannot connect over Wi-Fi, run in PowerShell (Admin):")
        print(f"  {net['firewall_command']}")
    print("=" * 64 + "\n")
    yield


app = FastAPI(
    title="LocalReader Studio TTS",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "app": "LocalReader", "version": "1.0.0"}


@app.get("/api/voices")
async def list_voices(refresh: bool = Query(default=False)) -> dict[str, Any]:
    return await get_available_voices(force_refresh=refresh)


@app.post("/api/tts/chunk")
async def tts_chunk(req: TTSChunkRequest) -> dict[str, Any]:
    try:
        result = await synthesize_chunk(
            text=req.text,
            voice=req.voice,
            rate=req.rate,
        )
        return {
            **result,
            "chunk_index": req.chunk_index,
            "voice": req.voice,
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


@app.post("/api/tts/export")
async def tts_export(req: TTSExportRequest) -> FileResponse:
    try:
        mp3_bytes = await export_full_mp3(
            text=req.text,
            voice=req.voice,
            speed=req.speed,
            skip_markdown=req.skip_markdown,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    safe_name = re.sub(r"[^a-zA-Z0-9._ -]+", "_", req.filename.strip() or "LocalReader_Audio.mp3")
    if not safe_name.lower().endswith(".mp3"):
        safe_name = f"{safe_name}.mp3"

    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = EXPORTS_DIR / f"export_{uuid.uuid4().hex}.mp3"
    tmp_path.write_bytes(mp3_bytes)

    return FileResponse(
        path=tmp_path,
        media_type="audio/mpeg",
        filename=safe_name,
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}"',
            "Cache-Control": "no-store",
        },
        background=BackgroundTask(_safe_unlink, tmp_path),
    )


@app.post("/api/extract")
async def extract_file(file: UploadFile = File(...)) -> dict[str, Any]:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    try:
        return extract_document(file.filename or "document.txt", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {exc}") from exc


@app.get("/api/network-info")
async def network_info(
    request: Request,
    port: int = Query(default=DEFAULT_PORT, ge=1, le=65535),
) -> dict[str, Any]:
    return get_network_info(port=port, public_url=_detect_public_url(request))


@app.get("/api/network-info/qr.png")
async def network_qr_png(
    request: Request,
    url: str | None = Query(default=None),
    port: int = Query(default=DEFAULT_PORT, ge=1, le=65535),
) -> Response:
    target = (
        url.strip()
        if url
        else get_network_info(port=port, public_url=_detect_public_url(request))["url"]
    )
    png_bytes = generate_qr_png_bytes(target)
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


# PWA & Root Frontend routes
@app.get("/", include_in_schema=False)
async def serve_index() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "index.html",
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/manifest.json", include_in_schema=False)
async def serve_manifest() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "manifest.json",
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/sw.js", include_in_schema=False)
async def serve_sw() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "sw.js",
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/apple-touch-icon.png", include_in_schema=False)
@app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
async def serve_apple_touch_icon() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "icons" / "apple-touch-icon.png",
        media_type="image/png",
    )


@app.get("/favicon.svg", include_in_schema=False)
async def serve_favicon_svg() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "icons" / "favicon.svg",
        media_type="image/svg+xml",
    )


# Mount static frontend asset directories
if (FRONTEND_DIR / "css").exists():
    app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
if (FRONTEND_DIR / "js").exists():
    app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
if (FRONTEND_DIR / "icons").exists():
    app.mount("/icons", StaticFiles(directory=FRONTEND_DIR / "icons"), name="icons")


def run() -> None:
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=DEFAULT_PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    run()
