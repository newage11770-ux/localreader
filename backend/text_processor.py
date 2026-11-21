"""Verbatim text chunking and optional Markdown formatting cleaner."""

from __future__ import annotations

import re


# Matches markdown link syntax [label](url) -> keeps label verbatim
_MD_LINK_RE = re.compile(r"!?\[([^\]]+)\]\(([^)]+)\)")
# Matches fenced code markers like ```python or ```
_MD_FENCE_RE = re.compile(r"^[ \t]*`{3,}[a-zA-Z0-9_+-]*[ \t]*$", re.MULTILINE)
# Matches ATX headings: ### Heading -> Heading
_MD_HEADING_RE = re.compile(r"^[ \t]*#{1,6}[ \t]+", re.MULTILINE)
# Matches blockquote prefixes: > > text -> text
_MD_QUOTE_RE = re.compile(r"^[ \t]*(?:>[ \t]*)+", re.MULTILINE)
# Matches horizontal rules: ---, ***, ___
_MD_HR_RE = re.compile(r"^[ \t]*(?:[-*_][ \t]*){3,}$", re.MULTILINE)
# Matches unordered list bullets at start of line: - item, * item, + item, • item
_MD_BULLET_RE = re.compile(r"^([ \t]*)(?:[-*+•])[ \t]+", re.MULTILINE)
# Matches inline formatting wrappers while preserving every word inside
_MD_BOLD_ITALIC_RE = re.compile(r"(\*{1,3}|_{1,3}|~~)(?=\S)(.+?)(?<=\S)\1")
# Matches inline backticks `code` -> code
_MD_INLINE_CODE_RE = re.compile(r"`+([^`]+)`+")
# Matches markdown table divider rows like | --- | :---: |
_MD_TABLE_SEP_RE = re.compile(r"^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?[ \t]*$", re.MULTILINE)


def strip_markdown_symbols(text: str) -> str:
    """
    Remove Markdown formatting punctuation (**, ###, backticks, etc.)
    while preserving 100% of actual words verbatim in original order.
    """
    if not text:
        return ""

    out = text.replace("\r\n", "\n").replace("\r", "\n")
    out = _MD_TABLE_SEP_RE.sub("", out)
    out = _MD_FENCE_RE.sub("", out)
    out = _MD_HR_RE.sub("", out)
    out = _MD_HEADING_RE.sub("", out)
    out = _MD_QUOTE_RE.sub("", out)
    out = _MD_BULLET_RE.sub(r"\1", out)
    out = _MD_LINK_RE.sub(r"\1", out)
    out = _MD_INLINE_CODE_RE.sub(r"\1", out)

    # Apply bold/italic/strikethrough stripping twice to handle nested ***bold italic***
    for _ in range(2):
        out = _MD_BOLD_ITALIC_RE.sub(r"\2", out)

    # Remove stray leftover markdown ticks/hashes/asterisks used purely as formatting markers
    out = re.sub(r"(?<!\w)[`*~]+(?=\w)", "", out)
    out = re.sub(r"(?<=\w)[`*~]+(?!\w)", "", out)
    out = re.sub(r"[ \t]*\|[ \t]*", ", ", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def has_speakable_content(text: str) -> bool:
    """Return True if the text contains at least one alphanumeric or CJK character."""
    return bool(re.search(r"[\w\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]", text, re.UNICODE))


def split_text_for_export(text: str, max_chars: int = 1400) -> list[str]:
    """
    Split arbitrarily long text into clean paragraph/sentence chunks
    without skipping or modifying a single word.
    """
    if not text or not text.strip():
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text.strip()) if p.strip()]
    chunks: list[str] = []

    for para in paragraphs:
        if len(para) <= max_chars:
            if has_speakable_content(para):
                chunks.append(para)
            continue

        # Split long paragraphs at sentence boundaries first
        sentences = re.split(r"(?<=[.!?…])\s+(?=[^\s])", para)
        current = ""
        for sent in sentences:
            sent = sent.strip()
            if not sent:
                continue
            if len(sent) > max_chars:
                # Flush current buffer first
                if current and has_speakable_content(current):
                    chunks.append(current)
                    current = ""
                # Split giant single sentence at clauses or word boundaries
                words = sent.split()
                piece = ""
                for w in words:
                    candidate = f"{piece} {w}".strip()
                    if len(candidate) > max_chars and piece:
                        if has_speakable_content(piece):
                            chunks.append(piece)
                        piece = w
                    else:
                        piece = candidate
                if piece and has_speakable_content(piece):
                    chunks.append(piece)
                continue

            candidate = f"{current} {sent}".strip()
            if len(candidate) > max_chars and current:
                if has_speakable_content(current):
                    chunks.append(current)
                current = sent
            else:
                current = candidate

        if current and has_speakable_content(current):
            chunks.append(current)

    return chunks
