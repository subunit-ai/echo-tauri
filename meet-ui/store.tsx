/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "./lib/api";
import { decodeJwt, type Identity } from "./lib/auth";
import { MeetingRecorder } from "./lib/recorder";
import { detectLang } from "./lib/i18n";

// Central meeting state — the React counterpart of the vanilla global `S` + its handler
// functions. Render-driving slices live in useState; imperative singletons (recorder,
// timers, tokens read only inside actions) live in a ref so they don't churn renders.

export type Screen = "welcome" | "landing" | "hostlogin" | "host" | "join" | "waiting" | "guest" | "enroll" | "ended";

export interface Setup {
  title: string;
  mode: string;
  device: string;
  spk: number | null;
  names: string[];
  language: string;
  scheduledAt?: string | null; // ISO-Termin, wenn "Meeting planen" statt sofort starten (TJ 2026-06-11)
}

export interface ResultData {
  minutesMd: string;
  minutesMdOrig: string;
  transcriptMd: string;
  bezugMd: string;
  meta: any;
  deviceMode: string;
  spkPool: string[];
  explain: any[];
}

interface MeetingState {
  screen: Screen;
  identity: Identity | null;
  role: "host" | "guest" | null;
  code: string;
  title: string;
  deviceMode: string;
  participants: any[];
  // recording UI
  recOn: boolean;
  recMsg: string;
  connLost: boolean;
  muted: boolean;
  timer: string;
  // guest UI
  guestStartVisible: boolean;
  guestHint: string;
  guestRecText: string;
  waitSub: string;
  // ended / results
  endTitle: string;
  endSub: string;
  endSpin: boolean;
  stageText: string;
  result: ResultData | null;
  canRecap: boolean;
  canIntel: boolean;
  // pod voice-enrollment
  enroll: any | null; // guest enrollment state
  hostEnroll: any | null; // host roster state
  enrolling: boolean; // pod guided auto-enrollment in progress
  podGuest: boolean; // guest is in a pod meeting (central mic)
  podRecording: boolean;
  pendingJoinCode: string; // deep-link code prefill for the Join screen
  resumeRecording: boolean; // restored a session that was mid-recording → "fortsetzen" UI
  peekHost: string; // host name from peekMeeting (Join sub-title)
  singleHint: string; // single-device host hint (computed at create)

  setIdentity: (i: Identity | null) => void;
  go: (s: Screen) => void;
  goJoin: (code?: string) => void;
  openRecapView: (code: string, token: string) => void;
  hostEntry: () => void;
  createMeeting: (setup: Setup) => Promise<{ ok: boolean; error?: string }>;
  approve: (token: string, ok: boolean) => void;
  hostStartRec: () => Promise<{ ok: boolean; error?: string }>;
  scheduleStart: (delayMs: number) => void;
  hostEnd: () => Promise<void>;
  peekMeeting: (code: string) => void;
  guestJoin: (code: string, name: string, email: string, fromLink: boolean) => Promise<{ ok: boolean; error?: string }>;
  guestStartRec: () => Promise<{ ok: boolean; error?: string }>;
  toggleMute: () => void;
  leave: () => void;
  resumeHost: (info: any, session: any) => void; // boot/restore (session = persisted meetS)
  resumeGuest: (info: any, session: any) => void;
  setMicDevice: (id: string | null) => void;
  // pod enrollment
  hostEnrollStart: () => Promise<void>;
  hostEnrollMark: (token: string, status: string) => Promise<void>;
  // results extras
  translateProtocol: (lang: string) => Promise<string>;
  recapParticipants: () => Promise<any[]>;
  sendRecapTo: (recipients: { token: string; email: string; lang: string }[]) => Promise<{ ok: boolean; sent?: number; error?: string }>;
  runIntel: (action: string) => Promise<{ ok: boolean; status: number }>;
  loadMyMeetings: () => Promise<any[]>;
  openHistoryMeeting: (code: string, hostToken: string) => void;
}

const Ctx = createContext<MeetingState | null>(null);

const UI_LANG = () => detectLang();

export function MeetingProvider({
  children,
  onSsoLogin,
}: {
  children: ReactNode;
  onSsoLogin: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("landing");
  const [identity, setIdentity] = useState<Identity | null>(null);
  // 🔑 Persistenter Login (TJ 2026-06-11): Identity ueberlebt App-/Seiten-Neustarts,
  // damit "Meeting starten" nie wieder in den SSO-Redirect haengt. Expiry-Check beim Boot (App.tsx).
  useEffect(() => {
    if (identity?.jwt) {
      try { localStorage.setItem("meet_id", JSON.stringify(identity)); } catch { /* ignore */ }
    }
  }, [identity]);
  const [role, setRole] = useState<"host" | "guest" | null>(null);
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [deviceMode, setDeviceMode] = useState("multi");
  const [participants, setParticipants] = useState<any[]>([]);
  const [recOn, setRecOn] = useState(false);
  const [recMsg, setRecMsg] = useState("");
  const [connLost, setConnLost] = useState(false);
  const [muted, setMuted] = useState(false);
  const [timer, setTimer] = useState("");
  const [guestStartVisible, setGuestStartVisible] = useState(false);
  const [guestHint, setGuestHint] = useState("Sobald der Host startet, nimmt dein Gerät automatisch auf. Leg das Handy hin.");
  const [guestRecText, setGuestRecText] = useState("Warte auf Host…");
  const [waitSub, setWaitSub] = useState("Der Host muss dich noch freigeben…");
  const [endTitle, setEndTitle] = useState("Meeting beendet");
  const [endSub, setEndSub] = useState("Dein Deep-Dive wird erstellt — Transkript, Themen, Entscheidungen.");
  const [endSpin, setEndSpin] = useState(true);
  const [stageText, setStageText] = useState("");
  const [result, setResult] = useState<ResultData | null>(null);
  const [enroll, setEnroll] = useState<any | null>(null);
  const [hostEnroll, setHostEnroll] = useState<any | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [podGuest, setPodGuest] = useState(false);
  const [podRecording, setPodRecording] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState("");
  const [resumeRecording, setResumeRecording] = useState(false);
  const [peekHost, setPeekHost] = useState("");
  const [singleHint, setSingleHint] = useState("");

  // Imperative singletons / mutable bits (no re-render on change).
  const s = useRef({
    code: "", // live mirror of `code` state — pollers/recorder read this, NOT the stale closure
    hostToken: "",
    joinToken: "",
    micReady: false,
    micDeviceId: null as string | null,
    deviceMode: "multi",
    fromLink: false,
    recorder: null as MeetingRecorder | null,
    pollT: 0 as any,
    endWatch: 0 as any,
    schedTimer: 0 as any,
    timerInt: 0 as any,
    stageInt: 0 as any,
    resultsGen: 0, // bumped on each startResults — only the newest transcript poll stays alive
    mtgStarted: 0,
    mtgNow: 0,
    mtgSyncAt: 0,
    mtgStatus: "",
    protoCache: {} as Record<string, string>,
    enrollDoneShown: false,
    // guided pod auto-enrollment (TJ 2026-06-10)
    enrollStream: null as MediaStream | null,
    enrolling: false,
    enrollTried: {} as Record<string, number>, // per-person clip attempt counter (retry up to 3×)
    enrollClipBusy: false,
    enrollPollT: 0 as any,
  });

  const go = useCallback((sc: Screen) => {
    setScreen(sc);
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
  }, []);

  const goJoin = useCallback(
    (c?: string) => {
      setPendingJoinCode(c || "");
      go("join");
    },
    [go],
  );

  // Set the active meeting code in BOTH the ref (read synchronously by pollers/recorder)
  // and state (render). Fixes the stale-closure bug where a poller started right after
  // setCode read an empty captured `code`.
  const setCodeBoth = useCallback((c: string) => {
    s.current.code = c;
    setCode(c);
  }, []);

  const persist = useCallback(
    (extra?: Partial<{ code: string; role: string; title: string }>) => {
      try {
        sessionStorage.setItem(
          "meetS",
          JSON.stringify({
            code: extra?.code ?? code,
            hostToken: s.current.hostToken,
            joinToken: s.current.joinToken,
            jwt: identity?.jwt,
            role: extra?.role ?? role,
            name: identity?.name,
            email: identity?.email,
            title: extra?.title ?? title,
          }),
        );
      } catch {
        /* ignore */
      }
    },
    [code, role, title, identity],
  );

  // ---- Recorder wiring (shared by host + guest) ----
  const startRecorder = useCallback(
    async (joinToken: string, stream?: MediaStream | null): Promise<boolean> => {
      const rec = new MeetingRecorder(
        { code: s.current.code, joinToken, micDeviceId: s.current.micDeviceId, stream },
        {
          onState: (on, msg) => {
            setRecOn(on);
            setRecMsg(msg || "");
            if (on && !msg) {
              setMuted(false);
            }
          },
          onConnLost: (on) => setConnLost(on),
          onEnded: (reason) => {
            setRecOn(false);
            // Only 4003 (host ended) navigates; >=4000 ("stopped") keeps the screen with
            // the "Aufnahme beendet." label the recorder already set (vanilla parity).
            if (reason !== "ended") return;
            if (role === "guest") {
              setEndTitle("Meeting beendet");
              setEndSub("Danke fürs Dabeisein — der Host wertet das Meeting aus.");
              setEndSpin(false); // guest has no results to wait for
              go("ended");
            } else {
              setRecMsg("Meeting beendet");
            }
          },
        },
      );
      s.current.recorder = rec;
      return rec.start();
    },
    [role, go],
  );

  // ---- Pod guided auto-enrollment (TJ 2026-06-10) ----
  // Record a short Jabra clip while each participant reads their number → POST it; the
  // server hears the code + stores the voiceprint anchor. When everyone is done, recording
  // auto-starts. The host clicks nothing beyond "Aufnahme starten".
  const recordEnrollClip = useCallback(async (token: string): Promise<boolean> => {
    if (!s.current.enrollStream || s.current.enrollClipBusy) return false;
    s.current.enrollClipBusy = true;
    let matched = false;
    try {
      // Start almost immediately (just a MediaRecorder warm-up) so the FIRST digit isn't
      // clipped — people read the moment their number shows. Generous window captures the
      // full code at any pace. (Fix 2026-06-11: the 1.5s lead-in ate digit 1 → 57183→7183.)
      await new Promise((r) => setTimeout(r, 300));
      let mime = "audio/webm;codecs=opus";
      if (!(window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) mime = "audio/webm";
      const chunks: BlobPart[] = [];
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(s.current.enrollStream, { mimeType: mime });
      } catch {
        rec = new MediaRecorder(s.current.enrollStream);
      }
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };
      const stopped = new Promise<void>((res) => {
        rec.onstop = () => res();
      });
      rec.start();
      await new Promise((r) => setTimeout(r, 7000)); // ~7s: full 5-digit code at any pace
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      await stopped;
      const res = await api.enrollClip(s.current.code, s.current.hostToken, token, new Blob(chunks, { type: mime }));
      matched = !!(res && res.matched);
    } catch {
      /* ignore */
    }
    s.current.enrollClipBusy = false;
    return matched;
  }, []);

  const hostBeginRecording = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    s.current.enrolling = false;
    setEnrolling(false);
    if (s.current.enrollPollT) {
      clearTimeout(s.current.enrollPollT);
      s.current.enrollPollT = 0;
    }
    setHostEnroll(null);
    // Hand the already-open enroll stream to the recorder — ONE shared Jabra stream for
    // check-in + recording (identical to the tested flow; the mic is never closed+reopened).
    const es = s.current.enrollStream;
    s.current.enrollStream = null; // ownership moves to the recorder
    await api.startMeeting(s.current.code, s.current.hostToken);
    const ok = await startRecorder(s.current.joinToken, es);
    if (!ok) {
      try {
        es?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      return { ok: false, error: "Mikro-Zugriff nötig — bitte erlauben." };
    }
    return { ok: true };
  }, [startRecorder]);

  const enrollClipLoop = useCallback(async () => {
    if (!s.current.enrolling) return;
    const st = await api.enrollState(s.current.code, s.current.hostToken);
    setHostEnroll(st && st.active ? st : null);
    if (st && st.finished) {
      hostBeginRecording();
      return;
    }
    if (st) {
      // capture the clip for whoever is active now, once each. On a miss the person stays
      // active → the "✓ erkannt" fallback button still works.
      // Auto-clip the active person. RETRY up to 3× — a miss (e.g. a clipped digit) leaves
      // them active, so we try again instead of getting stuck (Fix 2026-06-11). On a match the
      // server marks them done → next person. After 3 misses the host's "✓ erkannt" takes over.
      const act = (st.roster || []).find((p: any) => p.status === "active");
      if (act) {
        const tries = s.current.enrollTried[act.token] || 0;
        if (tries < 3) {
          s.current.enrollTried[act.token] = tries + 1;
          await recordEnrollClip(act.token);
        }
      }
    }
    if (s.current.enrolling) s.current.enrollPollT = setTimeout(enrollClipLoop, 1500);
  }, [recordEnrollClip, hostBeginRecording]);

  const startGuidedEnroll = useCallback(async (): Promise<boolean> => {
    if (s.current.enrolling) return true;
    try {
      // same Jabra mic as the recording → consistent voiceprints (TJ 2026-06-10)
      const audio: MediaTrackConstraints = Object.assign(
        s.current.micDeviceId ? { deviceId: { exact: s.current.micDeviceId } } : {},
        { echoCancellation: true, noiseSuppression: true },
      );
      s.current.enrollStream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch {
      return false;
    }
    s.current.enrolling = true;
    s.current.enrollTried = {};
    setEnrolling(true);
    await api.enrollStart(s.current.code, s.current.hostToken);
    enrollClipLoop();
    return true;
  }, [enrollClipLoop]);

  // ---- Timer ----
  const stopTimer = useCallback(() => {
    if (s.current.timerInt) {
      clearInterval(s.current.timerInt);
      s.current.timerInt = 0;
    }
    setTimer("");
  }, []);
  const ensureTimer = useCallback(() => {
    if (s.current.timerInt) return;
    const tick = () => {
      const c = s.current;
      if (c.mtgStarted && c.mtgStatus === "recording") {
        const e = c.mtgNow - c.mtgStarted + (Date.now() / 1000 - c.mtgSyncAt);
        const fmt = (secs: number) => {
          let n = Math.max(0, Math.floor(secs));
          const h = Math.floor(n / 3600),
            m = Math.floor((n % 3600) / 60),
            x = n % 60,
            p = (v: number) => String(v).padStart(2, "0");
          return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
        };
        setTimer("· " + fmt(e));
      } else {
        setTimer("");
      }
    };
    s.current.timerInt = setInterval(tick, 1000);
    tick();
  }, []);

  // ---- Host participant poll ----
  const pollParticipants = useCallback(async () => {
    const d = await api.participants(s.current.code, s.current.hostToken);
    if (d) {
      if (d.started_at) {
        s.current.mtgStarted = d.started_at;
        s.current.mtgNow = d.now || Math.floor(Date.now() / 1000);
        s.current.mtgSyncAt = Date.now() / 1000;
        s.current.mtgStatus = d.status;
        ensureTimer();
      }
      setParticipants(d.participants || []);
    }
    if (s.current.deviceMode === "pod") {
      const st = await api.enrollState(s.current.code, s.current.hostToken);
      setHostEnroll(st && st.active ? st : null);
    }
    s.current.pollT = setTimeout(pollParticipants, 3000);
  }, [ensureTimer]);

  const hostEnrollStart = useCallback(async () => {
    await api.enrollStart(s.current.code, s.current.hostToken);
  }, []);
  const hostEnrollMark = useCallback(async (token: string, status: string) => {
    await api.enrollMark(s.current.code, s.current.hostToken, token, status);
    const st = await api.enrollState(s.current.code, s.current.hostToken);
    setHostEnroll(st && st.active ? st : null);
  }, []);


  const approve = useCallback(
    (token: string, ok: boolean) => {
      api.approveParticipant(s.current.code, s.current.hostToken, token, ok).then(() => pollParticipants());
    },
    [pollParticipants],
  );

  // ---- Host create ----
  const createMeeting = useCallback(
    async (setup: Setup): Promise<{ ok: boolean; error?: string }> => {
      if (!identity?.jwt) {
        onSsoLogin();
        return { ok: false };
      }
      const single = setup.device === "single";
      const cr = await api.createMeeting(identity.jwt, {
        host_name: identity.name,
        host_email: identity.email,
        title: setup.title || "",
        mode: setup.mode || "dsgvo",
        device_mode: setup.device || "multi",
        expected_speakers: single ? setup.spk || 2 : null,
        speaker_names: single ? setup.names : [],
        language: setup.language || "auto",
        scheduled_at: setup.scheduledAt || null,
      });
      if (!cr.ok) {
        return { ok: false, error: (cr.data.detail && (cr.data.detail.message || cr.data.detail)) || "Meeting konnte nicht erstellt werden (Account-Zugang?)." };
      }
      const newCode = cr.data.code;
      s.current.hostToken = cr.data.host_token;
      s.current.deviceMode = setup.device || "multi";
      setDeviceMode(setup.device || "multi");
      const newTitle = cr.data.title || setup.title;
      const jr = await api.joinMeeting(newCode, {
        name: identity.name,
        email: identity.email,
        source: "host",
        host_token: s.current.hostToken,
        ui_lang: UI_LANG(),
      });
      if (!jr.ok || !jr.data.join_token) return { ok: false, error: "Host-Beitritt fehlgeschlagen." };
      s.current.joinToken = jr.data.join_token;
      setRole("host");
      setCodeBoth(newCode);
      setTitle(newTitle || "Dein Meeting");
      if (single) {
        setSingleHint(
          setup.spk
            ? `Erwartet: ${setup.spk} Sprecher${setup.names.length ? " — " + setup.names.join(", ") : ""}. Alle über dieses Mikro — starte die Aufnahme, wenn ihr bereit seid.`
            : "Alle sprechen über dieses Mikro. Starte die Aufnahme, wenn ihr bereit seid.",
        );
      }
      persist({ code: newCode, role: "host", title: newTitle });
      go("host");
      pollParticipants();
      return { ok: true };
    },
    [identity, onSsoLogin, persist, go, pollParticipants],
  );

  const hostStartRec = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (s.current.schedTimer) {
      clearTimeout(s.current.schedTimer);
      s.current.schedTimer = 0;
    }
    // Pod mode: guided voice-enrollment first, THEN recording (host clicks nothing more).
    if (s.current.deviceMode === "pod") {
      const ok = await startGuidedEnroll();
      return ok ? { ok: true } : { ok: false, error: "Mikro-Zugriff nötig — bitte erlauben." };
    }
    await api.startMeeting(s.current.code, s.current.hostToken);
    const ok = await startRecorder(s.current.joinToken);
    if (!ok) return { ok: false, error: "Mikro-Zugriff nötig — bitte erlauben." };
    return { ok: true };
  }, [startRecorder, startGuidedEnroll]);

  // Scheduled start: store the timer id so hostStartRec/reschedule can clear it (fix #7).
  const scheduleStart = useCallback((at: number) => {
    if (s.current.schedTimer) clearTimeout(s.current.schedTimer);
    s.current.schedTimer = setTimeout(() => hostStartRec(), at);
  }, [hostStartRec]);

  // Explanations may lag the transcript — keep polling (20×/15s) and merge when they
  // arrive, so drill-down items become clickable (vanilla _pollExplain).
  const pollExplain = useCallback((codeArg: string, token: string, tries: number) => {
    if (tries <= 0) return;
    setTimeout(async () => {
      const d = await api.transcript(codeArg, token);
      if (d && Array.isArray(d.explain_json) && d.explain_json.length) {
        setResult((prev) => (prev ? { ...prev, explain: d.explain_json } : prev));
        return;
      }
      pollExplain(codeArg, token, tries - 1);
    }, 15000);
  }, []);

  const startResults = useCallback(
    (codeArg: string, token: string) => {
      const gen = ++s.current.resultsGen; // invalidate any previous/parallel transcript poll
      const STAGES = [
        "🎧 Audio wird transkribiert…",
        "🧠 Gespräch wird analysiert…",
        "🗂️ Themen werden herausgearbeitet…",
        "📋 Entscheidungen & Aufgaben…",
        "🔗 Abgleich mit dem Gedächtnis…",
      ];
      let i = 0;
      setStageText(STAGES[0]);
      if (s.current.stageInt) clearInterval(s.current.stageInt);
      s.current.stageInt = setInterval(() => {
        i = (i + 1) % STAGES.length;
        setStageText(STAGES[i]);
      }, 2600);
      const poll = async () => {
        if (gen !== s.current.resultsGen) return; // a newer startResults superseded this poll
        const d = await api.transcript(codeArg, token);
        if (gen !== s.current.resultsGen) return; // superseded during the await → stop (kein 5s-Re-Render-Loop)
        if (d && d.ready) {
          if (s.current.stageInt) {
            clearInterval(s.current.stageInt);
            s.current.stageInt = 0;
          }
          setStageText("");
          setEndSpin(false);
          setEndSub("Fertig ausgewertet.");
          setResult({
            minutesMd: d.minutes_markdown || "",
            minutesMdOrig: d.minutes_markdown || "",
            transcriptMd: d.transcript_markdown || "",
            bezugMd: d.bezug_markdown || "",
            meta: { title: d.title || title || "", host_name: d.host_name || "" },
            deviceMode: d.device_mode || "multi",
            spkPool: Array.isArray(d.speaker_names) ? d.speaker_names : [],
            explain: Array.isArray(d.explain_json) ? d.explain_json : [],
          });
          if (!(Array.isArray(d.explain_json) && d.explain_json.length)) pollExplain(codeArg, token, 20);
          return;
        }
        if (d) {
          // Processing transparency (vanilla _showProcEta): queue position OR rough remaining time.
          const txt =
            d.post_status === "queued" && (d.queue_ahead || 0) > 0
              ? d.queue_ahead === 1
                ? "1 Meeting ist noch vor deinem dran…"
                : d.queue_ahead + " Meetings sind noch vor deinem dran…"
              : (d.eta_s || 0) > 0
                ? "Wird ausgewertet — ca. " + Math.max(1, Math.ceil(d.eta_s / 60)) + " Min…"
                : null;
          if (txt) setEndSub(txt);
        }
        if (gen === s.current.resultsGen) setTimeout(poll, 5000);
      };
      poll();
    },
    [title, pollExplain],
  );

  // Recap deep-link view (`/<code>?t=`) — view-only results, no live session.
  const openRecapView = useCallback(
    (c: string, token: string) => {
      setCodeBoth(c);
      s.current.joinToken = token;
      setEndTitle("Meeting-Protokoll");
      setEndSub("");
      setEndSpin(true);
      go("ended");
      startResults(c, token);
    },
    [go, startResults],
  );

  const clearTimers = useCallback(() => {
    if (s.current.pollT) clearTimeout(s.current.pollT);
    if (s.current.endWatch) clearTimeout(s.current.endWatch);
    if (s.current.enrollPollT) clearTimeout(s.current.enrollPollT);
    s.current.pollT = 0;
    s.current.endWatch = 0;
    s.current.enrollPollT = 0;
    s.current.enrolling = false;
    try {
      s.current.enrollStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    s.current.enrollStream = null;
  }, []);

  const hostEnd = useCallback(async () => {
    s.current.recorder?.stop();
    stopTimer();
    clearTimers();
    await api.endMeeting(s.current.code, s.current.hostToken);
    try {
      sessionStorage.removeItem("meetS");
    } catch {
      /* ignore */
    }
    setEndTitle("Meeting beendet");
    setEndSub("Dein Deep-Dive wird erstellt — Transkript, Themen, Entscheidungen.");
    setEndSpin(true);
    go("ended");
    startResults(s.current.code, s.current.hostToken);
  }, [stopTimer, clearTimers, go, startResults]);

  // ---- Guest ----
  const peekT = useRef<any>(0);
  const peekMeeting = useCallback((c: string) => {
    clearTimeout(peekT.current);
    if (c.length !== 6) {
      setTitle("");
      setPeekHost("");
      return;
    }
    peekT.current = setTimeout(async () => {
      const info = await api.meetingInfo(c);
      if (info && (info.status === "open" || info.status === "recording")) {
        if (info.device_mode) s.current.deviceMode = info.device_mode;
        setTitle(info.title || "");
        setPeekHost(info.host_name || "");
      }
    }, 350);
  }, []);

  const guestStatusWatch = useCallback(() => {
    api.meetingInfo(s.current.code).then(async (info) => {
      if (info && info.device_mode) {
        s.current.deviceMode = info.device_mode;
        setDeviceMode(info.device_mode);
      }
      if (info && (info.status === "ended" || info.status === "purged")) {
        s.current.recorder?.stop();
        setEndTitle("Meeting beendet");
        setEndSub("Der Host hat das Meeting beendet — danke fürs Dabeisein.");
        setEndSpin(false); // guest has no results to wait for
        go("ended");
        return;
      }
      if (s.current.deviceMode === "pod") {
        // Pod: central mic records; guest only checks in by voice. Poll enrollment.
        const est = await api.enrollState(s.current.code, s.current.joinToken);
        if (est && est.active) {
          setEnroll(est);
          go("enroll");
        } else {
          setEnroll(null);
          setPodGuest(true);
          setPodRecording(!!(info && info.status === "recording"));
          go("guest");
        }
      } else if (info && info.status === "recording" && !s.current.recorder?.isRecording()) {
        if (s.current.micReady) {
          setGuestHint("Aufnahme läuft — leg das Handy hin.");
          startRecorder(s.current.joinToken);
        } else {
          // Mic was denied at join → can't auto-start; offer a manual start (vanilla parity).
          setGuestStartVisible(true);
          setGuestRecText("Host nimmt auf");
          setGuestHint("Tippe zum Aufnehmen — Mikro-Zugriff nötig.");
        }
      }
      s.current.endWatch = setTimeout(guestStatusWatch, 3000);
    });
  }, [go, startRecorder]);

  const pollApproval = useCallback(() => {
    api.guestStatus(s.current.code, s.current.joinToken).then((res) => {
      if (!res) {
        s.current.pollT = setTimeout(pollApproval, 2500);
        return;
      }
      if (res.status === 404) {
        setWaitSub("Vom Host abgelehnt.");
        return;
      }
      const d = res.data;
      if (d.meeting_status === "ended" || d.meeting_status === "purged") {
        setEndSub("Das Meeting wurde beendet.");
        setEndSpin(false);
        go("ended");
        return;
      }
      if (!d.pending) {
        go("guest");
        guestStatusWatch();
        return;
      }
      s.current.pollT = setTimeout(pollApproval, 2500);
    });
  }, [go, guestStatusWatch]);

  const guestJoin = useCallback(
    async (c: string, name: string, email: string, fromLink: boolean): Promise<{ ok: boolean; error?: string }> => {
      if (c.length !== 6) return { ok: false, error: "6-stelliger Code nötig." };
      if (!name) return { ok: false, error: "Bitte Namen eingeben." };
      if (email && !email.includes("@")) return { ok: false, error: "E-Mail sieht ungültig aus — korrigieren oder leer lassen." };
      s.current.micReady = false;
      if (s.current.deviceMode !== "pod") {
        try {
          const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          ms.getTracks().forEach((t) => t.stop());
          s.current.micReady = true;
        } catch {
          // mic denied — guest can still join, will get a manual-start button
          s.current.micReady = false;
        }
      }
      s.current.fromLink = fromLink;
      const jr = await api.joinMeeting(c, { name, email, source: fromLink ? "qr" : "code", ui_lang: UI_LANG() });
      if (!jr.ok || !jr.data.join_token) {
        return { ok: false, error: (jr.data.detail && (jr.data.detail.message || jr.data.detail)) || "Beitritt fehlgeschlagen (Code korrekt? Meeting noch offen?)." };
      }
      s.current.joinToken = jr.data.join_token;
      setCodeBoth(c);
      setRole("guest");
      setTitle(jr.data.meeting_title || "");
      persist({ code: c, role: "guest", title: jr.data.meeting_title || "" });
      if (jr.data.pending) {
        setWaitSub("„" + (jr.data.meeting_title || "Meeting") + '" · Host: ' + (jr.data.host_name || "—"));
        go("waiting");
        pollApproval();
      } else {
        go("guest");
        guestStatusWatch();
      }
      return { ok: true };
    },
    [persist, go, pollApproval, guestStatusWatch],
  );

  const guestStartRec = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const ok = await startRecorder(s.current.joinToken);
    if (!ok) return { ok: false, error: "Mikro-Zugriff nötig — bitte erlauben." };
    s.current.micReady = true;
    setGuestStartVisible(false);
    setGuestHint("Aufnahme läuft — leg das Handy hin.");
    return { ok: true };
  }, [startRecorder]);

  const toggleMute = useCallback(() => {
    const m = s.current.recorder?.toggleMute() ?? false;
    setMuted(m);
  }, []);

  const leave = useCallback(() => {
    s.current.recorder?.stop();
    clearTimers();
    setEnrolling(false);
    // Persistierte Session löschen — sonst lädt der Reload das verlassene Meeting wieder
    // (Bug 2026-06-11: Reload-Loop + abgelaufener JWT).
    try {
      sessionStorage.removeItem("meetS");
    } catch {
      /* ignore */
    }
    s.current.hostToken = "";
    s.current.joinToken = "";
    s.current.recorder = null;
    setResult(null);
    setRole(null);
    setCodeBoth("");
    go("landing");
  }, [clearTimers, go, setCodeBoth]);

  const hostEntry = useCallback(() => {
    if (identity?.jwt) go("hostlogin");
    else onSsoLogin();
  }, [identity, go, onSsoLogin]);

  const setMicDevice = useCallback((id: string | null) => {
    s.current.micDeviceId = id;
  }, []);

  // ---- Boot / restore (called from App after handleSsoCallback/restoreSession) ----
  const resumeHost = useCallback(
    (info: any, session: any) => {
      s.current.hostToken = session.hostToken || "";
      s.current.joinToken = session.joinToken || "";
      s.current.micReady = true; // host restored an active session; allow resume-record
      setResumeRecording(info.status === "recording");
      setRole("host");
      setCodeBoth(session.code);
      setTitle(info.title || session.title || "Dein Meeting");
      if (info.device_mode) {
        s.current.deviceMode = info.device_mode;
        setDeviceMode(info.device_mode);
      }
      go("host");
      pollParticipants();
    },
    [go, pollParticipants, setCodeBoth],
  );
  const resumeGuest = useCallback(
    (info: any, session: any) => {
      s.current.joinToken = session.joinToken || "";
      s.current.micReady = true;
      setResumeRecording(info.status === "recording");
      setRole("guest");
      setCodeBoth(session.code);
      setTitle(info.title || session.title || "Du bist dabei");
      if (info.device_mode) {
        s.current.deviceMode = info.device_mode;
        setDeviceMode(info.device_mode);
      }
      go("guest");
      guestStatusWatch();
    },
    [go, guestStatusWatch, setCodeBoth],
  );

  // ---- Results extras (protocol translation / recap / intel) ----
  const ensureProtocolLang = useCallback(
    async (lang: string): Promise<string> => {
      const cache = s.current.protoCache;
      if (cache[lang]) return cache[lang];
      const tok = s.current.hostToken || s.current.joinToken || "";
      if (s.current.hostToken) await api.requestTranslate(s.current.code, s.current.hostToken, lang);
      for (let i = 0; i < 40; i++) {
        const d = await api.protocol(s.current.code, lang, tok);
        if (d.ready && d.markdown) {
          cache[lang] = d.markdown;
          return d.markdown;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      throw new Error("timeout");
    },
    [],
  );

  const translateProtocol = useCallback(
    async (lang: string): Promise<string> => {
      if (lang === "orig") return result?.minutesMdOrig || "";
      return ensureProtocolLang(lang);
    },
    [result, ensureProtocolLang],
  );

  const recapParticipants = useCallback(async (): Promise<any[]> => {
    const d = await api.participants(s.current.code, s.current.hostToken);
    return d ? (d.participants || []).filter((p: any) => !p.pending) : [];
  }, []);

  const sendRecapTo = useCallback(
    async (recipients: { token: string; email: string; lang: string }[]): Promise<{ ok: boolean; sent?: number; error?: string }> => {
      const langs = [...new Set(recipients.map((r) => r.lang).filter((l) => l && l !== "orig"))];
      for (const lc of langs) {
        try {
          await ensureProtocolLang(lc);
        } catch {
          /* best-effort: send original if translation times out */
        }
      }
      const r = await api.sendRecap(s.current.code, s.current.hostToken, recipients);
      if (r.ok) return { ok: true, sent: r.data.sent || 0 };
      return { ok: false, error: r.data.error || "Senden fehlgeschlagen." };
    },
    [ensureProtocolLang],
  );

  const runIntel = useCallback(
    async (action: string) => {
      return api.intel(s.current.code, action, identity?.jwt || "", s.current.hostToken);
    },
    [identity],
  );

  // ---- Account history (Verlauf) — the caller's own meetings, re-openable ----
  const loadMyMeetings = useCallback(async (): Promise<any[]> => {
    if (!identity?.jwt) return [];
    return api.myMeetings(identity.jwt);
  }, [identity]);

  const openHistoryMeeting = useCallback(
    async (c: string, hostToken: string) => {
      clearTimers();
      s.current.hostToken = hostToken;
      s.current.joinToken = "";
      s.current.protoCache = {};
      setCodeBoth(c);
      setRole("host");
      // Geplantes/laufendes Meeting (noch kein Protokoll) → Host-Room zum Starten;
      // beendetes → Protokoll/Result. Verhindert endloses "wird ausgewertet", wenn man
      // ein terminiertes Meeting aus dem Verlauf zum Start wieder öffnet (TJ 2026-06-11).
      const info = await api.meetingInfo(c);
      if (info && info.status !== "ended" && info.status !== "purged") {
        resumeHost(info, { code: c, hostToken });
        return;
      }
      setResult(null);
      setEndTitle("Meeting-Protokoll");
      setEndSub("Lade Protokoll…");
      setEndSpin(true);
      go("ended");
      startResults(c, hostToken);
    },
    [clearTimers, setCodeBoth, go, startResults, resumeHost],
  );

  const canRecap = role === "host";
  const canIntel = !!(identity?.jwt && decodeJwt(identity.jwt).op === true);

  const value: MeetingState = {
    screen, identity, role, code, title, deviceMode, participants,
    recOn, recMsg, connLost, muted, timer,
    guestStartVisible, guestHint, guestRecText, waitSub,
    endTitle, endSub, endSpin, stageText, result, canRecap, canIntel,
    enroll, hostEnroll, enrolling, podGuest, podRecording, pendingJoinCode, resumeRecording, peekHost, singleHint,
    setIdentity, go, goJoin, openRecapView, hostEntry, createMeeting, approve, hostStartRec, scheduleStart, hostEnd,
    peekMeeting, guestJoin, guestStartRec, toggleMute, leave, resumeHost, resumeGuest,
    hostEnrollStart, hostEnrollMark, setMicDevice,
    translateProtocol, recapParticipants, sendRecapTo, runIntel,
    loadMyMeetings, openHistoryMeeting,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMeeting(): MeetingState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMeeting must be used within MeetingProvider");
  return c;
}
