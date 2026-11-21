/**
 * Verbatim Document Tokenizer, Adaptive Fast-Start Chunker,
 * and Monotonic WordBoundary Aligner for LocalReader.
 */
(function (global) {
  "use strict";

  const FIRST_CHUNK_MAX = 320;
  const NORMAL_CHUNK_MAX = 720;
  const HARD_CHUNK_MAX = 960;

  function normalizeWord(str) {
    return (str || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]/gi, "");
  }

  function extractSubparts(str) {
    const cleaned = (str || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
    const parts = cleaned.match(/[a-z0-9\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]+/gi);
    return parts ? parts : [];
  }

  function hasSpeakableChars(str) {
    return /[a-z0-9\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]/i.test(str || "");
  }

  /**
   * Tokenize a single paragraph string into displayable words while preserving
   * exact single-line breaks inside the paragraph (e.g., lists / poems / headings).
   */
  function tokenizeParagraph(paraText) {
    const lines = paraText.split(/\n/);
    const tokens = [];

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const regex = /\S+/g;
      let match;
      let lineTokens = [];
      while ((match = regex.exec(line)) !== null) {
        lineTokens.push({
          text: match[0],
          norm: normalizeWord(match[0]),
          subparts: extractSubparts(match[0]),
          lineBreakAfter: false,
        });
      }
      if (lineTokens.length > 0 && li < lines.length - 1) {
        lineTokens[lineTokens.length - 1].lineBreakAfter = true;
      }
      for (const t of lineTokens) {
        tokens.push(t);
      }
    }
    return tokens;
  }

  function isSentenceEnd(tokenText) {
    return /[.!?…]["')\]”’]*$/.test(tokenText);
  }

  function isClauseEnd(tokenText) {
    return /[,;:—–-]["')\]”’]*$/.test(tokenText);
  }

  /**
   * Build the complete verbatim document model:
   * - paragraphs[] for navigation and book-style rendering
   * - chunks[] for fast-start instant streaming & prefetching
   * - words[] flat master array with 1-to-1 DOM span indices
   */
  function buildDocumentModel(rawText, skipMarkdown) {
    const workingText = skipMarkdown
      ? global.LocalReaderMarkdown.stripMarkdownSymbols(rawText || "")
      : (rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const trimmed = workingText.trim();
    if (!trimmed) {
      return {
        rawText: rawText || "",
        workingText: "",
        paragraphs: [],
        chunks: [],
        words: [],
        wordCount: 0,
        charCount: 0,
      };
    }

    const rawParas = trimmed
      .split(/\n[ \t]*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const paragraphs = [];
    const chunks = [];
    const words = [];

    let globalWordIdx = 0;

    function pushChunk(chunkWordSlice, paraIdx) {
      if (!chunkWordSlice.length) return;
      const chunkId = chunks.length;
      let textParts = [];
      let charCursor = 0;

      for (let i = 0; i < chunkWordSlice.length; i++) {
        const w = chunkWordSlice[i];
        w.chunkIndex = chunkId;
        w.charStart = charCursor;
        w.charEnd = charCursor + w.text.length;
        textParts.push(w.text);
        charCursor += w.text.length + 1;
      }

      const chunkText = textParts.join(" ");
      chunks.push({
        id: chunkId,
        paragraphIndex: paraIdx,
        text: chunkText,
        speakable: hasSpeakableChars(chunkText),
        words: chunkWordSlice,
        startWordIndex: chunkWordSlice[0].wordIndex,
        endWordIndex: chunkWordSlice[chunkWordSlice.length - 1].wordIndex,
      });
    }

    for (let pIdx = 0; pIdx < rawParas.length; pIdx++) {
      const tokens = tokenizeParagraph(rawParas[pIdx]);
      if (!tokens.length) continue;

      const paraStartWord = globalWordIdx;
      const paraStartChunk = chunks.length;
      const paraWords = [];

      for (const tok of tokens) {
        const wordObj = {
          wordIndex: globalWordIdx++,
          paragraphIndex: pIdx,
          chunkIndex: -1,
          text: tok.text,
          norm: tok.norm,
          subparts: tok.subparts,
          lineBreakAfter: tok.lineBreakAfter,
          charStart: 0,
          charEnd: 0,
        };
        words.push(wordObj);
        paraWords.push(wordObj);
      }

      // Group paragraph words into natural sentence-bounded chunks.
      // Chunk 0 uses a smaller ceiling (FIRST_CHUNK_MAX) so playback begins in ~1s!
      let currentBuf = [];
      let currentLen = 0;

      // Split into sentence units first
      const sentences = [];
      let curSent = [];
      for (const w of paraWords) {
        curSent.push(w);
        if (isSentenceEnd(w.text) || w.lineBreakAfter) {
          sentences.push(curSent);
          curSent = [];
        }
      }
      if (curSent.length) {
        sentences.push(curSent);
      }

      for (const sent of sentences) {
        const sentLen = sent.reduce((acc, w) => acc + w.text.length + 1, 0);
        const maxLen = chunks.length === 0 ? FIRST_CHUNK_MAX : NORMAL_CHUNK_MAX;

        // Handle unusually huge single sentence (> HARD_CHUNK_MAX) cleanly at clause/word bounds
        if (sentLen > maxLen && currentBuf.length > 0) {
          pushChunk(currentBuf, pIdx);
          currentBuf = [];
          currentLen = 0;
        }

        const effectiveMax = chunks.length === 0 ? FIRST_CHUNK_MAX : HARD_CHUNK_MAX;
        if (sentLen > effectiveMax) {
          let subBuf = [];
          let subLen = 0;
          let lastClauseBreak = -1;
          for (let i = 0; i < sent.length; i++) {
            const w = sent[i];
            subBuf.push(w);
            subLen += w.text.length + 1;
            if (isClauseEnd(w.text)) {
              lastClauseBreak = subBuf.length;
            }
            const limit = chunks.length === 0 ? FIRST_CHUNK_MAX : NORMAL_CHUNK_MAX;
            if (subLen >= limit) {
              if (lastClauseBreak > Math.floor(subBuf.length * 0.45)) {
                const head = subBuf.slice(0, lastClauseBreak);
                const tail = subBuf.slice(lastClauseBreak);
                pushChunk(head, pIdx);
                subBuf = tail;
                subLen = subBuf.reduce((acc, x) => acc + x.text.length + 1, 0);
                lastClauseBreak = -1;
              } else {
                pushChunk(subBuf, pIdx);
                subBuf = [];
                subLen = 0;
                lastClauseBreak = -1;
              }
            }
          }
          if (subBuf.length) {
            currentBuf = subBuf;
            currentLen = subLen;
          }
          continue;
        }

        if (currentLen + sentLen > maxLen && currentBuf.length > 0) {
          pushChunk(currentBuf, pIdx);
          currentBuf = sent.slice();
          currentLen = sentLen;
        } else {
          for (const w of sent) currentBuf.push(w);
          currentLen += sentLen;
        }
      }

      if (currentBuf.length) {
        pushChunk(currentBuf, pIdx);
      }

      paragraphs.push({
        index: pIdx,
        startWordIndex: paraStartWord,
        endWordIndex: globalWordIdx - 1,
        startChunkIndex: paraStartChunk,
        words: paraWords,
      });
    }

    return {
      rawText: rawText || "",
      workingText: trimmed,
      paragraphs,
      chunks,
      words,
      wordCount: words.length,
      charCount: trimmed.length,
    };
  }

  /**
   * Build a sub-chunk slice starting at a specific word within a chunk
   * (used for instant Click-to-Jump to any exact word!).
   */
  function createTailSlice(chunk, startWordIndex) {
    const startOffset = chunk.words.findIndex((w) => w.wordIndex === startWordIndex);
    if (startOffset <= 0) {
      return {
        chunkId: chunk.id,
        isTail: false,
        text: chunk.text,
        speakable: chunk.speakable,
        words: chunk.words,
        startWordIndex: chunk.startWordIndex,
      };
    }

    const sliceWords = chunk.words.slice(startOffset);
    let charCursor = 0;
    const mapped = sliceWords.map((w) => {
      const copy = {
        ...w,
        charStart: charCursor,
        charEnd: charCursor + w.text.length,
      };
      charCursor += w.text.length + 1;
      return copy;
    });
    const text = mapped.map((w) => w.text).join(" ");
    return {
      chunkId: chunk.id,
      isTail: true,
      text,
      speakable: hasSpeakableChars(text),
      words: mapped,
      startWordIndex,
    };
  }

  /**
   * Align edge-tts WordBoundary (or fallback SentenceBoundary / duration)
   * to exact master wordIndex values with monotonic zero-drift tracking.
   */
  function alignBoundariesToWords(boundaries, chunkWords, boundaryType, fallbackDurationMs) {
    if (!chunkWords || !chunkWords.length) return [];

    // Fallback: if no WordBoundary timestamps arrived (or only SentenceBoundary),
    // synthesize smooth character-weighted word timings across the audio duration.
    if (!boundaries || boundaries.length === 0 || boundaryType === "SentenceBoundary") {
      const totalDuration =
        fallbackDurationMs && fallbackDurationMs > 0
          ? fallbackDurationMs
          : Math.max(800, chunkWords.length * 360);
      const weights = chunkWords.map((w) => Math.max(2, w.text.length));
      const sumWeights = weights.reduce((a, b) => a + b, 0) || 1;
      let elapsed = 0;
      return chunkWords.map((w, i) => {
        const dur = (weights[i] / sumWeights) * totalDuration;
        const entry = {
          wordIndex: w.wordIndex,
          offset_ms: elapsed,
          duration_ms: dur,
          text: w.text,
        };
        elapsed += dur;
        return entry;
      });
    }

    const aligned = [];
    let wordCursor = 0;
    let subPartCursor = 0;

    for (let b = 0; b < boundaries.length; b++) {
      const bnd = boundaries[b];
      const bNorm = normalizeWord(bnd.text);
      const bParts = extractSubparts(bnd.text);

      let matchedIdx = -1;

      if (bNorm) {
        const maxLook = Math.min(chunkWords.length - 1, wordCursor + 6);
        for (let k = wordCursor; k <= maxLook; k++) {
          const w = chunkWords[k];
          if (!w.norm) continue;

          // Exact normalized match
          if (w.norm === bNorm) {
            matchedIdx = k;
            wordCursor = k + 1;
            subPartCursor = 0;
            break;
          }

          // Multi-part token (e.g., "real-time", "don't", "v2.0")
          if (w.subparts.length > 1) {
            const startSub = k === wordCursor ? subPartCursor : 0;
            const subIdx = w.subparts.indexOf(bNorm, startSub);
            if (subIdx !== -1) {
              matchedIdx = k;
              if (subIdx + 1 < w.subparts.length) {
                wordCursor = k;
                subPartCursor = subIdx + 1;
              } else {
                wordCursor = k + 1;
                subPartCursor = 0;
              }
              break;
            }
          }

          // Prefix / containment match (e.g., boundary "cant" vs word "cannot", or punctuation)
          if (
            bNorm.length >= 2 &&
            (w.norm.startsWith(bNorm) || bNorm.startsWith(w.norm))
          ) {
            matchedIdx = k;
            if (bNorm.length >= w.norm.length) {
              wordCursor = k + 1;
              subPartCursor = 0;
            } else {
              wordCursor = k;
            }
            break;
          }

          // If boundary itself contains multiple subparts matching this word
          if (bParts.length > 1 && bParts.includes(w.norm)) {
            matchedIdx = k;
            wordCursor = k + 1;
            subPartCursor = 0;
            break;
          }
        }
      }

      if (matchedIdx === -1) {
        // Keep smoothly anchored on current cursor without drifting wildly ahead
        matchedIdx = Math.min(wordCursor, chunkWords.length - 1);
      }

      aligned.push({
        wordIndex: chunkWords[matchedIdx].wordIndex,
        offset_ms: Number(bnd.offset_ms) || 0,
        duration_ms: Number(bnd.duration_ms) || 120,
        text: bnd.text || "",
      });
    }

    return aligned;
  }

  /**
   * Binary search aligned boundaries for the active word at timeMs.
   */
  function findWordAtTime(alignedBoundaries, timeMs) {
    if (!alignedBoundaries || !alignedBoundaries.length) return -1;
    let lo = 0;
    let hi = alignedBoundaries.length - 1;
    let best = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (alignedBoundaries[mid].offset_ms <= timeMs + 25) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return alignedBoundaries[best].wordIndex;
  }

  global.LocalReaderChunker = {
    buildDocumentModel,
    createTailSlice,
    alignBoundariesToWords,
    findWordAtTime,
    normalizeWord,
  };
})(window);
