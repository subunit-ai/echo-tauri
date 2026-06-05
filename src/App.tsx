import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Header } from "./components/Header";
import { Sidebar, type Section } from "./components/Sidebar";
import { SoundFx } from "./components/SoundFx";
import { History } from "./sections/History";
import { Home } from "./sections/Home";
import { Meetings } from "./sections/Meetings";
import { Onboarding } from "./sections/Onboarding";
import { Settings } from "./sections/Settings";
import { Vocabulary } from "./sections/Vocabulary";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { MeetingPrompt } from "./components/MeetingPrompt";
import { onState } from "./lib/ipc";
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

  if (!config) {
    return <div className="empty" style={{ paddingTop: 90 }}>{t("common.loading")}</div>;
  }
  if (!config.has_seen_onboarding) {
    return <Onboarding />;
  }

  return (
    <div className="app">
      <SoundFx />
      <UpdatePrompt />
      <MeetingPrompt />
      <Header />
      <Sidebar active={section} onSelect={setSection} />
      <main className="content" key={section}>
        <div className="page-animate">
          {section === "home" && <Home />}
          {section === "history" && <History />}
          {section === "settings" && <Settings />}
          {section === "meetings" && <Meetings />}
          {section === "vocabulary" && <Vocabulary />}
          {section === "help" && <Placeholder title={t("app.help")} />}
        </div>
      </main>
    </div>
  );
}

// Surfaces engine errors (mic open failed, live-server unreachable, …) as a
// toast from anywhere in the app — not just when the record panel is on screen.
function EngineErrorToasts() {
  const toast = useToast();
  useEffect(() => {
    const sub = onState((p) => {
      if (p.state === "error" && p.detail) toast(p.detail, "error");
    });
    return () => {
      sub.then((un) => un());
    };
  }, [toast]);
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
