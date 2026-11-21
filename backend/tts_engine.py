"""Microsoft Edge Neural TTS engine with WordBoundary timestamps and MP3 export."""

from __future__ import annotations

import asyncio
import base64
from collections import OrderedDict
import socket
import time
from typing import Any

import aiohttp
import edge_tts

from .text_processor import (
    has_speakable_content,
    split_text_for_export,
    strip_markdown_symbols,
)


DEFAULT_VOICE = "en-US-AndrewMultilingualNeural"

PINNED_VOICES: list[dict[str, str]] = [
    {
        "short_name": "en-US-AndrewMultilingualNeural",
        "display_name": "Andrew Multilingual (US)",
        "description": "Default · Warm, clear male",
        "locale": "en-US",
        "gender": "Male",
        "flag": "🇺🇸",
    },
    {
        "short_name": "en-US-AvaMultilingualNeural",
        "display_name": "Ava Multilingual (US)",
        "description": "Natural female",
        "locale": "en-US",
        "gender": "Female",
        "flag": "🇺🇸",
    },
    {
        "short_name": "en-US-BrianMultilingualNeural",
        "display_name": "Brian Multilingual (US)",
        "description": "Deep, calm male",
        "locale": "en-US",
        "gender": "Male",
        "flag": "🇺🇸",
    },
    {
        "short_name": "en-GB-SoniaNeural",
        "display_name": "Sonia (UK)",
        "description": "Crisp British female",
        "locale": "en-GB",
        "gender": "Female",
        "flag": "🇬🇧",
    },
    {
        "short_name": "en-GB-RyanNeural",
        "display_name": "Ryan (UK)",
        "description": "British male",
        "locale": "en-GB",
        "gender": "Male",
        "flag": "🇬🇧",
    },
    {
        "short_name": "en-NG-AbeoNeural",
        "display_name": "Abeo (Nigeria)",
        "description": "Nigerian English male",
        "locale": "en-NG",
        "gender": "Male",
        "flag": "🇳🇬",
    },
    {
        "short_name": "en-NG-EzinneNeural",
        "display_name": "Ezinne (Nigeria)",
        "description": "Nigerian English female",
        "locale": "en-NG",
        "gender": "Female",
        "flag": "🇳🇬",
    },
]

_PINNED_MAP = {v["short_name"]: idx for idx, v in enumerate(PINNED_VOICES)}


class ChunkLRUCache:
    """Thread/async-safe bounded in-memory LRU cache for synthesized audio chunks."""

    def __init__(self, max_items: int = 64) -> None:
        self._max_items = max_items
        self._store: OrderedDict[tuple[str, str, str], dict[str, Any]] = OrderedDict()

    def get(self, key: tuple[str, str, str]) -> dict[str, Any] | None:
        item = self._store.get(key)
        if item is not None:
            self._store.move_to_end(key)
        return item

    def set(self, key: tuple[str, str, str], value: dict[str, Any]) -> None:
        self._store[key] = value
        self._store.move_to_end(key)
        while len(self._store) > self._max_items:
            self._store.popitem(last=False)


_chunk_cache = ChunkLRUCache(max_items=64)
_voices_cache: dict[str, Any] = {"ts": 0.0, "data": None}
_VOICES_TTL_SECONDS = 1800.0


def speed_to_rate_str(speed: float) -> str:
    """Convert playback speed multiplier (0.75..2.0) to edge-tts rate string."""
    clamped = max(0.5, min(2.5, float(speed)))
    pct = int(round((clamped - 1.0) * 100))
    return f"+{pct}%" if pct >= 0 else f"{pct}%"


def _format_voice_entry(raw: dict[str, Any]) -> dict[str, Any]:
    short = raw.get("ShortName", "")
    locale = raw.get("Locale", "")
    gender = raw.get("Gender", "")
    friendly = raw.get("FriendlyName", short)

    # Clean up "Microsoft AndrewMultilingual Online (Natural) - English (United States)"
    clean_label = friendly.replace("Microsoft ", "").replace(" Online (Natural)", "")
    pinned_idx = _PINNED_MAP.get(short)
    if pinned_idx is not None:
        meta = PINNED_VOICES[pinned_idx]
        return {
            "short_name": short,
            "display_name": meta["display_name"],
            "description": meta["description"],
            "friendly_name": clean_label,
            "locale": locale or meta["locale"],
            "gender": gender or meta["gender"],
            "flag": meta["flag"],
            "pinned": True,
            "pin_order": pinned_idx,
        }

    return {
        "short_name": short,
        "display_name": clean_label,
        "description": f"{locale} · {gender}",
        "friendly_name": clean_label,
        "locale": locale,
        "gender": gender,
        "flag": "",
        "pinned": False,
        "pin_order": 9999,
    }


async def get_available_voices(force_refresh: bool = False) -> dict[str, Any]:
    """Return pinned top voices plus all searchable edge-tts neural voices."""
    now = time.monotonic()
    if (
        not force_refresh
        and _voices_cache["data"] is not None
        and (now - _voices_cache["ts"]) < _VOICES_TTL_SECONDS
    ):
        return _voices_cache["data"]

    try:
        try:
            raw_voices = await edge_tts.list_voices(
                connector=aiohttp.TCPConnector(family=socket.AF_INET)
            )
        except Exception:
            raw_voices = await edge_tts.list_voices()
        formatted = [_format_voice_entry(v) for v in raw_voices]
        # Ensure all 7 pinned voices appear even if upstream list changes slightly
        present = {v["short_name"] for v in formatted}
        for idx, meta in enumerate(PINNED_VOICES):
            if meta["short_name"] not in present:
                formatted.append(
                    {
                        "short_name": meta["short_name"],
                        "display_name": meta["display_name"],
                        "description": meta["description"],
                        "friendly_name": meta["display_name"],
                        "locale": meta["locale"],
                        "gender": meta["gender"],
                        "flag": meta["flag"],
                        "pinned": True,
                        "pin_order": idx,
                    }
                )

        pinned = sorted(
            [v for v in formatted if v["pinned"]],
            key=lambda v: v["pin_order"],
        )
        others = sorted(
            [v for v in formatted if not v["pinned"]],
            key=lambda v: (
                0 if v["locale"].startswith("en-") else 1,
                v["locale"],
                v["display_name"],
            ),
        )
        result = {
            "default_voice": DEFAULT_VOICE,
            "pinned": pinned,
            "others": others,
            "total": len(pinned) + len(others),
            "online": True,
        }
        _voices_cache["ts"] = now
        _voices_cache["data"] = result
        return result
    except Exception:
        # Offline fallback: still return pinned voice metadata so UI remains intact
        fallback_pinned = [
            {
                "short_name": meta["short_name"],
                "display_name": meta["display_name"],
                "description": meta["description"],
                "friendly_name": meta["display_name"],
                "locale": meta["locale"],
                "gender": meta["gender"],
                "flag": meta["flag"],
                "pinned": True,
                "pin_order": idx,
            }
            for idx, meta in enumerate(PINNED_VOICES)
        ]
        return {
            "default_voice": DEFAULT_VOICE,
            "pinned": fallback_pinned,
            "others": [],
            "total": len(fallback_pinned),
            "online": False,
        }


async def _collect_edge_stream(
    text: str,
    voice: str,
    rate: str,
    boundary_mode: str,
    connector: aiohttp.BaseConnector | None,
    timeout_sec: float,
) -> tuple[bytes, list[dict[str, Any]], str]:
    """Collect audio bytes and boundary metadata from one edge-tts stream."""
    comm = edge_tts.Communicate(
        text=text,
        voice=voice,
        rate=rate,
        boundary=boundary_mode,
        connector=connector,
        connect_timeout=min(8, max(3, int(timeout_sec))),
        receive_timeout=max(5, int(timeout_sec)),
    )
    audio_parts: list[bytes] = []
    boundaries: list[dict[str, Any]] = []
    detected_type = "WordBoundary"

    async for chunk in comm.stream():
        ctype = chunk.get("type")
        if ctype == "audio":
            data = chunk.get("data")
            if data:
                audio_parts.append(data)
        elif ctype in ("WordBoundary", "SentenceBoundary"):
            detected_type = ctype
            offset_ticks = chunk.get("offset", 0)
            duration_ticks = chunk.get("duration", 0)
            boundaries.append(
                {
                    "text": chunk.get("text", ""),
                    "offset_ms": round(offset_ticks / 10_000.0, 2),
                    "duration_ms": round(duration_ticks / 10_000.0, 2),
                }
            )

    audio_bytes = b"".join(audio_parts)
    if not audio_bytes:
        raise RuntimeError("No audio bytes received from edge-tts.")
    return audio_bytes, boundaries, detected_type


async def _stream_edge_tts(
    text: str,
    voice: str,
    rate: str = "+0%",
    with_boundaries: bool = True,
    retries: int = 2,
    timeout_sec: float = 10.0,
) -> tuple[bytes, list[dict[str, Any]], str]:
    """Run edge-tts Communicate.stream() with strict per-attempt timeout and retry resilience."""
    last_err: Exception | None = None
    boundary_mode = "WordBoundary" if with_boundaries else "SentenceBoundary"

    for attempt in range(retries + 1):
        # Prefer IPv4 connector on Windows to avoid IPv6 Happy-Eyeballs latency (~2.5x faster start);
        # fall back to system default connector on final retry for IPv6-only networks.
        connector = (
            aiohttp.TCPConnector(family=socket.AF_INET)
            if attempt < retries
            else None
        )
        try:
            return await asyncio.wait_for(
                _collect_edge_stream(
                    text=text,
                    voice=voice,
                    rate=rate,
                    boundary_mode=boundary_mode,
                    connector=connector,
                    timeout_sec=timeout_sec,
                ),
                timeout=timeout_sec,
            )
        except asyncio.TimeoutError:
            last_err = TimeoutError(f"edge-tts timed out after {timeout_sec:.0f}s")
            if attempt < retries:
                await asyncio.sleep(0.25 * (attempt + 1))
        except Exception as exc:
            last_err = exc
            if attempt < retries:
                await asyncio.sleep(0.25 * (attempt + 1))
        finally:
            if connector is not None and not connector.closed:
                await connector.close()

    raise RuntimeError(f"TTS synthesis failed after {retries + 1} attempts: {last_err}") from last_err


async def synthesize_chunk(
    text: str,
    voice: str = DEFAULT_VOICE,
    rate: str = "+0%",
) -> dict[str, Any]:
    """Synthesize a single chunk into MP3 bytes (base64) + exact WordBoundary timestamps."""
    cleaned = text.strip()
    if not cleaned or not has_speakable_content(cleaned):
        return {
            "audio_base64": "",
            "mime_type": "audio/mpeg",
            "boundaries": [],
            "boundary_type": "WordBoundary",
            "empty": True,
            "byte_length": 0,
        }

    cache_key = (cleaned, voice, rate)
    cached = _chunk_cache.get(cache_key)
    if cached is not None:
        return cached

    audio_bytes, boundaries, boundary_type = await _stream_edge_tts(
        text=cleaned,
        voice=voice,
        rate=rate,
        with_boundaries=True,
        retries=2,
        timeout_sec=10.0,
    )

    payload = {
        "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
        "mime_type": "audio/mpeg",
        "boundaries": boundaries,
        "boundary_type": boundary_type,
        "empty": False,
        "byte_length": len(audio_bytes),
    }
    _chunk_cache.set(cache_key, payload)
    return payload


async def export_full_mp3(
    text: str,
    voice: str = DEFAULT_VOICE,
    speed: float = 1.0,
    skip_markdown: bool = False,
) -> bytes:
    """
    Synthesize arbitrarily long text A-to-Z verbatim into one continuous MP3 file.
    Chunks run with bounded concurrency while preserving exact sequential order.
    """
    working_text = strip_markdown_symbols(text) if skip_markdown else text
    chunks = split_text_for_export(working_text, max_chars=1400)
    if not chunks:
        raise ValueError("No speakable text provided to export.")

    rate_str = speed_to_rate_str(speed)
    semaphore = asyncio.Semaphore(4)
    results: list[bytes] = [b""] * len(chunks)

    async def worker(idx: int, chunk_text: str) -> None:
        async with semaphore:
            audio_bytes, _bnds, _btype = await _stream_edge_tts(
                text=chunk_text,
                voice=voice,
                rate=rate_str,
                with_boundaries=False,
                retries=3,
                timeout_sec=20.0,
            )
            results[idx] = audio_bytes

    await asyncio.gather(*(worker(i, c) for i, c in enumerate(chunks)))
    return b"".join(results)
