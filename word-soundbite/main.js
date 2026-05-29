const {
  Plugin, Notice, PluginSettingTab, Setting, Modal, Menu
} = require("obsidian");

// ─── Electron desktop audio capture ──────────────────────────────────────────
// Try multiple access patterns so it works across Obsidian versions.
let desktopCapturer;
try {
  desktopCapturer = window.require
    ? window.require("electron").desktopCapturer
    : require("electron").desktopCapturer;
} catch {}
if (!desktopCapturer && window.__electronDesktopCapturer) {
  desktopCapturer = window.__electronDesktopCapturer;
}
if (!desktopCapturer) {
  try {
    const remote = require("@electron/remote") || require("electron").remote;
    desktopCapturer = remote?.desktopCapturer;
  } catch {}
}

// ─── Constants ────────────────────────────────────────────────────────────────
const QUALITY_PRESETS = {
  low:    { audioBitsPerSecond: 32000,  label: "Low  (32 kbps — smallest files)" },
  medium: { audioBitsPerSecond: 96000,  label: "Medium (96 kbps — balanced)"     },
  high:   { audioBitsPerSecond: 192000, label: "High (192 kbps — best quality)"  },
};

const DEFAULT_SETTINGS = {
  audioSource:        "desktop",
  audioDeviceId:      "",
  saveFolderMode:     "relative",
  relativeFolderName: "sounds",
  absoluteFolderPath: "",
  quality:            "medium",
  fileNamePattern:    "{word}_{YYYY}-{MM}-{DD}_{HH}-{mm}-{SS}",
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

function getSupportedMimeType() {
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  return "audio/ogg";
}

async function encodeBufferToBlob(audioCtx, audioBuffer) {
  const dest   = audioCtx.createMediaStreamDestination();
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(dest);

  const mimeType = getSupportedMimeType();
  const recorder = new MediaRecorder(dest.stream, { mimeType });
  const chunks   = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const done = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start();
  source.start();
  source.onended = () => recorder.stop();
  await done;

  return new Blob(chunks, { type: mimeType });
}

async function loadManifest(vault, folder) {
  const path = `${folder}/index.json`;
  try {
    const f = vault.getAbstractFileByPath(path);
    if (f) return JSON.parse(await vault.read(f));
  } catch {}
  return {};
}

async function saveManifest(vault, folder, data) {
  const path = `${folder}/index.json`;
  const json = JSON.stringify(data, null, 2);
  const f = vault.getAbstractFileByPath(path);
  if (f) await vault.modify(f, json);
  else   await vault.create(path, json);
}

// ─── Modals ───────────────────────────────────────────────────────────────────

class RecordingModal extends Modal {
  constructor(app, word, onStop, onCancel) {
    super(app);
    this.word     = word;
    this.onStop   = onStop;
    this.onCancel = onCancel;
    this.modalEl.addClass("sb-modal", "sb-modal--sm");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sb-modal-center");

    contentEl.createEl("div", { cls: "sb-pulse-dot" });
    contentEl.createEl("h2", { text: "Recording…", cls: "sb-title" });
    contentEl.createEl("p", { text: "Capturing audio for", cls: "sb-subtitle" });
    contentEl.createEl("p", { text: `"${this.word}"`, cls: "sb-word" });

    this.startTime = Date.now();
    this.timerEl = contentEl.createEl("p", { text: "0:00", cls: "sb-timer" });
    this._tick();
    this._tickInterval = setInterval(() => this._tick(), 500);

    const row = contentEl.createEl("div", { cls: "sb-btn-row" });

    const cancelBtn = row.createEl("button", { text: "Cancel", cls: "sb-btn sb-btn--secondary" });
    cancelBtn.addEventListener("click", () => { this.close(); this.onCancel(); });

    const stopBtn = row.createEl("button", { cls: "sb-btn sb-btn--danger sb-btn--stop" });
    stopBtn.innerHTML = "&#9209; Stop &amp; Save";
    stopBtn.addEventListener("click", () => { this.close(); this.onStop(); });
  }

  _tick() {
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(s / 60);
    this.timerEl.setText(`${m}:${String(s % 60).padStart(2, "0")}`);
  }

  onClose() {
    clearInterval(this._tickInterval);
    this.contentEl.empty();
  }
}

class TrimModal extends Modal {
  constructor(app, src, onConfirm) {
    super(app);
    this.src       = src;
    this.onConfirm = onConfirm;
    this.modalEl.addClass("sb-modal", "sb-modal--md");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sb-modal-body");

    contentEl.createEl("h2", { text: "Trim Sound", cls: "sb-title" });
    contentEl.createEl("p", {
      text: "Set start and end times (in seconds) to trim the audio clip. The original file will be replaced.",
      cls: "sb-desc",
    });

    // Audio element (hidden, used for metadata + preview)
    this.audio = contentEl.createEl("audio", { cls: "sb-audio" });
    this.audio.controls = true;
    const f = this.app.vault.getAbstractFileByPath(this.src);
    if (f) this.audio.src = this.app.vault.adapter.getResourcePath(this.src);

    // Duration display
    this.duration = 0;
    this.durationEl = contentEl.createEl("p", { text: "Duration: loading…", cls: "sb-duration" });

    const setDuration = (dur) => {
      if (this.duration > 0) return; // already set
      this.duration = dur;
      this.durationEl.setText(`Duration: ${dur.toFixed(2)}s`);
      if (this.endCheck && this.endCheck.checked) this.endInput.value = dur.toFixed(2);
      updateTrimInfo();
    };

    // Try audio element first
    this.audio.addEventListener("loadedmetadata", () => {
      if (isFinite(this.audio.duration) && this.audio.duration > 0) {
        setDuration(this.audio.duration);
      }
    });
    this.audio.addEventListener("durationchange", () => {
      if (isFinite(this.audio.duration) && this.audio.duration > 0) {
        setDuration(this.audio.duration);
      }
    });

    // Fallback: use Web Audio API decodeAudioData (always works for webm)
    if (f) {
      (async () => {
        try {
          const resourcePath = this.app.vault.adapter.getResourcePath(this.src);
          const response = await fetch(resourcePath);
          const arrayBuffer = await response.arrayBuffer();
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          setDuration(audioBuffer.duration);
          audioCtx.close();
        } catch {}
      })();
    }

    // Start time row
    const startRow = contentEl.createEl("div", { cls: "sb-input-row" });
    this.startCheck = startRow.createEl("input", { type: "checkbox" });
    this.startCheck.checked = true;
    startRow.createEl("label", { text: "Start" });
    this.startInput = startRow.createEl("input", { type: "number", value: "0" });
    this.startInput.min = "0";
    this.startInput.step = "0.1";
    this.startInput.style.width = "80px";
    this.startInput.disabled = true;
    this.startInput.style.opacity = "0.5";

    this.startCheck.addEventListener("change", () => {
      this.startInput.disabled = this.startCheck.checked;
      this.startInput.style.opacity = this.startCheck.checked ? "0.5" : "1";
      if (this.startCheck.checked) this.startInput.value = "0";
      updateTrimInfo();
    });

    // End time row
    const endRow = contentEl.createEl("div", { cls: "sb-input-row" });
    this.endCheck = endRow.createEl("input", { type: "checkbox" });
    this.endCheck.checked = true;
    endRow.createEl("label", { text: "End" });
    this.endInput = endRow.createEl("input", { type: "number", value: "" });
    this.endInput.min = "0";
    this.endInput.step = "0.1";
    this.endInput.style.width = "80px";
    this.endInput.disabled = true;
    this.endInput.style.opacity = "0.5";
    this.endInput.placeholder = "end";

    this.endCheck.addEventListener("change", () => {
      this.endInput.disabled = this.endCheck.checked;
      this.endInput.style.opacity = this.endCheck.checked ? "0.5" : "1";
      if (this.endCheck.checked && this.duration) this.endInput.value = this.duration.toFixed(2);
      updateTrimInfo();
    });

    // Trimmed length display
    this.trimInfoEl = contentEl.createEl("p", { cls: "sb-desc", attr: { style: "margin-top:8px;font-size:12px;color:var(--text-muted)" } });
    const updateTrimInfo = () => {
      const s = parseFloat(this.startInput.value) || 0;
      const e = this.endInput.value ? parseFloat(this.endInput.value) : this.duration;
      if (!this.duration) {
        this.trimInfoEl.setText("Trimmed clip: loading…");
        return;
      }
      const endVal = isFinite(e) ? e : this.duration;
      const len = Math.max(0, endVal - s);
      this.trimInfoEl.setText(`Trimmed clip: ${s.toFixed(2)}s → ${endVal.toFixed(2)}s (${len.toFixed(2)}s)`);
    };
    this.startInput.addEventListener("input", updateTrimInfo);
    this.endInput.addEventListener("input", updateTrimInfo);

    // Preview button
    const previewBtn = contentEl.createEl("button", { text: "🔊 Preview trim", cls: "sb-btn sb-btn--block sb-btn--outline" });
    previewBtn.style.textAlign = "center";
    previewBtn.addEventListener("click", () => {
      const start = parseFloat(this.startInput.value) || 0;
      const end   = this.endInput.value ? parseFloat(this.endInput.value) : this.duration;
      if (!this.duration) return;
      this.audio.currentTime = start;
      this.audio.play();
      const onTime = () => {
        if (this.audio.currentTime >= end) {
          this.audio.pause();
          this.audio.removeEventListener("timeupdate", onTime);
        }
      };
      this.audio.addEventListener("timeupdate", onTime);
    });

    // Buttons
    const row = contentEl.createEl("div", { cls: "sb-btn-row" });

    const cancelBtn = row.createEl("button", { text: "Cancel", cls: "sb-btn sb-btn--secondary" });
    cancelBtn.addEventListener("click", () => this.close());

    const confirmBtn = row.createEl("button", { text: "✂️ Trim & Save", cls: "sb-btn sb-btn--primary" });
    confirmBtn.addEventListener("click", () => {
      const start = parseFloat(this.startInput.value) || 0;
      const end   = this.endInput.value ? parseFloat(this.endInput.value) : this.duration;
      if (!this.duration || end <= start) {
        new Notice("⚠️ End time must be greater than start time.");
        return;
      }
      new TrimConfirmModal(this.app, this.src, start, end, () => {
        this.close();
        this.onConfirm(start, end);
      }).open();
    });
  }

  onClose() {
    if (this.audio) { this.audio.pause(); this.audio.src = ""; }
    this.contentEl.empty();
  }
}

class TrimConfirmModal extends Modal {
  constructor(app, src, start, end, onConfirm) {
    super(app);
    this.src       = src;
    this.start     = start;
    this.end       = end;
    this.onConfirm = onConfirm;
    this.modalEl.addClass("sb-modal", "sb-modal--sm");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sb-modal-body");

    contentEl.createEl("h2", { text: "Confirm Trim", cls: "sb-title" });
    contentEl.createEl("p", {
      text: `This will permanently replace the original file with the trimmed clip (${this.start.toFixed(2)}s → ${this.end.toFixed(2)}s). This cannot be undone.`,
      cls: "sb-desc",
    });

    // Play the trimmed portion as a final preview
    this.previewAudio = new Audio(this.app.vault.adapter.getResourcePath(this.src));
    this.previewAudio.currentTime = this.start;
    this.previewAudio.play().catch(() => {});
    const end = this.end;
    const stopAtEnd = () => {
      if (this.previewAudio.currentTime >= end) {
        this.previewAudio.pause();
        this.previewAudio.removeEventListener("timeupdate", stopAtEnd);
      }
    };
    this.previewAudio.addEventListener("timeupdate", stopAtEnd);

    const row = contentEl.createEl("div", { cls: "sb-btn-row" });
    const backBtn = row.createEl("button", { text: "← Back", cls: "sb-btn sb-btn--secondary" });
    backBtn.addEventListener("click", () => this.close());

    const trimBtn = row.createEl("button", { text: "✂️ Trim & Replace", cls: "sb-btn sb-btn--danger" });
    trimBtn.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    if (this.previewAudio) { this.previewAudio.pause(); this.previewAudio = null; }
    this.contentEl.empty();
  }
}

class DeleteConfirmModal extends Modal {
  constructor(app, src, word, onConfirm) {
    super(app);
    this.src       = src;
    this.word      = word;
    this.onConfirm = onConfirm;
    this.modalEl.addClass("sb-modal");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sb-modal-body");

    contentEl.createEl("h2", { text: "Delete Sound", cls: "sb-title" });
    contentEl.createEl("p", {
      text: `Are you sure you want to delete the sound for "${this.word}"?`,
      cls: "sb-desc",
    });
    contentEl.createEl("p", { text: this.src, cls: "sb-filepath" });

    const row = contentEl.createEl("div", { cls: "sb-btn-row sb-btn-row--end" });

    const cancelBtn = row.createEl("button", { text: "Cancel", cls: "sb-btn sb-btn--secondary" });
    cancelBtn.addEventListener("click", () => this.close());

    const deleteBtn = row.createEl("button", { text: "🗑 Delete", cls: "sb-btn sb-btn--danger" });
    deleteBtn.addEventListener("click", () => { this.close(); this.onConfirm(); });
  }

  onClose() { this.contentEl.empty(); }
}

class VolumeModal extends Modal {
  constructor(app, src, currentVolume, onSave) {
    super(app);
    this.src           = src;
    this.currentVolume = currentVolume;
    this.onSave        = onSave;
    this.modalEl.addClass("sb-modal", "sb-modal--sm");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sb-modal-body");

    contentEl.createEl("h2", { text: "Adjust Volume", cls: "sb-title" });
    contentEl.createEl("p", {
      text: this.src.split("/").pop(),
      cls: "sb-desc",
    });

    const row = contentEl.createEl("div", { cls: "sb-input-row" });
    const label = row.createEl("span", { text: `${Math.round(this.currentVolume * 100)}%` });
    label.style.minWidth = "3.5em";
    label.style.textAlign = "right";

    const slider = row.createEl("input");
    slider.type  = "range";
    slider.min   = "0";
    slider.max   = "150";
    slider.value = String(Math.round(this.currentVolume * 100));
    slider.style.flex = "1";
    slider.addEventListener("input", () => {
      label.setText(`${slider.value}%`);
    });

    const previewBtn = contentEl.createEl("button", { text: "\uD83D\uDD0A Preview", cls: "sb-btn sb-btn--block sb-btn--outline" });
    previewBtn.style.textAlign = "center";
    previewBtn.addEventListener("click", () => {
      const audio = new Audio(this.app.vault.adapter.getResourcePath(this.src));
      audio.volume = Math.min(parseInt(slider.value) / 100, 1.0);
      audio.play().catch(() => {});
    });

    const btnRow = contentEl.createEl("div", { cls: "sb-btn-row" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "sb-btn sb-btn--secondary" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = btnRow.createEl("button", { text: "\u2714 Save", cls: "sb-btn sb-btn--primary" });
    saveBtn.addEventListener("click", () => {
      this.close();
      this.onSave(parseInt(slider.value) / 100);
    });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────
module.exports = class WordSoundbite extends Plugin {
  mediaRecorder  = null;
  audioChunks    = [];
  isRecording    = false;
  pendingEditor  = null;
  pendingWord    = null;
  _currentAudio  = null;
  pendingFile    = null;
  activeModal    = null;
  statusBarItem  = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("");
    this.statusBarItem.onClickEvent(() => {
      if (this._currentAudio) this._stopCurrentAudio();
    });
    this._registerCommands();
    this._registerContextMenu();
    this._registerPostProcessor();
    this._observeLiveEditor();
    this.addSettingTab(new WordSoundbiteSetting(this.app, this));
    console.log("[WordSoundbite] loaded");
  }

  onunload() {
    if (this.isRecording) this.stopRecording();
    if (this._mutationObserver) this._mutationObserver.disconnect();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Setup helpers ─────────────────────────────────────────────────────────

  _registerCommands() {
    this.addCommand({
      id:   "start-word-recording",
      name: "Start soundbite recording for selection",
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "R" }],
      editorCallback: (editor, view) => this.initiateRecording(editor, view.file),
    });

    this.addCommand({
      id:   "stop-word-recording",
      name: "Stop soundbite recording",
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "S" }],
      callback: () => this.stopRecording(),
    });
  }

  _registerContextMenu() {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selected = editor.getSelection().trim();
        if (!selected) return;

        menu.addSeparator();

        if (this.isRecording) {
          menu.addItem((item) =>
            item.setTitle("⏹ Stop & save recording")
                .setIcon("stop-circle")
                .onClick(() => this.stopRecording())
          );
        } else {
          menu.addItem((item) =>
            item.setTitle(`🎙 Record soundbite for "${selected}"`)
                .setIcon("microphone")
                .onClick(() => this.initiateRecording(editor, view.file))
          );
        }
      })
    );
  }

  _registerPostProcessor() {
    this.registerMarkdownPostProcessor((el) => {
      el.querySelectorAll("span[data-soundbite]").forEach((span) => {
        const src = span.getAttribute("data-soundbite");
        if (!src) return;
        span.classList.add("sb-sound-word");
        const vol = parseFloat(span.getAttribute("data-volume")) || 1.0;
        span.addEventListener("click", () => this.playSound(src, vol));
        span.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this._showSoundMenu(e, src, span.textContent);
        });
      });
    });
  }

  _observeLiveEditor() {
    const plugin = this;

    const styleSpan = (span) => {
      if (span._sbDone) return;
      span._sbDone = true;
      span.classList.add("sb-sound-word");
      span.title = "🔊 Click to play";
      span.style.cursor = "pointer";
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        const src = span.getAttribute("data-soundbite");
        const vol = parseFloat(span.getAttribute("data-volume")) || 1.0;
        if (src) plugin.playSound(src, vol);
      });
      span.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = span.getAttribute("data-soundbite");
        if (src) plugin._showSoundMenu(e, src, span.textContent);
      });
    };

    const scanRoot = (root) => {
      root.querySelectorAll("span[data-soundbite]").forEach(styleSpan);
    };

    scanRoot(document.body);

    this._mutationObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.("span[data-soundbite]")) styleSpan(node);
          else scanRoot(node);
        }
      }
    });

    this._mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  _showSoundMenu(event, src, word) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("🔊 Play sound").setIcon("volume-2").onClick(() => this.playSound(src)));
    if (this._currentAudio) {
      menu.addItem((i) => i.setTitle("⏹ Stop playing").setIcon("square").onClick(() => this._stopCurrentAudio()));
    }
    menu.addItem((i) => i.setTitle("🔈 Adjust volume").setIcon("volume-1").onClick(() => this.adjustVolume(src)));
    menu.addItem((i) => i.setTitle("✂️ Trim sound").setIcon("scissors").onClick(() => this.trimSound(src)));
    menu.addItem((i) => i.setTitle("🗑 Delete sound").setIcon("trash").onClick(() => this.deleteSound(src, word)));
    menu.showAtMouseEvent(event);
  }

  async playSound(src, volumeOverride) {
    // Stop any currently playing sound
    this._stopCurrentAudio();

    const f = this._getVaultFile(src);
    if (!f) return;
    const volume = volumeOverride != null ? volumeOverride : await this._getVolume(src);
    const audio  = new Audio(this.app.vault.adapter.getResourcePath(src));
    audio.volume = Math.min(volume, 1.0);
    this._currentAudio = audio;

    // Show playing indicator
    const fileName = src.split("/").pop();
    this.statusBarItem.setText("▶️ Click to Stop Playing…");
    this.statusBarItem.setAttr("title", fileName);

    audio.addEventListener("ended", () => {
      if (this._currentAudio === audio) {
        this._currentAudio = null;
        this.statusBarItem.setText("");
        this.statusBarItem.setAttr("title", "");
      }
    });

    audio.addEventListener("error", () => {
      if (this._currentAudio === audio) {
        this._currentAudio = null;
        this.statusBarItem.setText("");
        this.statusBarItem.setAttr("title", "");
      }
    });

    audio.play().catch((err) => {
      new Notice("❌ Playback error: " + err.message);
      this._currentAudio = null;
      this.statusBarItem.setText("");
    });
  }

  _stopCurrentAudio() {
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio.currentTime = 0;
      this._currentAudio = null;
      this.statusBarItem.setText("");
      this.statusBarItem.setAttr("title", "");
    }
  }

  async adjustVolume(src) {
    const currentVolume = await this._getVolume(src);
    new VolumeModal(this.app, src, currentVolume, async (newVolume) => {
      await this._setVolume(src, newVolume);
      new Notice(`Volume set to ${Math.round(newVolume * 100)}%`);
    }).open();
  }



  // ── Recording ─────────────────────────────────────────────────────────────

  async initiateRecording(editor, file) {
    if (this.isRecording) { this.stopRecording(); return; }

    const selected = editor.getSelection().trim();
    if (!selected) {
      new Notice("⚠️ Highlight a word or phrase first!");
      return;
    }

    this._setPending(editor, selected, file);
    await this.startRecording();
  }

  async startRecording() {
    try {
      const stream = this.settings.audioSource === "desktop"
        ? await this._getDesktopAudioStream()
        : await this._getMicStream();

      this.audioChunks = [];
      const mimeType = getSupportedMimeType();
      const { audioBitsPerSecond } = QUALITY_PRESETS[this.settings.quality] || QUALITY_PRESETS.medium;

      this.mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond });
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
        console.log("[WordSoundbite] chunk:", e.data.size, "bytes, total chunks:", this.audioChunks.length);
      };
      this.mediaRecorder.onstop = () => this._saveRecording(stream);
      this.mediaRecorder.start(100);

      console.log("[WordSoundbite] Recording started.", {
        mimeType,
        audioBitsPerSecond,
        recorderState: this.mediaRecorder.state,
        tracks: stream.getAudioTracks().map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })),
      });

      this.isRecording = true;
      this.statusBarItem.setText("🔴 Recording… (Ctrl+Shift+S to stop)");

      this.activeModal = new RecordingModal(
        this.app, this.pendingWord,
        () => this.stopRecording(),
        () => { this._cancelRecording = true; this.stopRecording(); }
      );
      this.activeModal.open();
    } catch (err) {
      new Notice("❌ Recording failed: " + err.message);
      console.error("[WordSoundbite] startRecording:", err);
      this.isRecording = false;
      this.statusBarItem.setText("");
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      this.statusBarItem.setText("");
      if (this.activeModal) { this.activeModal.close(); this.activeModal = null; }
    }
  }

  async _saveRecording(stream) {
    if (this._cancelRecording) {
      this._cancelRecording = false;
      stream.getTracks().forEach((t) => t.stop());
      this._clearPending();
      new Notice("Recording cancelled.");
      return;
    }

    try {
      const blob = new Blob(this.audioChunks, { type: "audio/webm" });
      if (blob.size < 100) {
        new Notice("⚠️ Recording appears empty — check your audio source.");
        return;
      }

      const saveFolder = this.resolveSaveFolder(this.pendingFile);
      const fileName = `${saveFolder}/${this._buildFileName(this.pendingWord)}.webm`;

      try { await this.app.vault.createFolder(saveFolder); } catch {}

      const ab = await blob.arrayBuffer();
      await this.app.vault.createBinary(fileName, new Uint8Array(ab));

      await this._addToManifest(saveFolder, this.pendingWord, fileName);

      if (this.pendingEditor && this.pendingWord) {
        this.pendingEditor.replaceSelection(
          `<span data-soundbite="${fileName}">${this.pendingWord}</span>`
        );
      }

      new Notice(`✅ Soundbite saved — click "${this.pendingWord}" to play.`);
    } catch (err) {
      new Notice("❌ Save failed: " + err.message);
      console.error("[WordSoundbite] saveRecording:", err);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      this._clearPending();
    }
  }

  async _getDesktopAudioStream() {
    // On macOS, desktopCapturer doesn't provide system audio.
    // Use getDisplayMedia which prompts the user to share a screen/window with audio.
    const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");

    if (isMac) {
      return this._getMacDesktopAudio();
    }

    // Windows path: use Electron's desktopCapturer
    if (!desktopCapturer) {
      new Notice("⚠️ Desktop audio unavailable — using microphone instead.");
      return this._getMicStream();
    }

    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ["screen"], fetchWindowIcons: false });
    } catch {
      new Notice("⚠️ Could not access desktop audio — using microphone instead.");
      return this._getMicStream();
    }

    if (!sources?.length) {
      new Notice("⚠️ No screen sources found — using microphone instead.");
      return this._getMicStream();
    }

    const sourceId = sources[0].id;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } },
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId,
                              maxWidth: 1, maxHeight: 1, maxFrameRate: 1 } },
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      return new MediaStream(stream.getAudioTracks());
    } catch (err) {
      new Notice("⚠️ Desktop capture failed, using microphone instead. (" + err.message + ")");
      return this._getMicStream();
    }
  }

  async _getMacDesktopAudio() {
    // getDisplayMedia can capture system/tab audio on macOS.
    // Requires user to select a screen/window and check "Share audio".
    // However, some Electron builds block this API entirely.
    if (typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      new Notice("⚠️ Desktop audio not available in this Obsidian version. Using microphone — grant Obsidian mic access in System Settings → Privacy & Security → Microphone.");
      return this._getMicStream();
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,  // required by the API, but we discard it
        audio: true,
      });
      // Discard the video track — we only want audio
      stream.getVideoTracks().forEach((t) => t.stop());
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        new Notice("⚠️ No audio shared — make sure to check \"Share audio\" in the dialog. Using microphone instead.");
        stream.getTracks().forEach((t) => t.stop());
        return this._getMicStream();
      }
      return new MediaStream(audioTracks);
    } catch (err) {
      if (err.name === "NotAllowedError") {
        new Notice("⚠️ Screen share cancelled — using microphone instead.");
      } else {
        console.error("[WordSoundbite] getDisplayMedia error:", err);
        new Notice("⚠️ Desktop audio not supported (" + err.name + "). Using microphone — grant Obsidian mic access in System Settings → Privacy & Security → Microphone.");
      }
      return this._getMicStream();
    }
  }

  async _getMicStream() {
    try {
      const constraints = { audio: true };
      if (this.settings.audioDeviceId) {
        constraints.audio = { deviceId: { exact: this.settings.audioDeviceId } };
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // Check if the track is actually live (not muted by OS permissions)
      const track = stream.getAudioTracks()[0];
      console.log("[WordSoundbite] Mic track:", {
        label: track?.label,
        enabled: track?.enabled,
        muted: track?.muted,
        readyState: track?.readyState,
        settings: track?.getSettings?.(),
      });
      if (track && track.muted) {
        new Notice("⚠️ Microphone is muted — check System Settings → Privacy & Security → Microphone and ensure Obsidian is allowed.");
      }
      if (track && track.readyState !== "live") {
        new Notice("⚠️ Microphone track is not live (state: " + track.readyState + ")");
      }
      return stream;
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "NotFoundError") {
        new Notice("❌ Microphone access denied. Go to System Settings → Privacy & Security → Microphone and enable Obsidian.");
      } else if (err.name === "OverconstrainedError") {
        new Notice("⚠️ Selected audio device not found — falling back to default mic.");
        return navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        new Notice("❌ Microphone error: " + err.message);
      }
      throw err;
    }
  }

  // ── Trim ──────────────────────────────────────────────────────────────────

  trimSound(src) {
    new TrimModal(this.app, src, async (start, end) => {
      try {
        const f = this._getVaultFile(src);
        if (!f) return;

        const resourcePath = this.app.vault.adapter.getResourcePath(src);
        const response     = await fetch(resourcePath);
        const arrayBuffer  = await response.arrayBuffer();
        const audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer  = await audioCtx.decodeAudioData(arrayBuffer);

        const trimmedBuffer = this._sliceAudioBuffer(audioCtx, audioBuffer, start, end);
        if (!trimmedBuffer) {
          new Notice("⚠️ Invalid trim range.");
          audioCtx.close();
          return;
        }

        const blob = await encodeBufferToBlob(audioCtx, trimmedBuffer);
        const ab   = await blob.arrayBuffer();
        await this.app.vault.modifyBinary(f, new Uint8Array(ab));
        audioCtx.close();

        new Notice("✅ Sound trimmed successfully.");
      } catch (err) {
        new Notice("❌ Trim failed: " + err.message);
        console.error("[WordSoundbite] trimSound:", err);
      }
    }).open();
  }

  _sliceAudioBuffer(audioCtx, buffer, startSec, endSec) {
    const sampleRate  = buffer.sampleRate;
    const startSample = Math.floor(startSec * sampleRate);
    const endSample   = Math.min(Math.floor(endSec * sampleRate), buffer.length);
    const newLength   = endSample - startSample;

    if (newLength <= 0) return null;

    const trimmed = audioCtx.createBuffer(buffer.numberOfChannels, newLength, sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = trimmed.getChannelData(ch);
      for (let i = 0; i < newLength; i++) {
        dst[i] = src[startSample + i];
      }
    }
    return trimmed;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  deleteSound(src, word) {
    // Capture the active file now — it may not be available after the modal closes.
    const noteFile = this.app.workspace.getActiveFile();

    new DeleteConfirmModal(this.app, src, word || "this word", async () => {
      try {
        const f = this.app.vault.getAbstractFileByPath(src);
        if (f) await this.app.vault.delete(f);

        await this._removeFromManifest(src);
        await this._unwrapSpanFromNote(src, noteFile);

        new Notice("✅ Sound deleted.");
      } catch (err) {
        new Notice("❌ Delete failed: " + err.message);
        console.error("[WordSoundbite] deleteSound:", err);
      }
    }).open();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _getVaultFile(src) {
    const f = this.app.vault.getAbstractFileByPath(src);
    if (!f) new Notice(`⚠️ Audio file not found: ${src}`);
    return f;
  }

  _setPending(editor, word, file) {
    this.pendingEditor = editor;
    this.pendingWord   = word;
    this.pendingFile   = file;
  }

  _clearPending() {
    this.pendingEditor = this.pendingWord = this.pendingFile = null;
    this.audioChunks = [];
  }

  resolveSaveFolder(file) {
    if (this.settings.saveFolderMode === "absolute" && this.settings.absoluteFolderPath.trim()) {
      return this.settings.absoluteFolderPath.trim().replace(/\/$/, "");
    }
    const noteDir    = file?.parent?.path || "";
    const folderName = this.settings.relativeFolderName.trim() || "sounds";
    return noteDir ? `${noteDir}/${folderName}` : folderName;
  }

  _buildFileName(word) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const YYYY = String(now.getFullYear());
    const MM   = pad(now.getMonth() + 1);
    const DD   = pad(now.getDate());
    const HH   = pad(now.getHours());
    const mm   = pad(now.getMinutes());
    const SS   = pad(now.getSeconds());
    const timestamp = String(Date.now());

    let safeWord = word.replace(/[^a-zA-Z0-9_\-\u3000-\u9FFF\uF900-\uFAFF]/g, "_").replace(/_+/g, "_");
    if (safeWord.length > 30) {
      safeWord = safeWord.substring(0, 13) + "\u2026" + safeWord.substring(safeWord.length - 13);
    }

    const pattern = this.settings.fileNamePattern || "{word}_{YYYY}-{MM}-{DD}_{HH}-{mm}-{SS}";
    return pattern
      .replace(/\{word\}/g, safeWord)
      .replace(/\{YYYY\}/g, YYYY)
      .replace(/\{MM\}/g, MM)
      .replace(/\{DD\}/g, DD)
      .replace(/\{HH\}/g, HH)
      .replace(/\{mm\}/g, mm)
      .replace(/\{SS\}/g, SS)
      .replace(/\{timestamp\}/g, timestamp);
  }



  async _getVolume(src) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return 1.0;
    const content = await this.app.vault.read(file);
    const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<span[^>]*data-soundbite="${escapedSrc}"[^>]*>`);
    const match = content.match(re);
    if (!match) return 1.0;
    const volMatch = match[0].match(/data-volume="([^"]+)"/);
    return volMatch ? parseFloat(volMatch[1]) : 1.0;
  }

  async _setVolume(src, volume) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const content = await this.app.vault.read(file);
    const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match span with this src, with or without existing data-volume
    const spanRe = new RegExp(
      `(<span\\s+)(?:data-volume="[^"]*"\\s+)?data-soundbite="${escapedSrc}"(?:\\s+data-volume="[^"]*")?`,
      "g"
    );
    let newContent;
    if (volume === 1.0) {
      // Remove data-volume attribute
      newContent = content.replace(spanRe, `$1data-soundbite="${src}"`);
    } else {
      const vol = Math.round(volume * 100) / 100;
      newContent = content.replace(spanRe, `$1data-soundbite="${src}" data-volume="${vol}"`);
    }
    if (newContent !== content) {
      await this.app.vault.modify(file, newContent);
    }
  }

  async _addToManifest(folder, word, filePath) {
    const manifest = await loadManifest(this.app.vault, folder);
    const key = word.toLowerCase();
    if (!manifest[key]) manifest[key] = [];
    manifest[key].push(filePath);
    await saveManifest(this.app.vault, folder, manifest);
  }

  async _removeFromManifest(src) {
    const folder   = src.substring(0, src.lastIndexOf("/"));
    const manifest = await loadManifest(this.app.vault, folder);
    for (const key of Object.keys(manifest)) {
      manifest[key] = manifest[key].filter((p) => p !== src);
      if (manifest[key].length === 0) delete manifest[key];
    }
    await saveManifest(this.app.vault, folder, manifest);
  }

  async _unwrapSpanFromNote(src, noteFile) {
    const file = noteFile || this.app.workspace.getActiveFile();
    if (!file) return;
    const content = await this.app.vault.read(file);
    const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const spanRe = new RegExp(`<span\\s+data-soundbite="${escapedSrc}"(?:\\s+data-volume="[^"]*")?>([^<]*)<\\/span>`, "g");
    const newContent = content.replace(spanRe, "$1");
    if (newContent !== content) {
      await this.app.vault.modify(file, newContent);
    }
  }
};

// ─── Settings Tab ─────────────────────────────────────────────────────────────
class WordSoundbiteSetting extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Word Soundbite" });
    containerEl.createEl("p", {
      text: "Attach audio recordings to words in your notes.",
      cls: "sb-desc",
    });

    // ── Audio ──────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Audio" });

    new Setting(containerEl)
      .setName("Audio source")
      .setDesc("Desktop captures system/app audio. Microphone uses your mic.")
      .addDropdown((d) =>
        d.addOption("desktop", "Desktop audio")
         .addOption("microphone", "Microphone")
         .setValue(this.plugin.settings.audioSource)
         .onChange(async (v) => {
           this.plugin.settings.audioSource = v;
           await this.plugin.saveSettings();
           this.display(); // re-render to show/hide relevant options
         })
      );

    if (this.plugin.settings.audioSource === "microphone") {
      // Audio device picker (microphone only)
      const deviceSetting = new Setting(containerEl)
        .setName("Audio input device")
        .setDesc("Choose which microphone or audio input to use.");

      deviceSetting.addDropdown(async (d) => {
        d.addOption("", "Default");
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioInputs = devices.filter((dev) => dev.kind === "audioinput");
          audioInputs.forEach((dev) => {
            const label = dev.label || `Device ${dev.deviceId.substring(0, 8)}`;
            d.addOption(dev.deviceId, label);
          });
        } catch {}
        d.setValue(this.plugin.settings.audioDeviceId)
         .onChange(async (v) => { this.plugin.settings.audioDeviceId = v; await this.plugin.saveSettings(); });
      });

      // ── Audio Test (microphone) ──────────────────────────────────────────
      const testContainer = containerEl.createDiv({ cls: "sb-audio-test" });
      const testRow = testContainer.createDiv({ cls: "sb-input-row" });

      const testBtn = testRow.createEl("button", { text: "🎤 Test Audio Input", cls: "sb-btn sb-btn--outline" });
      const stopTestBtn = testRow.createEl("button", { text: "⏹ Stop", cls: "sb-btn sb-btn--secondary" });
      stopTestBtn.style.display = "none";

      const statusEl = testContainer.createDiv({ cls: "sb-test-status" });
      statusEl.style.marginTop = "8px";
      statusEl.style.fontSize = "12px";

      const meterContainer = testContainer.createDiv();
      meterContainer.style.marginTop = "6px";
      meterContainer.style.height = "20px";
      meterContainer.style.background = "var(--background-modifier-border)";
      meterContainer.style.borderRadius = "4px";
      meterContainer.style.overflow = "hidden";
      meterContainer.style.display = "none";

      const meterBar = meterContainer.createDiv();
      meterBar.style.height = "100%";
      meterBar.style.width = "0%";
      meterBar.style.background = "var(--interactive-accent)";
      meterBar.style.transition = "width 100ms ease";

      const levelLabel = testContainer.createDiv();
      levelLabel.style.fontSize = "11px";
      levelLabel.style.color = "var(--text-muted)";
      levelLabel.style.marginTop = "4px";

      let testStream = null;
      let testAudioCtx = null;
      let testAnimFrame = null;

      const cleanupTest = () => {
        if (testAnimFrame) { cancelAnimationFrame(testAnimFrame); testAnimFrame = null; }
        if (testStream) { testStream.getTracks().forEach((t) => t.stop()); testStream = null; }
        if (testAudioCtx) { testAudioCtx.close().catch(() => {}); testAudioCtx = null; }
        meterContainer.style.display = "none";
        meterBar.style.width = "0%";
        levelLabel.setText("");
        testBtn.style.display = "";
        stopTestBtn.style.display = "none";
      };

      this.plugin.register(() => cleanupTest());

      testBtn.addEventListener("click", async () => {
        cleanupTest();
        statusEl.setText("⏳ Connecting…");
        statusEl.style.color = "var(--text-muted)";

        try {
          const constraints = { audio: true };
          if (this.plugin.settings.audioDeviceId) {
            constraints.audio = { deviceId: { exact: this.plugin.settings.audioDeviceId } };
          }
          testStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          if (err.name === "NotAllowedError") {
            statusEl.setText("❌ Permission denied — grant Obsidian microphone access in System Settings → Privacy & Security → Microphone");
          } else if (err.name === "NotFoundError") {
            statusEl.setText("❌ No audio input device found");
          } else if (err.name === "OverconstrainedError") {
            statusEl.setText("❌ Selected device not available — try \"Default\"");
          } else {
            statusEl.setText("❌ " + err.message);
          }
          statusEl.style.color = "var(--text-error)";
          return;
        }

        const track = testStream.getAudioTracks()[0];
        if (!track || track.readyState !== "live") {
          statusEl.setText("❌ Audio track is not live — device may be in use");
          statusEl.style.color = "var(--text-error)";
          cleanupTest();
          return;
        }

        statusEl.setText("✅ Connected: " + (track.label || "Unknown device"));
        statusEl.style.color = "var(--text-success)";
        meterContainer.style.display = "block";
        testBtn.style.display = "none";
        stopTestBtn.style.display = "";

        testAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = testAudioCtx.createMediaStreamSource(testStream);
        const analyser = testAudioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let peakLevel = 0;

        const updateMeter = () => {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          const pct = Math.min(100, Math.round((avg / 128) * 100));
          if (pct > peakLevel) peakLevel = pct;

          meterBar.style.width = pct + "%";
          meterBar.style.background = pct > 5 ? "var(--interactive-accent)" : "var(--text-error)";

          if (pct > 5) {
            levelLabel.setText("🔊 Audio detected — input is working! (Peak: " + peakLevel + "%)");
          } else {
            levelLabel.setText("🔇 No audio detected — try speaking or playing sound");
          }

          testAnimFrame = requestAnimationFrame(updateMeter);
        };
        updateMeter();
      });

      stopTestBtn.addEventListener("click", () => {
        cleanupTest();
        statusEl.setText("Test stopped.");
        statusEl.style.color = "var(--text-muted)";
      });

    } else {
      // Desktop audio mode — show info/warning
      const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
      const desktopInfo = containerEl.createDiv();
      desktopInfo.style.marginTop = "8px";
      desktopInfo.style.padding = "12px";
      desktopInfo.style.borderRadius = "6px";
      desktopInfo.style.background = "var(--background-modifier-border)";
      desktopInfo.style.fontSize = "13px";

      if (isMac) {
        desktopInfo.innerHTML =
          "<strong>⚠️ Desktop audio on macOS</strong><br>" +
          "Direct desktop audio capture is not supported in Obsidian on Mac.<br><br>" +
          "<strong>Recommended:</strong> Switch to <em>Microphone</em> mode and install " +
          "<a href='https://existential.audio/blackhole/'>BlackHole</a> (a free virtual audio device). " +
          "Route your system audio through BlackHole, then select it as your input device above.<br><br>" +
          "Alternatively, set audio source to <em>Microphone</em> and speak into your Mac's mic.";
      } else {
        desktopInfo.innerHTML =
          "<strong>ℹ️ Desktop audio (Windows)</strong><br>" +
          "Desktop audio capture uses Electron's screen capture API to record all system sound. " +
          "No additional setup is required.<br><br>" +
          "If you experience issues, switch to <em>Microphone</em> mode to test with the level meter.";
      }
    }

    new Setting(containerEl)
      .setName("Recording quality")
      .setDesc("Higher quality = larger file. Low is fine for short voice clips.")
      .addDropdown((d) => {
        Object.entries(QUALITY_PRESETS).forEach(([k, { label }]) => d.addOption(k, label));
        d.setValue(this.plugin.settings.quality)
         .onChange(async (v) => { this.plugin.settings.quality = v; await this.plugin.saveSettings(); });
      });

    // ── Save Location ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Save location" });

    new Setting(containerEl)
      .setName("Folder mode")
      .setDesc("Relative: saves next to each note. Absolute: one fixed vault folder.")
      .addDropdown((d) =>
        d.addOption("relative", "Relative to note (recommended)")
         .addOption("absolute", "Fixed vault path")
         .setValue(this.plugin.settings.saveFolderMode)
         .onChange(async (v) => {
           this.plugin.settings.saveFolderMode = v;
           await this.plugin.saveSettings();
           this.display();
         })
      );

    if (this.plugin.settings.saveFolderMode === "relative") {
      new Setting(containerEl)
        .setName("Subfolder name")
        .setDesc('Folder created next to your note. Default: "sounds".')
        .addText((t) =>
          t.setPlaceholder("sounds")
           .setValue(this.plugin.settings.relativeFolderName)
           .onChange(async (v) => {
             this.plugin.settings.relativeFolderName = v || "sounds";
             await this.plugin.saveSettings();
           })
        );
    } else {
      new Setting(containerEl)
        .setName("Vault folder path")
        .setDesc('Full path inside your vault. E.g. "Assets/soundbites"')
        .addText((t) =>
          t.setPlaceholder("Assets/soundbites")
           .setValue(this.plugin.settings.absoluteFolderPath)
           .onChange(async (v) => {
             this.plugin.settings.absoluteFolderPath = v;
             await this.plugin.saveSettings();
           })
        );
    }

    // ── File Naming ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "File naming" });

    const nameSetting = new Setting(containerEl)
      .setName("File name pattern")
      .setDesc("Tokens: {word}, {YYYY}, {MM}, {DD}, {HH}, {mm}, {SS}, {timestamp}")
      .addText((t) => {
        t.setPlaceholder("{word}_{YYYY}-{MM}-{DD}_{HH}-{mm}-{SS}")
         .setValue(this.plugin.settings.fileNamePattern)
         .onChange(async (v) => {
           this.plugin.settings.fileNamePattern = v || "{word}_{date}_{time}";
           await this.plugin.saveSettings();
           previewEl.setText("Preview: " + this.plugin._buildFileName("example") + ".webm");
         });
        t.inputEl.style.width = "220px";
      });

    const previewEl = containerEl.createEl("p", {
      text: "Preview: " + this.plugin._buildFileName("example") + ".webm",
      cls: "sb-desc",
    });
    previewEl.style.fontSize = "12px";
    previewEl.style.color = "var(--text-muted)";

    // ── Usage ──────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "How to use" });
    [
      "Open a note in Source mode (Ctrl+E)",
      "Highlight a word or phrase",
      "Right-click → 'Record soundbite' or press Ctrl+Shift+R",
      "A popup appears — click ⏹ Stop & Save when done",
      "Click the underlined 🔊 word to play it back",
      "Right-click a sound word → Trim or Delete",
    ].forEach((s, i) => {
      containerEl.createEl("p", { text: `${i + 1}. ${s}`, cls: "sb-desc" });
    });
  }
}
