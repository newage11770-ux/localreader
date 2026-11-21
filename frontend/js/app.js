/**
 * LocalReader Studio — Main Frontend Application Controller
 */
(function () {
  "use strict";

  const STORAGE_KEY = "localreader_studio_state_v1";
  const DEFAULT_VOICE = "en-US-AndrewMultilingualNeural";

  const SAMPLE_TEXT = `Welcome to LocalReader Studio — your private, local Text-to-Speech workstation.

Every single word you paste or upload is read strictly verbatim from A to Z, with zero summarization, zero character limits, and real-time word-by-word highlighting.

Try clicking or tapping any word in this paragraph to jump playback straight to that exact spot. You can switch seamlessly between Microsoft's natural neural AI voices and built-in offline system voices whenever you travel without internet.

Need to read long documents on your iPhone 14 Pro Max? Tap "Connect Phone" in the top bar, scan the QR code with your camera, and add LocalReader to your Home Screen for a native full-screen studio experience over your home Wi-Fi.`;

  // ==================== STATE ====================

  const defaultState = {
    text: "",
    docName: "",
    voice: DEFAULT_VOICE,
    offlineVoiceURI: "",
    engineMode: "online", // "online" | "offline"
    speed: 1.0,
    volume: 1.0,
    theme: "obsidian", // "obsidian" | "indigo" | "paper"
    fontSize: 20,
    skipMarkdown: false, // Strictly OFF by default
    viewMode: "read", // "read" | "edit"
  };

  let state = loadState();
  let docModel = null;
  let wordSpans = [];
  let paraEls = [];
  let prevActiveSpan = null;
  let prevActivePara = null;

  let onlineVoices = { pinned: [], others: [], online: true };
  let offlineVoices = [];
  let voiceDropdownOpen = false;
  let pendingAutoReadOnPaste = false;
  let userScrollPausedUntil = 0;
  let toastTimer = null;
  let isScrubbing = false;
  let isExporting = false;
  let mobileControlsExpanded = false;

  // Waveform state
  const BAR_COUNT = 26;
  const barHeights = new Float32Array(BAR_COUNT).fill(0.14);
  let wavePhase = 0;

  // ==================== DOM REFS ====================

  const $ = (id) => document.getElementById(id);

  const els = {
    body: document.body,
    audio: $("lr-audio-player"),
    // Top bar
    modeReadBtn: $("btn-mode-read"),
    modeEditBtn: $("btn-mode-edit"),
    pasteReadBtn: $("btn-paste-read"),
    uploadBtn: $("btn-upload"),
    fileInput: $("file-input"),
    exportMp3Btn: $("btn-export-mp3"),
    connectPhoneBtn: $("btn-connect-phone"),
    themeBtn: $("btn-theme"),
    mobileDrawerToggle: $("btn-mobile-drawer"),
    // Studio strip
    studioStrip: $("studio-strip"),
    engineOnlineBtn: $("btn-engine-online"),
    engineOfflineBtn: $("btn-engine-offline"),
    voiceTrigger: $("voice-trigger"),
    voiceTriggerLabel: $("voice-trigger-label"),
    voiceTriggerSub: $("voice-trigger-sub"),
    voiceMenu: $("voice-menu"),
    voiceSearch: $("voice-search"),
    voiceList: $("voice-list"),
    skipMarkdownToggle: $("toggle-skip-markdown"),
    fontDecreaseBtn: $("btn-font-dec"),
    fontIncreaseBtn: $("btn-font-inc"),
    fontSizeLabel: $("font-size-label"),
    clearTextBtn: $("btn-clear-text"),
    // Paste fallback banner
    pasteBanner: $("paste-fallback-banner"),
    pasteBannerClose: $("paste-banner-close"),
    // Main views
    readSection: $("view-read"),
    editSection: $("view-edit"),
    readerContent: $("reader-content"),
    readerEmpty: $("reader-empty"),
    readerDocBadge: $("reader-doc-badge"),
    recenterBtn: $("btn-recenter"),
    sampleBtn: $("btn-load-sample"),
    emptyPasteBtn: $("btn-empty-paste"),
    emptyUploadBtn: $("btn-empty-upload"),
    emptyEditBtn: $("btn-empty-edit"),
    editorTextarea: $("editor-textarea"),
    editorWordCount: $("editor-word-count"),
    editorReadNowBtn: $("btn-editor-read-now"),
    // Floating audio bar
    audioDock: $("audio-dock"),
    scrubber: $("progress-scrubber"),
    scrubberFill: $("scrubber-fill"),
    waveCanvas: $("waveform-canvas"),
    statusText: $("status-text"),
    statusDot: $("status-dot"),
    wordProgress: $("word-progress"),
    timeEstimate: $("time-estimate"),
    prevParaBtn: $("btn-prev-para"),
    playPauseBtn: $("btn-play-pause"),
    stopBtn: $("btn-stop"),
    nextParaBtn: $("btn-next-para"),
    speedSlider: $("speed-slider"),
    speedValue: $("speed-value"),
    speedPresets: document.querySelectorAll(".speed-preset"),
    muteBtn: $("btn-mute"),
    volumeSlider: $("volume-slider"),
    // Connect Phone modal
    phoneModal: $("phone-modal"),
    phoneModalClose: $("phone-modal-close"),
    qrContainer: $("qr-container"),
    lanUrlText: $("lan-url-text"),
    copyUrlBtn: $("btn-copy-url"),
    interfacesRow: $("interfaces-row"),
    firewallCmdCode: $("firewall-cmd-code"),
    copyFirewallBtn: $("btn-copy-firewall"),
    // Drop overlay & toast
    dropOverlay: $("drop-overlay"),
    toast: $("toast"),
  };

  // ==================== PERSISTENCE ====================

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...defaultState };
      const parsed = JSON.parse(raw);
      return {
        ...defaultState,
        ...parsed,
        skipMarkdown: Boolean(parsed.skipMarkdown),
        speed: clamp(Number(parsed.speed) || 1.0, 0.75, 2.0),
        volume: clamp(parsed.volume !== undefined ? Number(parsed.volume) : 1.0, 0, 1),
        fontSize: clamp(Number(parsed.fontSize) || 20, 15, 32),
      };
    } catch (_err) {
      return { ...defaultState };
    }
  }

  let saveTimer = null;
  function saveState(immediate = false) {
    const write = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (_quotaErr) {
        // If text exceeds localStorage quota (~5MB), persist settings without full text
        try {
          const slim = { ...state, text: state.text.slice(0, 150000) };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
        } catch (_e) {}
      }
    };
    if (immediate) {
      clearTimeout(saveTimer);
      write();
    } else {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(write, 250);
    }
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  // ==================== AUDIO ENGINE ====================

  const engine = new window.LocalReaderAudioEngine(els.audio, {
    onStateChange: handleEngineStateChange,
    onActiveWord: handleActiveWord,
    onProgress: handleProgressUpdate,
    onStatus: handleStatusUpdate,
    onVisualizerFrame: renderWaveformFrame,
    onFinish: () => {
      showToast("Finished reading document verbatim", "success");
    },
  });

  // ==================== INIT ====================

  async function init() {
    applyTheme(state.theme);
    applyFontSize(state.fontSize);

    // Sync UI controls from persisted state
    els.skipMarkdownToggle.checked = state.skipMarkdown;
    els.speedSlider.value = String(state.speed);
    els.volumeSlider.value = String(state.volume);
    els.editorTextarea.value = state.text;

    engine.setMode(state.engineMode);
    engine.setOnlineVoice(state.voice);
    engine.setOfflineVoice(state.offlineVoiceURI);
    engine.setSpeed(state.speed);
    engine.setVolume(state.volume);

    updateEngineButtons();
    updateSpeedUI();
    updateVolumeUI();
    rebuildDocument(state.text, false);

    // Start in Read mode if we have text, or show elegant welcome card in Read mode
    setViewMode(state.viewMode || "read", false);

    bindEvents();
    initOfflineVoices();
    await fetchOnlineVoices();
    renderWaveformFrame(0);
    registerServiceWorker();
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  // ==================== DOCUMENT MODEL & READING MODE RENDER ====================

  function rebuildDocument(rawText, preservePosition = false) {
    const prevWordIdx = preservePosition ? engine.activeWordIndex : 0;
    const wasPlaying =
      preservePosition && (engine.state === "playing" || engine.state === "loading");

    state.text = rawText || "";
    docModel = window.LocalReaderChunker.buildDocumentModel(state.text, state.skipMarkdown);
    engine.setDocument(docModel);

    renderReadingView();
    updateEditorStats();
    handleProgressUpdate({
      currentWord: docModel.wordCount ? Math.min(prevWordIdx + 1, docModel.wordCount) : 0,
      totalWords: docModel.wordCount,
      wordIndex: Math.min(prevWordIdx, Math.max(0, docModel.wordCount - 1)),
      speed: state.speed,
      percent:
        docModel.wordCount > 0
          ? (Math.min(prevWordIdx + 1, docModel.wordCount) / docModel.wordCount) * 100
          : 0,
    });

    if (preservePosition && docModel.wordCount > 0) {
      const clampedIdx = clamp(prevWordIdx, 0, docModel.wordCount - 1);
      engine.activeWordIndex = clampedIdx;
      handleActiveWord(clampedIdx);
      if (wasPlaying) {
        engine.jumpToWord(clampedIdx, true);
      }
    }
  }

  function renderReadingView() {
    prevActiveSpan = null;
    prevActivePara = null;
    wordSpans = [];
    paraEls = [];
    els.readerContent.textContent = "";

    if (!docModel || docModel.wordCount === 0) {
      els.readerEmpty.classList.remove("hidden");
      els.readerContent.classList.add("hidden");
      els.readerDocBadge.classList.add("hidden");
      return;
    }

    els.readerEmpty.classList.add("hidden");
    els.readerContent.classList.remove("hidden");

    if (state.docName) {
      els.readerDocBadge.textContent = state.docName;
      els.readerDocBadge.classList.remove("hidden");
    } else {
      els.readerDocBadge.classList.add("hidden");
    }

    const frag = document.createDocumentFragment();
    wordSpans = new Array(docModel.wordCount);
    paraEls = new Array(docModel.paragraphs.length);

    for (let pIdx = 0; pIdx < docModel.paragraphs.length; pIdx++) {
      const para = docModel.paragraphs[pIdx];
      const pEl = document.createElement("p");
      pEl.className = "lr-para";
      pEl.dataset.p = String(pIdx);

      for (let i = 0; i < para.words.length; i++) {
        const w = para.words[i];
        const span = document.createElement("span");
        span.className = "lr-word";
        span.dataset.w = String(w.wordIndex);
        span.textContent = w.text;
        wordSpans[w.wordIndex] = span;
        pEl.appendChild(span);

        if (w.lineBreakAfter) {
          pEl.appendChild(document.createElement("br"));
        } else if (i < para.words.length - 1) {
          pEl.appendChild(document.createTextNode(" "));
        }
      }

      paraEls[pIdx] = pEl;
      frag.appendChild(pEl);
    }

    els.readerContent.appendChild(frag);
  }

  function handleActiveWord(wordIndex) {
    if (prevActiveSpan) {
      prevActiveSpan.classList.remove("lr-word-active");
      prevActiveSpan = null;
    }
    if (prevActivePara) {
      prevActivePara.classList.remove("lr-para-active");
      prevActivePara = null;
    }

    if (wordIndex < 0 || !docModel || wordIndex >= wordSpans.length) return;

    const span = wordSpans[wordIndex];
    if (!span) return;
    span.classList.add("lr-word-active");
    prevActiveSpan = span;

    const wordObj = docModel.words[wordIndex];
    if (wordObj && paraEls[wordObj.paragraphIndex]) {
      const pEl = paraEls[wordObj.paragraphIndex];
      pEl.classList.add("lr-para-active");
      prevActivePara = pEl;
    }

    // Smooth auto-scroll in Reading Mode unless user recently scrolled manually
    if (state.viewMode === "read" && performance.now() > userScrollPausedUntil) {
      scrollSpanIntoComfortZone(span);
    }
  }

  function scrollSpanIntoComfortZone(span) {
    const rect = span.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const topSafe = 135;
    const bottomSafe = vh - 210;

    if (rect.top < topSafe || rect.bottom > bottomSafe) {
      const targetY = window.scrollY + rect.top - vh * 0.36;
      window.scrollTo({
        top: Math.max(0, targetY),
        behavior: "smooth",
      });
    }
  }

  // ==================== VOICES (ONLINE + OFFLINE) ====================

  async function fetchOnlineVoices() {
    try {
      const res = await fetch("/api/voices");
      if (!res.ok) throw new Error("Voice list unavailable");
      const data = await res.json();
      onlineVoices = {
        pinned: data.pinned || [],
        others: data.others || [],
        online: data.online !== false,
      };
    } catch (_err) {
      onlineVoices = {
        pinned: [
          {
            short_name: DEFAULT_VOICE,
            display_name: "Andrew Multilingual (US)",
            description: "Default · Warm, clear male",
            flag: "🇺🇸",
            locale: "en-US",
            pinned: true,
          },
        ],
        others: [],
        online: false,
      };
    }
    updateVoiceTriggerDisplay();
    renderVoiceList(els.voiceSearch.value);
  }

  const IOS_NOVELTY_VOICES = new Set([
    "albert",
    "bad news",
    "bahh",
    "bells",
    "boing",
    "bubbles",
    "cellos",
    "good news",
    "jester",
    "organ",
    "superstar",
    "trinoids",
    "whisper",
    "wobble",
    "zarvox",
  ]);

  function isIOSDevice() {
    const ua = navigator.userAgent || "";
    return (
      /iPad|iPhone|iPod/i.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  function isEnglishVoice(voice) {
    const lang = (voice && voice.lang ? voice.lang : "").toLowerCase().replace("_", "-");
    return lang === "en" || lang.startsWith("en-");
  }

  function isNoveltyOfflineVoice(voice) {
    if (!voice || !voice.name) return false;
    const raw = voice.name.trim().toLowerCase();
    // Strip trailing locale/quality labels like "Albert (English (United States))"
    const base = raw.replace(/\s*\(.*\)\s*$/, "").trim();
    return IOS_NOVELTY_VOICES.has(raw) || IOS_NOVELTY_VOICES.has(base);
  }

  function offlineVoicePriority(voice) {
    const name = (voice.name || "").toLowerCase();
    const isEn = isEnglishVoice(voice);
    if (!isEn) return 100;
    const isEnhanced = name.includes("enhanced") || name.includes("premium");
    if (name.startsWith("samantha")) return isEnhanced ? 0 : 1;
    if (name.startsWith("daniel")) return isEnhanced ? 2 : 3;
    if (isEnhanced) return 10;
    return voice.localService ? 20 : 30;
  }

  function pickDefaultOfflineVoice(voices) {
    if (!voices || !voices.length) return null;
    const enVoices = voices.filter(isEnglishVoice);
    const pool = enVoices.length ? enVoices : voices;

    // On iOS (and Apple platforms), always prefer Samantha or Daniel as default
    const preferAppleNatural = isIOSDevice() || pool.some((v) => /^(samantha|daniel)\b/i.test(v.name || ""));
    if (preferAppleNatural) {
      const samantha =
        pool.find((v) => /^samantha\b/i.test(v.name || "") && /enhanced|premium/i.test(v.name || "")) ||
        pool.find((v) => /^samantha\b/i.test(v.name || ""));
      if (samantha) return samantha;

      const daniel =
        pool.find((v) => /^daniel\b/i.test(v.name || "") && /enhanced|premium/i.test(v.name || "")) ||
        pool.find((v) => /^daniel\b/i.test(v.name || ""));
      if (daniel) return daniel;
    }

    return pool[0];
  }

  function initOfflineVoices() {
    if (!("speechSynthesis" in window)) return;
    const load = () => {
      const rawList = window.speechSynthesis.getVoices() || [];
      offlineVoices = rawList
        .filter((v) => !isNoveltyOfflineVoice(v))
        .sort((a, b) => {
          const pA = offlineVoicePriority(a);
          const pB = offlineVoicePriority(b);
          if (pA !== pB) return pA - pB;
          const langCmp = (a.lang || "").localeCompare(b.lang || "");
          if (langCmp !== 0 && !isEnglishVoice(a)) return langCmp;
          return (a.name || "").localeCompare(b.name || "");
        });

      const currentStillValid =
        state.offlineVoiceURI &&
        offlineVoices.some((v) => v.voiceURI === state.offlineVoiceURI);

      if (!currentStillValid && offlineVoices.length > 0) {
        const best = pickDefaultOfflineVoice(offlineVoices);
        if (best) {
          state.offlineVoiceURI = best.voiceURI;
          engine.setOfflineVoice(state.offlineVoiceURI);
          saveState();
        }
      }

      if (state.engineMode === "offline") {
        updateVoiceTriggerDisplay();
        renderVoiceList(els.voiceSearch.value);
      }
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }

  function updateVoiceTriggerDisplay() {
    if (state.engineMode === "online") {
      const all = [...onlineVoices.pinned, ...onlineVoices.others];
      const match = all.find((v) => v.short_name === state.voice);
      if (match) {
        els.voiceTriggerLabel.textContent = `${match.flag ? match.flag + " " : ""}${match.display_name}`;
        els.voiceTriggerSub.textContent = match.description || match.locale;
      } else {
        els.voiceTriggerLabel.textContent = state.voice;
        els.voiceTriggerSub.textContent = "Microsoft Neural AI";
      }
    } else {
      const match = offlineVoices.find((v) => v.voiceURI === state.offlineVoiceURI);
      if (match) {
        els.voiceTriggerLabel.textContent = match.name;
        els.voiceTriggerSub.textContent = `${match.lang} · Offline System`;
      } else {
        els.voiceTriggerLabel.textContent = offlineVoices.length
          ? offlineVoices[0].name
          : "Device System Voice";
        els.voiceTriggerSub.textContent = "100% Offline";
      }
    }
  }

  function renderVoiceList(query) {
    const q = (query || "").trim().toLowerCase();
    els.voiceList.textContent = "";
    const frag = document.createDocumentFragment();

    if (state.engineMode === "online") {
      const matchVoice = (v) =>
        !q ||
        v.display_name.toLowerCase().includes(q) ||
        v.short_name.toLowerCase().includes(q) ||
        (v.description || "").toLowerCase().includes(q) ||
        (v.locale || "").toLowerCase().includes(q);

      const pinnedMatches = onlineVoices.pinned.filter(matchVoice);
      const otherMatches = onlineVoices.others.filter(matchVoice);

      if (pinnedMatches.length) {
        frag.appendChild(makeVoiceGroupHeader("Studio Favorites · Pinned"));
        for (const v of pinnedMatches) {
          frag.appendChild(
            makeVoiceOption({
              id: v.short_name,
              title: `${v.flag ? v.flag + " " : ""}${v.display_name}`,
              sub: v.description || v.short_name,
              selected: v.short_name === state.voice,
              badge: v.short_name === DEFAULT_VOICE ? "Default" : "",
            })
          );
        }
      }

      if (otherMatches.length) {
        const limit = q ? 120 : 80;
        frag.appendChild(
          makeVoiceGroupHeader(
            q
              ? `Matching Neural Voices (${otherMatches.length})`
              : `All Neural Voices (${otherMatches.length} · search to filter)`
          )
        );
        for (const v of otherMatches.slice(0, limit)) {
          frag.appendChild(
            makeVoiceOption({
              id: v.short_name,
              title: v.display_name,
              sub: `${v.locale} · ${v.gender} · ${v.short_name}`,
              selected: v.short_name === state.voice,
              badge: "",
            })
          );
        }
      }

      if (!pinnedMatches.length && !otherMatches.length) {
        const empty = document.createElement("div");
        empty.className = "voice-empty";
        empty.textContent = `No neural voices match "${query}"`;
        frag.appendChild(empty);
      }
    } else {
      const filtered = offlineVoices.filter(
        (v) =>
          !q ||
          (v.name || "").toLowerCase().includes(q) ||
          (v.lang || "").toLowerCase().includes(q)
      );
      if (filtered.length) {
        const english = filtered.filter(isEnglishVoice);
        const others = filtered.filter((v) => !isEnglishVoice(v));

        if (english.length) {
          frag.appendChild(makeVoiceGroupHeader(`English Offline Voices (${english.length})`));
          for (const v of english) {
            const isRec = /^(samantha|daniel)\b/i.test(v.name || "");
            frag.appendChild(
              makeVoiceOption({
                id: v.voiceURI,
                title: v.name,
                sub: `${v.lang}${v.localService ? " · Local" : ""}`,
                selected: v.voiceURI === state.offlineVoiceURI,
                badge: isRec ? "Recommended" : v.default ? "System" : "",
              })
            );
          }
        }

        if (others.length) {
          frag.appendChild(makeVoiceGroupHeader(`Other Languages (${others.length})`));
          for (const v of others) {
            frag.appendChild(
              makeVoiceOption({
                id: v.voiceURI,
                title: v.name,
                sub: `${v.lang}${v.localService ? " · Local" : ""}`,
                selected: v.voiceURI === state.offlineVoiceURI,
                badge: "",
              })
            );
          }
        }
      } else {
        const empty = document.createElement("div");
        empty.className = "voice-empty";
        empty.textContent = offlineVoices.length
          ? `No offline voices match "${query}"`
          : "No browser system voices detected on this device.";
        frag.appendChild(empty);
      }
    }

    els.voiceList.appendChild(frag);
  }

  function makeVoiceGroupHeader(label) {
    const div = document.createElement("div");
    div.className = "voice-group-header";
    div.textContent = label;
    return div;
  }

  function makeVoiceOption({ id, title, sub, selected, badge }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-option" + (selected ? " selected" : "");
    btn.dataset.voiceId = id;

    const info = document.createElement("div");
    info.className = "voice-option-info";

    const t = document.createElement("div");
    t.className = "voice-option-title";
    t.textContent = title;
    if (badge) {
      const b = document.createElement("span");
      b.className = "voice-badge";
      b.textContent = badge;
      t.appendChild(b);
    }

    const s = document.createElement("div");
    s.className = "voice-option-sub";
    s.textContent = sub;

    info.appendChild(t);
    info.appendChild(s);
    btn.appendChild(info);

    if (selected) {
      const chk = document.createElement("span");
      chk.className = "voice-check";
      chk.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      btn.appendChild(chk);
    }

    return btn;
  }

  function toggleVoiceDropdown(forceState) {
    const next = typeof forceState === "boolean" ? forceState : !voiceDropdownOpen;
    voiceDropdownOpen = next;
    els.voiceMenu.classList.toggle("hidden", !next);
    els.voiceTrigger.setAttribute("aria-expanded", String(next));
    if (next) {
      els.voiceSearch.value = "";
      renderVoiceList("");
      setTimeout(() => els.voiceSearch.focus(), 30);
    }
  }

  // ==================== VIEW MODE & THEME ====================

  function setViewMode(mode, persist = true) {
    state.viewMode = mode === "edit" ? "edit" : "read";
    const isRead = state.viewMode === "read";

    els.readSection.classList.toggle("hidden", !isRead);
    els.editSection.classList.toggle("hidden", isRead);
    els.modeReadBtn.classList.toggle("active", isRead);
    els.modeEditBtn.classList.toggle("active", !isRead);
    els.modeReadBtn.setAttribute("aria-pressed", String(isRead));
    els.modeEditBtn.setAttribute("aria-pressed", String(!isRead));

    if (!isRead) {
      els.editorTextarea.value = state.text;
      updateEditorStats();
    } else {
      hidePasteBanner();
    }

    if (persist) saveState();
  }

  function applyTheme(theme) {
    const valid = ["obsidian", "indigo", "paper"].includes(theme) ? theme : "obsidian";
    state.theme = valid;
    document.documentElement.setAttribute("data-theme", valid);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute(
        "content",
        valid === "paper" ? "#F6F2EA" : valid === "indigo" ? "#090C18" : "#0B0D12"
      );
    }
    const labels = {
      obsidian: "Theme: Obsidian Studio",
      indigo: "Theme: Midnight Indigo",
      paper: "Theme: Warm Paper",
    };
    els.themeBtn.title = labels[valid];
  }

  function cycleTheme() {
    const order = ["obsidian", "indigo", "paper"];
    const next = order[(order.indexOf(state.theme) + 1) % order.length];
    applyTheme(next);
    saveState();
    const names = { obsidian: "Obsidian Studio", indigo: "Midnight Indigo", paper: "Warm Paper" };
    showToast(`Switched theme to ${names[next]}`, "info");
  }

  function applyFontSize(size) {
    const clamped = clamp(size, 15, 32);
    state.fontSize = clamped;
    document.documentElement.style.setProperty("--reader-font-size", `${clamped}px`);
    els.fontSizeLabel.textContent = `${clamped}px`;
  }

  // ==================== PASTE & READ (WITH iOS SAFARI FALLBACK) ====================

  async function handlePasteAndRead() {
    // Unlock HTML5 <audio> synchronously inside user tap for iOS Safari!
    engine.unlockAudio();

    if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      try {
        const clipText = await navigator.clipboard.readText();
        if (clipText && clipText.trim()) {
          loadTextAndStartReading(clipText, "");
          showToast("Pasted from clipboard — reading verbatim", "success");
          return;
        } else {
          showToast("Clipboard is empty — copy some text first", "info");
          return;
        }
      } catch (_err) {
        // Expected on iOS Safari over local HTTP where clipboard.readText requires HTTPS/permission
      }
    }

    // Smooth iOS / HTTP Fallback: focus textarea and auto-read the instant user taps Paste!
    pendingAutoReadOnPaste = true;
    setViewMode("edit");
    els.pasteBanner.classList.remove("hidden");
    els.editorTextarea.focus();
    els.editorTextarea.select();
    showToast("Tap Paste in the text box — reading starts immediately", "info");
  }

  function hidePasteBanner() {
    pendingAutoReadOnPaste = false;
    els.pasteBanner.classList.add("hidden");
  }

  function loadTextAndStartReading(text, filename) {
    state.docName = filename || "";
    els.editorTextarea.value = text;
    hidePasteBanner();
    rebuildDocument(text, false);
    saveState(true);
    setViewMode("read");
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (docModel && docModel.wordCount > 0) {
      engine.jumpToWord(0, true);
    }
  }

  // ==================== FILE UPLOAD (.pdf, .txt, .md) ====================

  async function handleFileUpload(file) {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);

    showToast(`Extracting text from ${file.name}...`, "info");
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || `Failed to read ${file.name}`);
      }

      state.docName = data.filename || file.name;
      els.editorTextarea.value = data.text;
      rebuildDocument(data.text, false);
      saveState(true);
      setViewMode("read");
      window.scrollTo({ top: 0, behavior: "smooth" });

      const pageNote = data.extension === ".pdf" ? ` · ${data.pages} page${data.pages === 1 ? "" : "s"}` : "";
      showToast(
        `Loaded ${state.docName} (${data.word_count.toLocaleString()} words${pageNote})`,
        "success"
      );
    } catch (err) {
      showToast(err.message || "Could not extract text from file", "error");
    }
  }

  // ==================== EXPORT MP3 ====================

  async function handleExportMp3() {
    if (isExporting) return;
    if (!state.text || !state.text.trim()) {
      showToast("Paste or upload text before exporting MP3", "info");
      return;
    }

    isExporting = true;
    els.exportMp3Btn.disabled = true;
    els.exportMp3Btn.classList.add("is-busy");
    const origLabel = els.exportMp3Btn.querySelector(".btn-label");
    if (origLabel) origLabel.textContent = "Exporting...";

    const baseName = state.docName
      ? state.docName.replace(/\.[^.]+$/, "")
      : "LocalReader_Audio";

    showToast("Generating full verbatim MP3 audio...", "info");

    try {
      const res = await fetch("/api/tts/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: state.text,
          voice: state.voice,
          speed: state.speed,
          skip_markdown: state.skipMarkdown,
          filename: `${baseName}.mp3`,
        }),
      });

      if (!res.ok) {
        let msg = `Export failed (HTTP ${res.status})`;
        try {
          const errJson = await res.json();
          if (errJson.detail) msg = errJson.detail;
        } catch (_e) {}
        throw new Error(msg);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);

      const mb = (blob.size / (1024 * 1024)).toFixed(2);
      showToast(`Exported ${baseName}.mp3 (${mb} MB)`, "success");
    } catch (err) {
      showToast(err.message || "MP3 export failed — check internet connection", "error");
    } finally {
      isExporting = false;
      els.exportMp3Btn.disabled = false;
      els.exportMp3Btn.classList.remove("is-busy");
      if (origLabel) origLabel.textContent = "Export MP3";
    }
  }

  // ==================== CONNECT PHONE MODAL (QR CODE) ====================

  async function openConnectPhoneModal() {
    els.phoneModal.classList.remove("hidden");
    els.qrContainer.innerHTML = `<div class="qr-loading">Detecting Wi-Fi IP...</div>`;
    els.lanUrlText.textContent = "Loading...";
    els.interfacesRow.textContent = "";

    try {
      const res = await fetch("/api/network-info");
      if (!res.ok) throw new Error("Could not fetch network info");
      const info = await res.json();

      els.qrContainer.innerHTML = info.qr_svg || `<img src="${info.qr_png_data_url}" alt="QR Code">`;
      els.lanUrlText.textContent = info.url;
      els.firewallCmdCode.textContent = info.firewall_command;

      if (Array.isArray(info.interfaces) && info.interfaces.length > 1) {
        const label = document.createElement("span");
        label.className = "iface-label";
        label.textContent = "Adapters:";
        els.interfacesRow.appendChild(label);

        for (const iface of info.interfaces) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "iface-chip" + (iface.url === info.url ? " active" : "");
          chip.textContent = `${iface.adapter} (${iface.ip})`;
          chip.addEventListener("click", () => {
            els.lanUrlText.textContent = iface.url;
            els.qrContainer.innerHTML = `<img src="/api/network-info/qr.png?url=${encodeURIComponent(
              iface.url
            )}" alt="QR Code for ${iface.url}" />`;
            els.interfacesRow
              .querySelectorAll(".iface-chip")
              .forEach((c) => c.classList.remove("active"));
            chip.classList.add("active");
          });
          els.interfacesRow.appendChild(chip);
        }
      }
    } catch (_err) {
      els.qrContainer.innerHTML = `<div class="qr-loading">Unable to detect local IP. Ensure server is running.</div>`;
      els.lanUrlText.textContent = window.location.origin;
    }
  }

  function closeConnectPhoneModal() {
    els.phoneModal.classList.add("hidden");
  }

  // ==================== UI UPDATES ====================

  function updateEngineButtons() {
    const isOnline = state.engineMode === "online";
    els.engineOnlineBtn.classList.toggle("active", isOnline);
    els.engineOfflineBtn.classList.toggle("active", !isOnline);
    els.engineOnlineBtn.setAttribute("aria-pressed", String(isOnline));
    els.engineOfflineBtn.setAttribute("aria-pressed", String(!isOnline));
    updateVoiceTriggerDisplay();
  }

  function updateSpeedUI() {
    const formatted = `${state.speed.toFixed(2).replace(/\.00$/, ".0")}x`;
    els.speedValue.textContent = formatted;
    els.speedSlider.value = String(state.speed);
    els.speedPresets.forEach((btn) => {
      const preset = Number(btn.dataset.speed);
      btn.classList.toggle("active", Math.abs(preset - state.speed) < 0.01);
    });
  }

  function updateVolumeUI() {
    els.volumeSlider.value = String(state.volume);
    els.muteBtn.classList.toggle("is-muted", state.volume <= 0.01);
  }

  function updateEditorStats() {
    const wc = docModel ? docModel.wordCount : 0;
    const cc = state.text ? state.text.length : 0;
    const est = formatDuration(estimateRemainingSeconds(wc, state.speed));
    els.editorWordCount.textContent = `${wc.toLocaleString()} words · ${cc.toLocaleString()} chars · ~${est} at ${state.speed}x`;
  }

  function estimateRemainingSeconds(wordCount, speed) {
    if (!wordCount || wordCount <= 0) return 0;
    // Average natural neural speech cadence is ~160 words/min at 1.0x
    const wpm = 160 * (speed || 1.0);
    return Math.ceil((wordCount / wpm) * 60);
  }

  function formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return "0s";
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  function handleEngineStateChange(nextState) {
    els.playPauseBtn.dataset.state = nextState;
    els.audioDock.dataset.state = nextState;
    els.statusDot.dataset.state = nextState;

    const label =
      nextState === "playing"
        ? "Pause"
        : nextState === "loading"
        ? "Loading audio"
        : "Play";
    els.playPauseBtn.setAttribute("aria-label", label);
    els.playPauseBtn.title = `${label} (Space / Ctrl+Shift+U)`;
  }

  function handleStatusUpdate(message, kind) {
    els.statusText.textContent = message;
    els.statusText.dataset.kind = kind || "info";
    if (kind === "error") {
      showToast(message, "error");
    }
  }

  function handleProgressUpdate({ currentWord, totalWords, speed, percent }) {
    if (!isScrubbing) {
      els.scrubber.max = String(Math.max(1, totalWords - 1));
      els.scrubber.value = String(Math.max(0, currentWord - 1));
      els.scrubberFill.style.width = `${clamp(percent || 0, 0, 100)}%`;
    }

    if (totalWords > 0) {
      els.wordProgress.textContent = `${currentWord.toLocaleString()} / ${totalWords.toLocaleString()} words`;
      const remaining = Math.max(0, totalWords - currentWord);
      const secLeft = estimateRemainingSeconds(remaining, speed || state.speed);
      const totalSec = estimateRemainingSeconds(totalWords, speed || state.speed);
      els.timeEstimate.textContent =
        engine.state === "idle"
          ? `~${formatDuration(totalSec)}`
          : `~${formatDuration(secLeft)} left`;
    } else {
      els.wordProgress.textContent = "0 words";
      els.timeEstimate.textContent = "Ready";
    }
  }

  // ==================== WAVEFORM VISUALIZER ====================

  function renderWaveformFrame(energy) {
    const canvas = els.waveCanvas;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(rect.width || 110));
    const h = Math.max(24, Math.round(rect.height || 28));

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const playing = engine.state === "playing";
    const loading = engine.state === "loading";
    wavePhase += playing ? 0.16 : loading ? 0.09 : 0.025;

    const styles = getComputedStyle(document.documentElement);
    const amber = styles.getPropertyValue("--accent-amber").trim() || "#F59E0B";
    const indigo = styles.getPropertyValue("--accent-indigo").trim() || "#818CF8";
    const muted = styles.getPropertyValue("--wave-idle").trim() || "rgba(255,255,255,0.22)";

    const gap = 2.5;
    const barW = Math.max(2, (w - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const center = (BAR_COUNT - 1) / 2;

    for (let i = 0; i < BAR_COUNT; i++) {
      const dist = Math.abs(i - center) / center;
      const bell = 1 - dist * dist * 0.68;

      let target = 0.12;
      if (playing) {
        const wave =
          0.55 +
          0.45 * Math.sin(wavePhase + i * 0.62) * Math.cos(wavePhase * 0.55 - i * 0.31);
        target = clamp(0.14 + energy * bell * wave * 0.92, 0.12, 1.0);
      } else if (loading) {
        target = 0.18 + 0.32 * bell * (0.5 + 0.5 * Math.sin(wavePhase * 1.4 - i * 0.45));
      } else {
        target = 0.12 + 0.05 * bell;
      }

      barHeights[i] += (target - barHeights[i]) * (playing ? 0.32 : 0.18);

      const bh = Math.max(3, barHeights[i] * (h - 2));
      const x = i * (barW + gap);
      const y = (h - bh) / 2;
      const r = barW / 2;

      if (playing || loading) {
        ctx.fillStyle = Math.abs(i - center) < BAR_COUNT * 0.24 ? amber : indigo;
        ctx.globalAlpha = 0.55 + barHeights[i] * 0.45;
      } else {
        ctx.fillStyle = muted;
        ctx.globalAlpha = 0.7;
      }

      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, barW, bh, r);
      } else {
        ctx.rect(x, y, barW, bh);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ==================== TOAST & CLIPBOARD ====================

  function showToast(msg, kind = "info") {
    els.toast.textContent = msg;
    els.toast.dataset.kind = kind;
    els.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("visible");
    }, 3400);
  }

  async function copyToClipboard(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg, "success");
    } catch (_err) {
      // Fallback for HTTP contexts
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast(successMsg, "success");
      } catch (_e) {
        showToast("Select and copy manually", "info");
      }
      ta.remove();
    }
  }

  // ==================== EVENT BINDINGS ====================

  function bindEvents() {
    // View mode toggle
    els.modeReadBtn.addEventListener("click", () => {
      if (state.viewMode === "edit" && els.editorTextarea.value !== state.text) {
        rebuildDocument(els.editorTextarea.value, false);
        saveState();
      }
      setViewMode("read");
    });
    els.modeEditBtn.addEventListener("click", () => setViewMode("edit"));

    // Paste & Read
    els.pasteReadBtn.addEventListener("click", handlePasteAndRead);
    els.emptyPasteBtn.addEventListener("click", handlePasteAndRead);
    els.pasteBannerClose.addEventListener("click", hidePasteBanner);

    // Editor typing & paste auto-read
    let editDebounce = null;
    els.editorTextarea.addEventListener("input", () => {
      state.text = els.editorTextarea.value;
      state.docName = "";
      clearTimeout(editDebounce);
      editDebounce = setTimeout(() => {
        rebuildDocument(state.text, false);
        saveState();
      }, 280);
    });

    els.editorTextarea.addEventListener("paste", () => {
      if (!pendingAutoReadOnPaste) return;
      engine.unlockAudio();
      // Let the paste populate textarea, then immediately switch to Reading Mode & play!
      setTimeout(() => {
        const pasted = els.editorTextarea.value;
        if (pasted && pasted.trim()) {
          loadTextAndStartReading(pasted, "");
          showToast("Pasted — reading verbatim", "success");
        }
      }, 30);
    });

    els.editorReadNowBtn.addEventListener("click", () => {
      engine.unlockAudio();
      const val = els.editorTextarea.value;
      if (!val || !val.trim()) {
        showToast("Type or paste text first", "info");
        return;
      }
      loadTextAndStartReading(val, state.docName);
    });

    // Empty state shortcuts
    els.sampleBtn.addEventListener("click", () => {
      engine.unlockAudio();
      loadTextAndStartReading(SAMPLE_TEXT, "Welcome_Sample.txt");
    });
    els.emptyUploadBtn.addEventListener("click", () => els.fileInput.click());
    els.emptyEditBtn.addEventListener("click", () => {
      setViewMode("edit");
      setTimeout(() => els.editorTextarea.focus(), 40);
    });

    // File upload & full-window drag-and-drop
    els.uploadBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (file) handleFileUpload(file);
      ev.target.value = "";
    });

    let dragCounter = 0;
    window.addEventListener("dragenter", (ev) => {
      ev.preventDefault();
      dragCounter++;
      els.dropOverlay.classList.remove("hidden");
    });
    window.addEventListener("dragover", (ev) => {
      ev.preventDefault();
    });
    window.addEventListener("dragleave", (ev) => {
      ev.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) {
        els.dropOverlay.classList.add("hidden");
      }
    });
    window.addEventListener("drop", (ev) => {
      ev.preventDefault();
      dragCounter = 0;
      els.dropOverlay.classList.add("hidden");
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) {
        handleFileUpload(file);
      }
    });

    // Export MP3, Theme, Connect Phone, Mobile drawer
    els.exportMp3Btn.addEventListener("click", handleExportMp3);
    els.themeBtn.addEventListener("click", cycleTheme);
    els.connectPhoneBtn.addEventListener("click", openConnectPhoneModal);
    els.phoneModalClose.addEventListener("click", closeConnectPhoneModal);
    els.phoneModal.addEventListener("click", (ev) => {
      if (ev.target === els.phoneModal) closeConnectPhoneModal();
    });
    els.copyUrlBtn.addEventListener("click", () =>
      copyToClipboard(els.lanUrlText.textContent, "Wi-Fi URL copied!")
    );
    els.copyFirewallBtn.addEventListener("click", () =>
      copyToClipboard(els.firewallCmdCode.textContent, "PowerShell firewall command copied!")
    );

    els.mobileDrawerToggle.addEventListener("click", () => {
      mobileControlsExpanded = !mobileControlsExpanded;
      els.studioStrip.classList.toggle("mobile-open", mobileControlsExpanded);
      els.mobileDrawerToggle.setAttribute("aria-expanded", String(mobileControlsExpanded));
    });

    // Engine mode toggle
    els.engineOnlineBtn.addEventListener("click", () => {
      if (state.engineMode === "online") return;
      engine.unlockAudio();
      state.engineMode = "online";
      engine.setMode("online");
      updateEngineButtons();
      saveState();
      showToast("Switched to Microsoft Neural AI Voices", "info");
    });

    els.engineOfflineBtn.addEventListener("click", () => {
      if (state.engineMode === "offline") return;
      state.engineMode = "offline";
      engine.setMode("offline");
      updateEngineButtons();
      saveState();
      showToast("Switched to 100% Offline System Voices", "info");
    });

    // Searchable Voice Combobox
    els.voiceTrigger.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleVoiceDropdown();
    });
    els.voiceSearch.addEventListener("input", () => {
      renderVoiceList(els.voiceSearch.value);
    });
    els.voiceMenu.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const opt = ev.target.closest(".voice-option");
      if (!opt) return;
      const chosenId = opt.dataset.voiceId;
      if (state.engineMode === "online") {
        engine.unlockAudio();
        state.voice = chosenId;
        engine.setOnlineVoice(chosenId);
      } else {
        state.offlineVoiceURI = chosenId;
        engine.setOfflineVoice(chosenId);
      }
      updateVoiceTriggerDisplay();
      saveState();
      toggleVoiceDropdown(false);
    });
    document.addEventListener("click", () => {
      if (voiceDropdownOpen) toggleVoiceDropdown(false);
    });

    // Optional Skip Markdown Symbols toggle (OFF by default)
    els.skipMarkdownToggle.addEventListener("change", () => {
      state.skipMarkdown = els.skipMarkdownToggle.checked;
      saveState();
      rebuildDocument(state.text, true);
      showToast(
        state.skipMarkdown
          ? "Skip Markdown Symbols: ON (formatting punctuation skipped)"
          : "Skip Markdown Symbols: OFF (100% raw verbatim)",
        "info"
      );
    });

    // Font size & Clear
    els.fontDecreaseBtn.addEventListener("click", () => {
      applyFontSize(state.fontSize - 2);
      saveState();
    });
    els.fontIncreaseBtn.addEventListener("click", () => {
      applyFontSize(state.fontSize + 2);
      saveState();
    });
    els.clearTextBtn.addEventListener("click", () => {
      if (!state.text) return;
      state.docName = "";
      els.editorTextarea.value = "";
      rebuildDocument("", false);
      saveState(true);
      showToast("Cleared text", "info");
    });

    // Click / Tap ANY word or paragraph in Reading Mode to jump immediately!
    els.readerContent.addEventListener("click", (ev) => {
      const wordEl = ev.target.closest(".lr-word");
      if (wordEl) {
        const wIdx = Number(wordEl.dataset.w);
        if (Number.isFinite(wIdx)) {
          engine.unlockAudio();
          userScrollPausedUntil = 0;
          els.recenterBtn.classList.add("hidden");
          engine.jumpToWord(wIdx, true);
          return;
        }
      }
      const paraEl = ev.target.closest(".lr-para");
      if (paraEl && docModel) {
        const pIdx = Number(paraEl.dataset.p);
        const para = docModel.paragraphs[pIdx];
        if (para) {
          engine.unlockAudio();
          userScrollPausedUntil = 0;
          els.recenterBtn.classList.add("hidden");
          engine.jumpToWord(para.startWordIndex, true);
        }
      }
    });

    // Detect manual user scroll so auto-scroll never fights the user
    const pauseAutoScroll = () => {
      if (engine.state === "playing" && state.viewMode === "read") {
        userScrollPausedUntil = performance.now() + 4500;
        els.recenterBtn.classList.remove("hidden");
      }
    };
    window.addEventListener("wheel", pauseAutoScroll, { passive: true });
    window.addEventListener("touchmove", pauseAutoScroll, { passive: true });
    els.recenterBtn.addEventListener("click", () => {
      userScrollPausedUntil = 0;
      els.recenterBtn.classList.add("hidden");
      if (prevActiveSpan) scrollSpanIntoComfortZone(prevActiveSpan);
    });

    // Transport Controls
    els.playPauseBtn.addEventListener("click", () => {
      if (state.viewMode === "edit" && els.editorTextarea.value !== state.text) {
        rebuildDocument(els.editorTextarea.value, false);
        saveState();
      }
      if (!docModel || !docModel.wordCount) {
        showToast("Paste or upload text to start listening", "info");
        return;
      }
      if (state.viewMode === "edit") {
        setViewMode("read");
      }
      engine.playOrResume();
    });

    els.stopBtn.addEventListener("click", () => {
      engine.stop(false);
      els.recenterBtn.classList.add("hidden");
    });

    els.prevParaBtn.addEventListener("click", () => {
      engine.unlockAudio();
      userScrollPausedUntil = 0;
      engine.prevParagraph();
    });

    els.nextParaBtn.addEventListener("click", () => {
      engine.unlockAudio();
      userScrollPausedUntil = 0;
      engine.nextParagraph();
    });

    // Progress Scrubber
    els.scrubber.addEventListener("input", () => {
      isScrubbing = true;
      const targetWord = Number(els.scrubber.value) || 0;
      const max = Math.max(1, Number(els.scrubber.max) || 1);
      els.scrubberFill.style.width = `${(targetWord / max) * 100}%`;
      if (docModel && docModel.wordCount) {
        els.wordProgress.textContent = `${(targetWord + 1).toLocaleString()} / ${docModel.wordCount.toLocaleString()} words`;
      }
    });

    els.scrubber.addEventListener("change", () => {
      isScrubbing = false;
      const targetWord = Number(els.scrubber.value) || 0;
      if (docModel && docModel.wordCount) {
        engine.unlockAudio();
        userScrollPausedUntil = 0;
        engine.jumpToWord(targetWord, true);
      }
    });

    // Speed Slider & Presets
    els.speedSlider.addEventListener("input", () => {
      state.speed = Number(els.speedSlider.value) || 1.0;
      engine.setSpeed(state.speed);
      updateSpeedUI();
      updateEditorStats();
      saveState();
    });

    els.speedPresets.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.speed = Number(btn.dataset.speed) || 1.0;
        engine.setSpeed(state.speed);
        updateSpeedUI();
        updateEditorStats();
        saveState();
      });
    });

    // Volume Slider & Mute
    let lastNonZeroVolume = state.volume > 0 ? state.volume : 1.0;
    els.volumeSlider.addEventListener("input", () => {
      state.volume = Number(els.volumeSlider.value);
      if (state.volume > 0.01) lastNonZeroVolume = state.volume;
      engine.setVolume(state.volume);
      updateVolumeUI();
      saveState();
    });
    els.muteBtn.addEventListener("click", () => {
      if (state.volume > 0.01) {
        lastNonZeroVolume = state.volume;
        state.volume = 0;
      } else {
        state.volume = lastNonZeroVolume || 1.0;
      }
      engine.setVolume(state.volume);
      updateVolumeUI();
      saveState();
    });

    // Keyboard Hotkeys (PC)
    document.addEventListener("keydown", (ev) => {
      // Escape closes modal / dropdown
      if (ev.key === "Escape") {
        if (!els.phoneModal.classList.contains("hidden")) {
          closeConnectPhoneModal();
          return;
        }
        if (voiceDropdownOpen) {
          toggleVoiceDropdown(false);
          return;
        }
      }

      // Ctrl + Shift + U -> Global Play/Pause (works anywhere, even inside editor!)
      if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "u") {
        ev.preventDefault();
        els.playPauseBtn.click();
        return;
      }

      const tag = (ev.target && ev.target.tagName ? ev.target.tagName : "").toLowerCase();
      const isTyping = tag === "textarea" || tag === "input" || ev.target.isContentEditable;
      if (isTyping) return;

      // Spacebar -> Play/Pause
      if (ev.code === "Space" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        els.playPauseBtn.click();
        return;
      }

      // Alt + Left / Right -> Previous / Next Paragraph
      if (ev.altKey && ev.key === "ArrowLeft") {
        ev.preventDefault();
        els.prevParaBtn.click();
      } else if (ev.altKey && ev.key === "ArrowRight") {
        ev.preventDefault();
        els.nextParaBtn.click();
      }
    });
  }

  // Boot app
  document.addEventListener("DOMContentLoaded", init);
})();
