"""Verbatim document extraction for .pdf, .txt, and .md files."""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

from pypdf import PdfReader


SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".markdown"}


def _decode_text_bytes(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _clean_pdf_page_text(text: str) -> str:
    """Clean control characters while keeping 100% of words intact verbatim."""
    if not text:
        return ""
    text = text.replace("\x00", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Collapse 3+ blank lines to 2 so paragraphs stay readable without dropping words
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_document(filename: str, content: bytes) -> dict[str, Any]:
    """Extract 100% verbatim text from an uploaded PDF, TXT, or Markdown file."""
    ext = Path(filename or "document.txt").suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type '{ext}'. Please upload a .pdf, .txt, or .md file."
        )

    pages = 1
    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:
                raise ValueError(
                    "This PDF is password-protected and cannot be read."
                ) from exc

        pages = len(reader.pages)
        page_texts: list[str] = []
        for page in reader.pages:
            raw_page = page.extract_text() or ""
            cleaned = _clean_pdf_page_text(raw_page)
            if cleaned:
                page_texts.append(cleaned)

        full_text = "\n\n".join(page_texts)
        if not full_text.strip():
            raise ValueError(
                "No selectable text was found in this PDF (it may be a scanned image PDF)."
            )
    else:
        raw_text = _decode_text_bytes(content)
        full_text = raw_text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")

    words = [w for w in re.split(r"\s+", full_text.strip()) if w]
    return {
        "filename": Path(filename).name if filename else "document",
        "extension": ext,
        "text": full_text,
        "pages": pages,
        "word_count": len(words),
        "char_count": len(full_text),
    }
