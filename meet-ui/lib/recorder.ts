import { WSB } from "./api";
import { OfflineBuffer } from "./offlineBuffer";

// Web audio capture + streaming — 1:1 port of the vanilla startRecording/openWS/
// startRecorder/stopRecording. Captures the mic via getUserMedia, streams webm/opus
// chunks over a WebSocket to transcribe.subunit.ai, reconnects on drops, holds a wake
// lock, and supports mute. This is the WEB audio adapter; Echo desktop will swap in a
// native (Rust dual-audio) adapter behind the same surface.

export interface RecorderCallbacks {
  /** Recording UI state: on=streaming, msg overrides the default label. */
  onState: (on: boolean, msg?: string) => void;
  /** Connection-lost banner toggle (reconnecting). */
  onConnLost: (on: boolean) => void;
  /** Terminal close: "ended" = host ended (code 4003), "stopped" = server stopped (>=4000). */
  onEnded?: (reason: "ended" | "stopped") => void;
}

export interface RecorderOpts {
  code: string;
  joinToken: string;
  micDeviceId?: string | null;
  stream?: MediaStream | null; // reuse an already-open stream (pod enroll → recording), no re-getUserMedia
}

export class MeetingRecorder {
  private recording = false;
  private ws: WebSocket | null = null;
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private offline: OfflineBuffer;
  private offlineActive = false; // ein Offline-Block läuft gerade (rec schreibt nach IndexedDB)
  muted = false;

  constructor(
    private opts: RecorderOpts,
    private cb: RecorderCallbacks,
  ) {
    this.offline = new OfflineBuffer(opts.code, opts.joinToken);
  }

  isRecording() {
    return this.recording;
  }

  async start(): Promise<boolean> {
    if (this.recording) return true;
    this.recording = true;
    try {
      if (this.opts.stream) {
        // Pod flow: reuse the stream the enroll phase already opened (same Jabra), so the
        // device is never closed+reopened between check-in and recording — identical to the
        // tested vanilla flow.
        this.stream = this.opts.stream;
      } else {
        const audio: MediaTrackConstraints = Object.assign(
          this.opts.micDeviceId ? { deviceId: { exact: this.opts.micDeviceId } } : {},
          { echoCancellation: true, noiseSuppression: true },
        );
        this.stream = await navigator.mediaDevices.getUserMedia({ audio });
      }
    } catch {
      this.recording = false;
      return false;
    }
    // Liegengebliebene Offline-Blöcke einer früheren Session (Crash/Reload
    // während offline) nachreichen — best-effort, blockiert den Start nicht.
    this.offline.flushBlocks().catch(() => {});
    this.openWS();
    this.acquireWakeLock();
    document.addEventListener("visibilitychange", this.onVisibility);
    return true;
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && this.recording) {
      this.acquireWakeLock();
      if (!this.ws || this.ws.readyState > 1) this.openWS();
    }
  };

  private async acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      /* ignore */
    }
  }
  private releaseWakeLock() {
    try {
      this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  private openWS() {
    if (!this.recording) return;
    const url = `${WSB}/v1/meetings/${this.opts.code}/audio/${this.opts.joinToken}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      // Reconnect nach Offline-Phase: erst den Offline-Block sauber abschließen
      // (finaler Chunk + closed-Marker), DANN hochladen, dann live weiterstreamen.
      const resume = () => {
        if (!this.recording) return;
        this.startRecorder("live");
        this.cb.onState(true);
        this.cb.onConnLost(false);
      };
      if (this.offlineActive) {
        this.stopOfflineBlock()
          .then(() => this.offline.flushBlocks())
          .catch(() => {})
          .then(() => resume());
      } else {
        resume();
      }
    };
    ws.onclose = (e) => {
      if (e.code === 4003) {
        this.stopRecorder();
        this.recording = false;
        this.cb.onConnLost(false);
        this.cb.onEnded?.("ended");
        return;
      }
      if (this.recording && e.code >= 4000) {
        this.stopRecorder();
        this.cb.onState(false, "Aufnahme beendet.");
        this.recording = false;
        this.cb.onConnLost(false);
        this.cb.onEnded?.("stopped");
        return;
      }
      if (this.recording && e.code !== 1000) {
        // Offline-Resilienz: Aufnahme läuft als lokaler Block weiter, statt
        // Chunks bis zum Reconnect zu verlieren. Läuft schon ein Offline-Block
        // (fehlgeschlagener Reconnect-Versuch), NICHT anfassen — nur neu timern.
        if (!this.offlineActive) {
          this.stopRecorder();
          this.offlineActive = true;
          this.offline
            .startBlock()
            .catch(() => {})
            .then(() => {
              if (this.recording && this.offlineActive) this.startRecorder("offline");
            });
        }
        this.cb.onState(true, "Offline — Aufnahme läuft lokal weiter…");
        this.cb.onConnLost(true);
        setTimeout(() => {
          if (this.recording) this.openWS();
        }, 1500);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private startRecorder(mode: "live" | "offline" = "live") {
    if (!this.stream) return;
    let mime = "audio/webm;codecs=opus";
    if (!(window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) mime = "audio/webm";
    try {
      this.rec = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
    } catch {
      try {
        this.rec = new MediaRecorder(this.stream);
      } catch {
        this.cb.onState(false, "Aufnahme nicht unterstützt.");
        return;
      }
    }
    this.rec.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      if (mode === "offline") {
        this.offline.addChunk(ev.data).catch(() => {});
        return;
      }
      if (this.ws && this.ws.readyState === 1) {
        ev.data.arrayBuffer().then((b) => {
          try {
            this.ws?.send(b);
          } catch {
            /* ignore */
          }
        });
      }
    };
    this.rec.start(1000);
  }

  private stopRecorder() {
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }

  /** Offline-Block beenden: Recorder stoppen (finaler Chunk kommt per
   *  ondataavailable VOR onstop), dann Block als vollständig markieren.
   *  Resolved erst, wenn der Block upload-bereit in IndexedDB liegt. */
  private stopOfflineBlock(): Promise<void> {
    this.offlineActive = false;
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec || rec.state === "inactive") {
        this.rec = null;
        this.offline
          .closeBlock()
          .catch(() => {})
          .then(() => resolve());
        return;
      }
      const finish = () => {
        // 250ms Settle: der finale ondataavailable-Chunk schreibt asynchron —
        // erst committen lassen, dann den Block als vollständig markieren.
        setTimeout(() => {
          this.offline
            .closeBlock()
            .catch(() => {})
            .then(() => resolve());
        }, 250);
      };
      rec.onstop = finish;
      try {
        rec.stop();
      } catch {
        finish();
      }
      this.rec = null;
      // Failsafe: onstop kann in Exoten-Browsern ausbleiben → nach 2s trotzdem weiter.
      setTimeout(finish, 2000);
    });
  }

  stop() {
    this.recording = false;
    this.releaseWakeLock();
    if (this.offlineActive) {
      // Offline gestoppt: Block abschließen + Upload versuchen (klappt erst,
      // wenn das Netz zurück ist — sonst greift der Leftover-Flush beim
      // nächsten Start dieses Meetings).
      this.stopOfflineBlock()
        .then(() => this.offline.flushBlocks())
        .catch(() => {});
    } else {
      this.stopRecorder();
    }
    document.removeEventListener("visibilitychange", this.onVisibility);
    setTimeout(() => {
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send("stop");
      } catch {
        /* ignore */
      }
      try {
        this.ws?.close(1000);
      } catch {
        /* ignore */
      }
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
    }, 800);
  }

  /** Toggle mute (track.enabled). Returns the new muted state. */
  toggleMute(): boolean {
    if (!this.stream) return this.muted;
    this.muted = !this.muted;
    try {
      this.stream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    } catch {
      /* ignore */
    }
    return this.muted;
  }
}
