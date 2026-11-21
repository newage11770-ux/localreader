/**
 * Dual-Mode Studio Audio Engine for LocalReader
 * - Mode 1 (Online Default): FastAPI / edge-tts streaming with single persistent <audio>
 *   element (iOS Safari unlocked), 3-chunk lookahead prefetching, WordBoundary sync,
 *   and decoupled PCM waveform envelope decoding.
 * - Mode 2 (Offline Fallback): Built-in window.speechSynthesis with onboundary sync.
 */
(function (global) {
  "use strict";

  // Tiny 0.05s valid silent PCM WAV data URI used strictly to unlock <audio> on iOS Safari
  const SILENT_WAV_URI =
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

  const PREFETCH_AHEAD = 2;
  const MAX_CACHE_ENTRIES = 60;
  const CHUNK_FETCH_TIMEOUT_MS = 10000;
  const MAX_FETCH_RETRIES = 2;

  function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  class LocalReaderAudioEngine {
    constructor(audioElement, callbacks) {
      this.audio = audioElement;
      this.cb = callbacks || {};

      // State
      this.doc = null;
      this.mode = "online"; // "online" | "offline"
      this.onlineVoice = "en-US-AndrewMultilingualNeural";
      this.offlineVoiceURI = "";
      this.speed = 1.0;
      this.volume = 1.0;

      this.state = "idle"; // "idle" | "loading" | "playing" | "paused"
      this.activeChunkIndex = 0;
      this.activeWordIndex = 0;
      this.activeSlice = null; // null or tail slice when jumped mid-chunk
      this.activeAligned = [];
      this.activeEnvelope = null;

      this.audioUnlocked = false;
      this.isPriming = false;
      this.hasLoadedRealSrc = false;
      this.sessionId = 0;

      // Online caching & prefetching
      this.chunkCache = new Map(); // cacheKey -> { blobUrl, boundaries, boundaryType, envelope }
      this.inFlight = new Map(); // cacheKey -> Promise
      this.activeAbort = null;
      this.prefetchAborts = new Set(); // active AbortControllers for background prefetches
      this.prefetchTimers = new Set(); // pending setTimeout IDs for staggered prefetches

      // Offline synthesis state
      this.offlineUtterance = null;
      this.offlineFallbackTimer = null;
      this.offlinePulseUntil = 0;

      // Decoded waveform AudioContext (never connected to <audio> output!)
      this.decodeCtx = null;

      // 60fps word highlight & waveform RAF loop
      this.rafId = null;

      this._bindAudioEvents();
      this._initMediaSession();
    }

    _bindAudioEvents() {
      this.audio.addEventListener("playing", () => {
        if (this.isPriming || this.mode !== "online") return;
        this.audio.playbackRate = this.speed;
        this.audio.volume = this.volume;
        this._setState("playing");
        this._startRafLoop();
      });

      this.audio.addEventListener("pause", () => {
        if (this.isPriming || this.mode !== "online") return;
        if (this.audio.ended) return;
        if (this.state === "playing") {
          this._setState("paused");
        }
      });

      this.audio.addEventListener("loadedmetadata", () => {
        if (this.isPriming || this.mode !== "online") return;
        this.audio.playbackRate = this.speed;
        // If boundaries needed actual audio duration for fallback alignment, refresh them now
        if (
          this.activeSlice &&
          (!this.activeAligned.length || this._needsDurationAlignment) &&
          Number.isFinite(this.audio.duration) &&
          this.audio.duration > 0
        ) {
          this._needsDurationAlignment = false;
          this.activeAligned = global.LocalReaderChunker.alignBoundariesToWords(
            [],
            this.activeSlice.words,
            "SentenceBoundary",
            this.audio.duration * 1000
          );
        }
      });

      this.audio.addEventListener("ended", () => {
        if (this.isPriming || this.mode !== "online") return;
        if (this.state !== "playing" && this.state !== "loading") return;
        this._handleChunkEnded(this.sessionId);
      });

      this.audio.addEventListener("error", () => {
        if (this.isPriming || this.mode !== "online") return;
        if (this.state === "idle") return;
        this._emitStatus("Audio playback error — retrying or check connection", "error");
        this._setState("paused");
      });
    }

    _initMediaSession() {
      if (!("mediaSession" in navigator)) return;
      try {
        navigator.mediaSession.setActionHandler("play", () => this.playOrResume());
        navigator.mediaSession.setActionHandler("pause", () => this.pause());
        navigator.mediaSession.setActionHandler("stop", () => this.stop());
        navigator.mediaSession.setActionHandler("previoustrack", () => this.prevParagraph());
        navigator.mediaSession.setActionHandler("nexttrack", () => this.nextParagraph());
      } catch (_err) {
        // Ignore unsupported media session actions
      }
    }

    _updateMediaSessionMetadata() {
      if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: this.doc && this.doc.wordCount ? `LocalReader (${this.doc.wordCount.toLocaleString()} words)` : "LocalReader Studio",
          artist: this.mode === "online" ? this.onlineVoice : "Offline System Voice",
          album: "LocalReader",
          artwork: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          ],
        });
        navigator.mediaSession.playbackState =
          this.state === "playing" ? "playing" : this.state === "paused" ? "paused" : "none";
      } catch (_err) {
        // Safe no-op
      }
    }

    /**
     * MUST be called synchronously inside user click/tap handlers to unlock
     * the persistent HTML5 <audio> element on iOS Safari.
     */
    unlockAudio() {
      if (this.mode !== "online") return;
      if (this.audioUnlocked && this.hasLoadedRealSrc) return;

      try {
        if (!this.hasLoadedRealSrc) {
          this.isPriming = true;
          this.audio.src = SILENT_WAV_URI;
          this.audio.volume = this.volume;
          const p = this.audio.play();
          if (p && typeof p.then === "function") {
            p.then(() => {
              if (this.isPriming) {
                this.audio.pause();
                this.isPriming = false;
              }
              this.audioUnlocked = true;
            }).catch(() => {
              this.isPriming = false;
            });
          } else {
            this.isPriming = false;
            this.audioUnlocked = true;
          }
        } else {
          this.audioUnlocked = true;
        }
      } catch (_err) {
        this.isPriming = false;
      }
    }

    setDocument(docModel) {
      this.stop(true);
      this.clearCache();
      this.doc = docModel;
      this.activeChunkIndex = 0;
      this.activeWordIndex = 0;
      this._emitProgress();
    }

    setMode(newMode) {
      if (this.mode === newMode) return;
      const wasPlaying = this.state === "playing" || this.state === "loading";
      const resumeWord = this.activeWordIndex;
      this.stop(true);
      this.mode = newMode;
      this.activeWordIndex = resumeWord;
      this._emitStatus(
        newMode === "online" ? "Microsoft Neural AI Ready" : "Offline System Voice Ready",
        "info"
      );
      if (wasPlaying && this.doc && this.doc.wordCount > 0) {
        this.jumpToWord(resumeWord, true);
      }
    }

    setOnlineVoice(voiceShortName) {
      if (!voiceShortName || this.onlineVoice === voiceShortName) return;
      const wasActive =
        this.mode === "online" && (this.state === "playing" || this.state === "loading");
      const resumeWord = this.activeWordIndex;

      // Immediately invalidate current session, halt audio, and abort all active & prefetch fetches
      this.sessionId++;
      this._resetPrefetchQueue();
      this._stopRafLoop();
      if (this.mode === "online") {
        try {
          this.isPriming = false;
          this.audio.pause();
        } catch (_err) {}
      }

      this.onlineVoice = voiceShortName;
      this.clearCache();

      if (wasActive && this.doc && this.doc.wordCount > 0) {
        this.jumpToWord(resumeWord, true);
      } else if (this.mode === "online") {
        this.hasLoadedRealSrc = false;
        if (this.state === "loading") {
          this._setState("paused");
          this._emitStatus("Ready · Neural AI", "info");
        }
      }
    }

    setOfflineVoice(voiceURI) {
      this.offlineVoiceURI = voiceURI || "";
      if (this.mode === "offline" && (this.state === "playing" || this.state === "loading")) {
        this.jumpToWord(this.activeWordIndex, true);
      }
    }

    setSpeed(newSpeed) {
      const clamped = Math.max(0.75, Math.min(2.0, Number(newSpeed) || 1.0));
      this.speed = Math.round(clamped * 100) / 100;
      if (this.mode === "online") {
        this.audio.playbackRate = this.speed;
      } else if (this.mode === "offline" && this.state === "playing") {
        // Offline speechSynthesis requires restarting current utterance for new rate
        this.jumpToWord(this.activeWordIndex, true);
      }
      this._emitProgress();
    }

    setVolume(newVolume) {
      const clamped = Math.max(0, Math.min(1, Number(newVolume)));
      this.volume = clamped;
      this.audio.volume = clamped;
    }

    clearCache() {
      this._resetPrefetchQueue();
      for (const entry of this.chunkCache.values()) {
        if (entry.blobUrl) {
          URL.revokeObjectURL(entry.blobUrl);
        }
      }
      this.chunkCache.clear();
      this.inFlight.clear();
      this.hasLoadedRealSrc = false;
    }

    playOrResume() {
      if (!this.doc || !this.doc.chunks.length) return;

      if (this.state === "playing") {
        this.pause();
        return;
      }

      if (this.mode === "online") {
        if (this.state === "paused" && this.hasLoadedRealSrc && this.audio.src && !this.audio.ended) {
          this.audio.playbackRate = this.speed;
          this.audio.volume = this.volume;
          const playPromise = this.audio.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {
              this.jumpToWord(this.activeWordIndex, true);
            });
          }
          this._setState("playing");
          this._startRafLoop();
          return;
        }
        this.unlockAudio();
        this.jumpToWord(this.activeWordIndex, true);
      } else {
        // Offline system voice mode
        if (this.state === "paused") {
          // Restarting cleanly from the exact active word avoids Chromium speechSynthesis pause stalls
          this.jumpToWord(this.activeWordIndex, true);
          return;
        }
        this.jumpToWord(this.activeWordIndex, true);
      }
    }

    pause() {
      if (this.state !== "playing" && this.state !== "loading") return;
      if (this.mode === "online") {
        this.sessionId++;
        this._resetPrefetchQueue();
        this.audio.pause();
        this._stopRafLoop();
        this._setState("paused");
        this._emitStatus("Paused · Neural AI", "info");
      } else {
        this.sessionId++;
        this._cancelOfflineSpeech();
        this._stopRafLoop();
        this._setState("paused");
        this._emitStatus("Paused · Offline System", "info");
      }
    }

    stop(silent = false) {
      this.sessionId++;
      this._resetPrefetchQueue();
      this._cancelOfflineSpeech();
      this._stopRafLoop();

      try {
        this.isPriming = false;
        this.audio.pause();
        if (this.hasLoadedRealSrc) {
          this.audio.currentTime = 0;
        }
      } catch (_err) {
        // Ignore reset errors
      }
      this.hasLoadedRealSrc = false;
      this.activeChunkIndex = 0;
      this.activeWordIndex = 0;
      this.activeSlice = null;
      this.activeAligned = [];
      this.activeEnvelope = null;

      this._setState("idle");
      if (!silent) {
        this._emitWord(-1);
        this._emitProgress();
        this._emitStatus(
          this.mode === "online" ? "Ready · Neural AI" : "Ready · Offline System",
          "info"
        );
      }
    }

    /**
     * Immediately jump playback to any exact word in the document.
     */
    jumpToWord(wordIndex, autoPlay = true) {
      if (!this.doc || !this.doc.words.length) return;
      const safeIdx = Math.max(0, Math.min(this.doc.words.length - 1, wordIndex));
      const wordObj = this.doc.words[safeIdx];
      const chunk = this.doc.chunks[wordObj.chunkIndex];
      if (!chunk) return;

      // Fast-path: if already playing/paused on this EXACT chunk in online mode
      // and we already have aligned boundaries for this exact word, seek in 0ms!
      if (
        this.mode === "online" &&
        this.hasLoadedRealSrc &&
        this.activeChunkIndex === chunk.id &&
        this.activeAligned.length > 0 &&
        (!this.activeSlice || !this.activeSlice.isTail || safeIdx >= this.activeSlice.startWordIndex)
      ) {
        const hit = this.activeAligned.find((b) => b.wordIndex === safeIdx);
        if (hit) {
          this.activeWordIndex = safeIdx;
          this.audio.currentTime = Math.max(0, hit.offset_ms / 1000);
          this.audio.playbackRate = this.speed;
          this.audio.volume = this.volume;
          this._emitWord(safeIdx);
          this._emitProgress();
          if (autoPlay) {
            this.audio.play().catch(() => {});
            this._setState("playing");
            this._startRafLoop();
          }
          return;
        }
      }

      if (autoPlay && this.mode === "online") {
        this.unlockAudio();
      }

      this.sessionId++;
      const mySession = this.sessionId;
      this._resetPrefetchQueue();
      this._cancelOfflineSpeech();

      this.activeChunkIndex = chunk.id;
      this.activeWordIndex = safeIdx;
      this._emitWord(safeIdx);
      this._emitProgress();

      if (!autoPlay) {
        this._setState("paused");
        return;
      }

      const slice = global.LocalReaderChunker.createTailSlice(chunk, safeIdx);
      if (this.mode === "online") {
        this._playOnlineSlice(slice, mySession);
      } else {
        this._playOfflineSlice(slice, mySession);
      }
    }

    prevParagraph() {
      if (!this.doc || !this.doc.paragraphs.length) return;
      const curWord = this.doc.words[this.activeWordIndex];
      const curParaIdx = curWord ? curWord.paragraphIndex : 0;
      const curPara = this.doc.paragraphs[curParaIdx];

      // If more than 2 words into current paragraph, restart current paragraph; else go to previous
      let targetParaIdx = curParaIdx;
      if (!curPara || this.activeWordIndex <= curPara.startWordIndex + 2) {
        targetParaIdx = Math.max(0, curParaIdx - 1);
      }
      const targetWord = this.doc.paragraphs[targetParaIdx].startWordIndex;
      const shouldPlay = this.state === "playing" || this.state === "loading";
      this.jumpToWord(targetWord, shouldPlay || true);
    }

    nextParagraph() {
      if (!this.doc || !this.doc.paragraphs.length) return;
      const curWord = this.doc.words[this.activeWordIndex];
      const curParaIdx = curWord ? curWord.paragraphIndex : 0;
      const targetParaIdx = Math.min(this.doc.paragraphs.length - 1, curParaIdx + 1);
      const targetWord = this.doc.paragraphs[targetParaIdx].startWordIndex;
      this.jumpToWord(targetWord, true);
    }

    // ==================== ONLINE MODE (edge-tts) ====================

    _makeCacheKey(text, voice) {
      return `${voice}::${text}`;
    }

    _abortPendingFetch() {
      if (this.activeAbort) {
        try {
          this.activeAbort.abort();
        } catch (_err) {}
        this.activeAbort = null;
      }
    }

    _resetPrefetchQueue() {
      this._abortPendingFetch();
      for (const timerId of this.prefetchTimers) {
        clearTimeout(timerId);
      }
      this.prefetchTimers.clear();
      for (const ctrl of this.prefetchAborts) {
        try {
          ctrl.abort();
        } catch (_err) {}
      }
      this.prefetchAborts.clear();
      this.inFlight.clear();
    }

    async _fetchChunkOnce(text, voice, chunkId, cancelSignal) {
      const attemptCtrl = new AbortController();
      let timedOut = false;

      const onCancel = () => attemptCtrl.abort();
      if (cancelSignal) {
        if (cancelSignal.aborted) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
        cancelSignal.addEventListener("abort", onCancel, { once: true });
      }

      const timeoutId = setTimeout(() => {
        timedOut = true;
        attemptCtrl.abort();
      }, CHUNK_FETCH_TIMEOUT_MS);

      try {
        const res = await fetch("/api/tts/chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice,
            rate: "+0%",
            chunk_index: chunkId,
          }),
          signal: attemptCtrl.signal,
        });

        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson && errJson.detail) detail = errJson.detail;
          } catch (_e) {}
          throw new Error(detail);
        }

        return await res.json();
      } catch (err) {
        if (timedOut) {
          const tErr = new Error("Chunk synthesis timed out (10s)");
          tErr.name = "TimeoutError";
          throw tErr;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
        if (cancelSignal) {
          cancelSignal.removeEventListener("abort", onCancel);
        }
      }
    }

    async _fetchOnlineAudio(text, voice, chunkId, isPrefetch = false, expectedSession = null) {
      const key = this._makeCacheKey(text, voice);
      if (this.chunkCache.has(key)) {
        return this.chunkCache.get(key);
      }
      if (this.inFlight.has(key)) {
        return this.inFlight.get(key);
      }

      const cancelCtrl = new AbortController();
      if (isPrefetch) {
        this.prefetchAborts.add(cancelCtrl);
      } else {
        this._abortPendingFetch();
        this.activeAbort = cancelCtrl;
      }

      const promise = (async () => {
        let lastErr = null;
        let data = null;

        for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
          if (
            cancelCtrl.signal.aborted ||
            (expectedSession !== null && expectedSession !== this.sessionId)
          ) {
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            throw abortErr;
          }

          if (attempt > 0 && !isPrefetch && (expectedSession === null || expectedSession === this.sessionId)) {
            this._emitStatus(
              `Retrying neural audio (${attempt + 1}/${MAX_FETCH_RETRIES + 1})...`,
              "loading"
            );
          }

          try {
            data = await this._fetchChunkOnce(text, voice, chunkId, cancelCtrl.signal);
            lastErr = null;
            break;
          } catch (err) {
            if (cancelCtrl.signal.aborted || (err && err.name === "AbortError")) {
              throw err;
            }
            lastErr = err;
            if (attempt < MAX_FETCH_RETRIES) {
              await sleepWithSignal(350 * (attempt + 1), cancelCtrl.signal);
            }
          }
        }

        if (lastErr || !data) {
          throw lastErr || new Error("Failed to synthesize audio chunk");
        }

        if (
          cancelCtrl.signal.aborted ||
          (expectedSession !== null && expectedSession !== this.sessionId)
        ) {
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        }

        if (data.empty || !data.audio_base64) {
          const emptyEntry = {
            empty: true,
            blobUrl: null,
            boundaries: [],
            boundaryType: "WordBoundary",
            envelope: null,
          };
          this._storeCache(key, emptyEntry);
          return emptyEntry;
        }

        const bytes = base64ToUint8Array(data.audio_base64);
        const blob = new Blob([bytes], { type: data.mime_type || "audio/mpeg" });
        const blobUrl = URL.createObjectURL(blob);

        const entry = {
          empty: false,
          blobUrl,
          boundaries: Array.isArray(data.boundaries) ? data.boundaries : [],
          boundaryType: data.boundary_type || "WordBoundary",
          envelope: null,
        };
        this._storeCache(key, entry);

        // Decode audio RMS waveform asynchronously without blocking playback
        this._decodeEnvelopeAsync(bytes.buffer.slice(0), entry);

        return entry;
      })();

      this.inFlight.set(key, promise);
      try {
        return await promise;
      } finally {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
        if (isPrefetch) {
          this.prefetchAborts.delete(cancelCtrl);
        } else if (this.activeAbort === cancelCtrl) {
          this.activeAbort = null;
        }
      }
    }

    _storeCache(key, entry) {
      this.chunkCache.set(key, entry);
      if (this.chunkCache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = this.chunkCache.keys().next().value;
        const oldest = this.chunkCache.get(oldestKey);
        if (oldest && oldest.blobUrl && oldest.blobUrl !== this.audio.src) {
          URL.revokeObjectURL(oldest.blobUrl);
        }
        this.chunkCache.delete(oldestKey);
      }
    }

    _decodeEnvelopeAsync(arrayBuffer, entry) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      try {
        if (!this.decodeCtx) {
          this.decodeCtx = new AudioCtx();
        }
        this.decodeCtx
          .decodeAudioData(arrayBuffer)
          .then((audioBuf) => {
            const ch = audioBuf.getChannelData(0);
            const fps = 30;
            const totalBins = Math.max(8, Math.ceil(audioBuf.duration * fps));
            const samplesPerBin = Math.max(1, Math.floor(ch.length / totalBins));
            const env = new Float32Array(totalBins);
            let peak = 0.001;
            for (let b = 0; b < totalBins; b++) {
              const start = b * samplesPerBin;
              const end = Math.min(ch.length, start + samplesPerBin);
              let sumSq = 0;
              // Stride by 4 for ultra-fast decoding on mobile
              let count = 0;
              for (let i = start; i < end; i += 4) {
                const v = ch[i];
                sumSq += v * v;
                count++;
              }
              const rms = Math.sqrt(sumSq / Math.max(1, count));
              env[b] = rms;
              if (rms > peak) peak = rms;
            }
            for (let b = 0; b < totalBins; b++) {
              env[b] = Math.min(1, env[b] / (peak * 0.92));
            }
            entry.envelope = { fps, values: env };
            if (this.activeEntry === entry) {
              this.activeEnvelope = entry.envelope;
            }
          })
          .catch(() => {
            // Completely safe fallback to speech-cadence waveform
          });
      } catch (_err) {
        // Safe ignore
      }
    }

    async _playOnlineSlice(slice, mySession) {
      if (!slice.speakable) {
        this._advanceChunk(mySession);
        return;
      }

      this.activeSlice = slice;
      this.activeChunkIndex = slice.chunkId;
      this._setState("loading");
      this._emitStatus("Synthesizing neural audio...", "loading");

      try {
        const entry = await this._fetchOnlineAudio(
          slice.text,
          this.onlineVoice,
          slice.chunkId,
          false,
          mySession
        );

        if (mySession !== this.sessionId) return;

        if (entry.empty || !entry.blobUrl) {
          this._advanceChunk(mySession);
          return;
        }

        this.activeEntry = entry;
        this.activeEnvelope = entry.envelope;
        const needsFallbackDuration =
          !entry.boundaries ||
          entry.boundaries.length === 0 ||
          entry.boundaryType === "SentenceBoundary";
        this._needsDurationAlignment = needsFallbackDuration;

        this.activeAligned = global.LocalReaderChunker.alignBoundariesToWords(
          entry.boundaries,
          slice.words,
          entry.boundaryType,
          null
        );

        // Swap src on the single persistent <audio> element (iOS Safari seamless!)
        this.isPriming = false;
        this.hasLoadedRealSrc = true;
        this.audio.src = entry.blobUrl;
        this.audio.playbackRate = this.speed;
        this.audio.volume = this.volume;

        const playPromise = this.audio.play();
        if (playPromise && typeof playPromise.then === "function") {
          await playPromise;
        }

        if (mySession !== this.sessionId) return;
        this.audioUnlocked = true;
        this._setState("playing");
        this._emitStatus("Playing · Neural AI", "playing");
        this._startRafLoop();

        // Prefetch next chunks in background immediately after playback starts
        this._prefetchUpcoming(slice.chunkId, mySession);
      } catch (err) {
        if (mySession !== this.sessionId) return;
        if (err && err.name === "AbortError") {
          if (this.state === "loading") {
            this._setState("paused");
          }
          return;
        }

        console.error("[LocalReader] Online TTS error:", err);
        this._setState("paused");
        if (err && err.name === "NotAllowedError") {
          this._emitStatus("Tap Play to resume audio on iOS", "info");
        } else if (err && err.name === "TimeoutError") {
          this._emitStatus(
            "Online TTS timed out after retries — tap Play or switch to Offline System",
            "error"
          );
        } else {
          this._emitStatus(
            "Online TTS unavailable — switch to Offline System mode or check Wi-Fi",
            "error"
          );
        }
      }
    }

    _prefetchUpcoming(currentChunkId, mySession) {
      if (!this.doc || this.mode !== "online") return;
      const targetVoice = this.onlineVoice;

      for (let offset = 1; offset <= PREFETCH_AHEAD; offset++) {
        const nextId = currentChunkId + offset;
        if (nextId >= this.doc.chunks.length) break;
        const nextChunk = this.doc.chunks[nextId];
        if (!nextChunk.speakable) continue;
        const key = this._makeCacheKey(nextChunk.text, targetVoice);
        if (this.chunkCache.has(key) || this.inFlight.has(key)) continue;

        // Slight stagger avoids saturating iOS Safari's per-host HTTP connection pool
        const timerId = setTimeout(() => {
          this.prefetchTimers.delete(timerId);
          if (
            mySession !== this.sessionId ||
            this.mode !== "online" ||
            this.onlineVoice !== targetVoice
          ) {
            return;
          }
          this._fetchOnlineAudio(
            nextChunk.text,
            targetVoice,
            nextChunk.id,
            true,
            mySession
          ).catch(() => {});
        }, (offset - 1) * 180);
        this.prefetchTimers.add(timerId);
      }
    }

    _handleChunkEnded(mySession) {
      this._advanceChunk(mySession);
    }

    _advanceChunk(mySession) {
      if (mySession !== this.sessionId || !this.doc) return;
      const nextId = this.activeChunkIndex + 1;
      if (nextId >= this.doc.chunks.length) {
        // Finished reading entire document verbatim A-to-Z!
        this._stopRafLoop();
        this.hasLoadedRealSrc = false;
        this.activeWordIndex = this.doc.words.length - 1;
        this._emitProgress(true);
        this._setState("idle");
        this._emitStatus("Finished reading document", "done");
        if (this.cb.onFinish) this.cb.onFinish();
        return;
      }

      const nextChunk = this.doc.chunks[nextId];
      const slice = {
        chunkId: nextChunk.id,
        isTail: false,
        text: nextChunk.text,
        speakable: nextChunk.speakable,
        words: nextChunk.words,
        startWordIndex: nextChunk.startWordIndex,
      };
      this.activeWordIndex = nextChunk.startWordIndex;
      this._emitWord(this.activeWordIndex);
      this._emitProgress();

      if (this.mode === "online") {
        this._playOnlineSlice(slice, mySession);
      } else {
        this._playOfflineSlice(slice, mySession);
      }
    }

    // ==================== OFFLINE MODE (speechSynthesis) ====================

    _cancelOfflineSpeech() {
      if (this.offlineFallbackTimer) {
        clearInterval(this.offlineFallbackTimer);
        this.offlineFallbackTimer = null;
      }
      this.offlineUtterance = null;
      if ("speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
        } catch (_err) {}
      }
    }

    _playOfflineSlice(slice, mySession) {
      if (!("speechSynthesis" in window)) {
        this._emitStatus("Offline SpeechSynthesis is not supported in this browser", "error");
        this._setState("idle");
        return;
      }
      if (!slice.speakable) {
        this._advanceChunk(mySession);
        return;
      }

      this._cancelOfflineSpeech();
      this.activeSlice = slice;
      this.activeChunkIndex = slice.chunkId;
      this.activeEnvelope = null;

      const utter = new SpeechSynthesisUtterance(slice.text);
      utter.rate = this.speed;
      utter.volume = this.volume;

      const voices = window.speechSynthesis.getVoices();
      if (this.offlineVoiceURI) {
        const match = voices.find((v) => v.voiceURI === this.offlineVoiceURI);
        if (match) utter.voice = match;
      }

      let gotNativeBoundary = false;

      utter.onstart = () => {
        if (mySession !== this.sessionId) return;
        this._setState("playing");
        this._emitStatus("Playing · Offline System Voice", "playing");
        this._startRafLoop();

        // Fallback estimator in case an OS voice does not emit onboundary events
        let fallbackCursor = 0;
        const msPerWord = Math.max(120, Math.round(350 / this.speed));
        this.offlineFallbackTimer = setInterval(() => {
          if (mySession !== this.sessionId || gotNativeBoundary) {
            clearInterval(this.offlineFallbackTimer);
            this.offlineFallbackTimer = null;
            return;
          }
          if (fallbackCursor < slice.words.length) {
            const w = slice.words[fallbackCursor++];
            this.activeWordIndex = w.wordIndex;
            this.offlinePulseUntil = performance.now() + 220;
            this._emitWord(w.wordIndex);
            this._emitProgress();
          }
        }, msPerWord);
      };

      utter.onboundary = (ev) => {
        if (mySession !== this.sessionId) return;
        if (ev.name && ev.name !== "word") return;
        gotNativeBoundary = true;
        const charIdx = typeof ev.charIndex === "number" ? ev.charIndex : 0;

        // Match charIndex against exact slice.words[i].charStart..charEnd
        let matchedWord = slice.words[0];
        for (let i = 0; i < slice.words.length; i++) {
          const w = slice.words[i];
          if (charIdx >= w.charStart && charIdx <= w.charEnd + 1) {
            matchedWord = w;
            break;
          }
          if (w.charStart <= charIdx) {
            matchedWord = w;
          } else {
            break;
          }
        }
        if (matchedWord) {
          this.activeWordIndex = matchedWord.wordIndex;
          this.offlinePulseUntil = performance.now() + 260;
          this._emitWord(matchedWord.wordIndex);
          this._emitProgress();
        }
      };

      utter.onend = () => {
        if (mySession !== this.sessionId) return;
        if (this.offlineFallbackTimer) {
          clearInterval(this.offlineFallbackTimer);
          this.offlineFallbackTimer = null;
        }
        this._advanceChunk(mySession);
      };

      utter.onerror = (ev) => {
        if (mySession !== this.sessionId) return;
        if (ev && (ev.error === "canceled" || ev.error === "interrupted")) return;
        this._emitStatus(`Offline voice error: ${ev ? ev.error : "unknown"}`, "error");
        this._setState("paused");
      };

      this.offlineUtterance = utter;
      this._setState("loading");
      window.speechSynthesis.speak(utter);
    }

    // ==================== 60FPS SYNC & WAVEFORM LOOP ====================

    _startRafLoop() {
      if (this.rafId !== null) return;
      const tick = () => {
        if (this.state !== "playing") {
          this.rafId = null;
          return;
        }

        if (this.mode === "online" && this.activeAligned.length > 0 && !this.audio.paused) {
          const timeMs = this.audio.currentTime * 1000;
          const wordIdx = global.LocalReaderChunker.findWordAtTime(this.activeAligned, timeMs);
          if (wordIdx !== -1 && wordIdx !== this.activeWordIndex) {
            this.activeWordIndex = wordIdx;
            this._emitWord(wordIdx);
            this._emitProgress();
          }
        }

        if (this.cb.onVisualizerFrame) {
          this.cb.onVisualizerFrame(this._sampleEnergy());
        }

        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }

    _stopRafLoop() {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.cb.onVisualizerFrame) {
        this.cb.onVisualizerFrame(0);
      }
    }

    _sampleEnergy() {
      if (this.state !== "playing") return 0;
      if (this.mode === "online" && this.activeEnvelope) {
        const idx = Math.floor(this.audio.currentTime * this.activeEnvelope.fps);
        if (idx >= 0 && idx < this.activeEnvelope.values.length) {
          return this.activeEnvelope.values[idx];
        }
      }
      // Smooth speech-cadence energy when envelope isn't decoded or in offline mode
      const now = performance.now();
      const pulse = this.mode === "offline" && now < this.offlinePulseUntil ? 0.85 : 0.45;
      return Math.min(1, Math.max(0.12, pulse + 0.28 * Math.sin(now * 0.014) * Math.cos(now * 0.007)));
    }

    // ==================== CALLBACK EMITTERS ====================

    _setState(next) {
      this.state = next;
      this._updateMediaSessionMetadata();
      if (this.cb.onStateChange) this.cb.onStateChange(next);
    }

    _emitWord(wordIndex) {
      if (this.cb.onActiveWord) this.cb.onActiveWord(wordIndex);
    }

    _emitProgress(completed = false) {
      if (!this.cb.onProgress) return;
      const total = this.doc ? this.doc.wordCount : 0;
      const current = completed ? total : Math.min(total, this.activeWordIndex + (total ? 1 : 0));
      this.cb.onProgress({
        currentWord: current,
        totalWords: total,
        wordIndex: this.activeWordIndex,
        speed: this.speed,
        percent: total > 0 ? Math.min(100, (current / total) * 100) : 0,
      });
    }

    _emitStatus(message, kind) {
      if (this.cb.onStatus) this.cb.onStatus(message, kind || "info");
    }
  }

  global.LocalReaderAudioEngine = LocalReaderAudioEngine;
})(window);
