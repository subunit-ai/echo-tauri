import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Header } from "./components/Header";
import { Sidebar, type Section } from "./components/Sidebar";
import { SoundFx } from "./components/SoundFx";
import { Help } from "./sections/Help";
import { History } from "./sections/History";
import { Home } from "./sections/Home";
import { Notes } from "./sections/Notes";
import { Activity } from "./sections/Activity";
import { Meetings } from "./sections/Meetings";
import { Learning } from "./sections/Learning";
import { Intro } from "./intro/Intro";
import { Settings, type SettingsTab } from "./sections/Settings";
import { Vocabulary } from "./sections/Vocabulary";
import { MeetingPrompt } from "./components/MeetingPrompt";
import { SessionBanner } from "./components/SessionBanner";
import { WhatsNew } from "./components/WhatsNew";
import { onState, onNeedsAccessibility, onLearningReward, onWordFind } from "./lib/ipc";
import { ConfigProvider, useConfig } from "./state/ConfigContext";
import { ToastProvider, useToast } from "./state/ToastContext";

function Shell() {
  const { t } = useTranslation();
  const { config } = useConfig();
  const [section, setSection] = useState<Section>("home");
  // Meeting is now ONE section with two native modes: "cloud" (the Liquid-Glass
  // cloud meet) and "local" (the on-device Pro flow). The former separate
  // Live-Meeting sidebar entry folds in here.
  const [meetingTab, setMeetingTab] = useState<"cloud" | "local">("cloud");
  // Signals that the cloud tab was opened via Home's "Meeting starten" → land on
  // host setup. Cleared whenever the user manually switches the sub-tab.
  const [meetingAutostart, setMeetingAutostart] = useState(false);
  const openMeeting = (tab: "cloud" | "local", autostart = false) => {
    setMeetingTab(tab);
    setMeetingAutostart(autostart);
    setSection("meetings");
  };
  const onMeetingTab = (tab: "cloud" | "local") => {
    setMeetingTab(tab);
    setMeetingAutostart(false);
  };
  // Settings' active tab is lifted here so the bottom-left account card can deep-
  // link straight into the Account tab (and the greeting's "edit name" too).
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("allgemein");
  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setSection("settings");
  };

  // Section switching must feel INSTANT. We deliberately do NOT key <main> on the
  // section: a key forces React to tear down + rebuild the whole content subtree
  // (incl. re-rasterizing its backdrop-filter glass layer) and replays the
  // fade-in-up entrance on every click — which reads as a delay. Instead the
  // wrapper persists (entrance plays once, on first load) and only the inner
  // section swaps. We just reset scroll so a freshly opened section starts at top.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [section]);

  if (!config) {
    return <div className="empty" style={{ paddingTop: 90 }}>{t("common.loading")}</div>;
  }
  if (!config.has_seen_onboarding) {
    return <Intro />;
  }
  return (
    <div className="app">
      <SoundFx />
      <MeetingPrompt />
      <SessionBanner />
      {/* One-shot "what's new" popup after an update; "see all" opens the full changelog modal. */}
      <WhatsNew />
      <Header />
      {/* Offline- and Live-Meeting now live under the single "Meeting" section (its own
          sub-tab switcher); the sidebar just navigates to it. */}
      <Sidebar active={section} onSelect={setSection} onAccount={() => openSettings("account")} />
      <main className="content" ref={mainRef}>
        <div className="page-animate">
          {section === "home" && <Home onStartMeeting={() => openMeeting("cloud", true)} onOpenAccount={() => openSettings("account")} />}
          {section === "notes" && <Notes />}
          {section === "history" && <History />}
          {section === "activity" && <Activity />}
          {section === "settings" && <Settings tab={settingsTab} onTab={setSettingsTab} />}
          {section === "meetings" && <Meetings tab={meetingTab} onTab={onMeetingTab} autostart={meetingAutostart} />}
          {section === "vocabulary" && <Vocabulary />}
          {section === "learning" && <Learning />}
          {section === "help" && <Help />}
        </div>
      </main>
    </div>
  );
}

// Surfaces engine errors (mic open failed, live-server unreachable, …) as a
// toast from anywhere in the app — not just when the record panel is on screen.
function EngineErrorToasts() {
  const toast = useToast();
  const { t } = useTranslation();
  useEffect(() => {
    const sub = onState((p) => {
      if (p.state === "error" && p.detail) toast(p.detail, "error");
    });
    // macOS: auto-paste was blocked for lack of Accessibility permission. Text is on
    // the clipboard; nudge the user to grant it so future pastes land automatically.
    const ax = onNeedsAccessibility(() => toast(t("perm.needsAccessibility"), "error"));
    // Gamification: taught vocabulary used in a dictation → celebrate in-app
    // (the native notification covers the backgrounded case).
    const reward = onLearningReward((r) => {
      const first = r.events[0];
      if (!first) return;
      const xp = r.events.reduce((sum, e) => sum + e.xp, 0);
      const key = first.kind === "word_of_day" ? "learning.rewardWodToast" : "learning.rewardCoachToast";
      toast(t(key, { word: first.word, xp, count: r.events.length - 1 }), "success");
    });
    // Wortdex: a new collectible word was just spoken → celebrate with a band-
    // specific toast (the native notification covers selten/legendär in the
    // background; this is the in-app counterpart, and the only cue for notable).
    const find = onWordFind((f) => {
      const key =
        f.band === 3
          ? "learning.findToastLegendary"
          : f.band === 2
            ? "learning.findToastRare"
            : "learning.findToastNotable";
      toast(t(key, { word: f.display, xp: f.xp, dex: f.dex }), "success");
    });
    return () => {
      sub.then((un) => un());
      ax.then((un) => un());
      reward.then((un) => un());
      find.then((un) => un());
    };
  }, [toast, t]);
  return null;
}

export default function App() {
  return (
    <ToastProvider>
      <EngineErrorToasts />
      <ConfigProvider>
        <Shell />
      </ConfigProvider>
    </ToastProvider>
  );
}
