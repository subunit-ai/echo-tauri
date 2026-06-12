import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Header } from "./components/Header";
import { Sidebar, type Section } from "./components/Sidebar";
import { SoundFx } from "./components/SoundFx";
import { History } from "./sections/History";
import { Home } from "./sections/Home";
import { Meetings } from "./sections/Meetings";
import { MeetLive } from "./sections/MeetLive";
import { Intro } from "./intro/Intro";
import { Settings } from "./sections/Settings";
import { Vocabulary } from "./sections/Vocabulary";
import { MeetingPrompt } from "./components/MeetingPrompt";
import { onState, onNeedsAccessibility } from "./lib/ipc";
import { ConfigProvider, useConfig } from "./state/ConfigContext";
import { ToastProvider, useToast } from "./state/ToastContext";

function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="section-title">{title}</h1>
      <div className="empty">{t("app.comingSoon")}</div>
    </div>
  );
}

function Shell() {
  const { t } = useTranslation();
  const { config } = useConfig();
  const [section, setSection] = useState<Section>("home");
  const [meetLive, setMeetLive] = useState(false);

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
      <Header />
      {/* Sidebar stays static even while the meeting view is open — selecting any section
          exits the meeting and navigates there. The native meet renders in the content pane
          (an isolated iframe), so the left nav never moves.
          "Live-Meeting" ist ein eigener Sidebar-Eintrag (TJ 2026-06-12) und startet die
          native Meet-View DIREKT — kein Zwischenschritt über eine Launcher-Karte. */}
      <Sidebar
        active={meetLive ? "meetlive" : section}
        onSelect={(s) => {
          if (s === "meetlive") {
            setMeetLive(true);
            return;
          }
          setMeetLive(false);
          setSection(s);
        }}
      />
      {meetLive ? (
        <main className="content content-meet" key="meet">
          <MeetLive />
        </main>
      ) : (
        <main className="content" key={section}>
          <div className="page-animate">
            {section === "home" && <Home onStartMeeting={() => setMeetLive(true)} />}
            {section === "history" && <History />}
            {section === "settings" && <Settings />}
            {section === "meetings" && <Meetings />}
            {section === "vocabulary" && <Vocabulary />}
            {section === "help" && <Placeholder title={t("app.help")} />}
          </div>
        </main>
      )}
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
    return () => {
      sub.then((un) => un());
      ax.then((un) => un());
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
