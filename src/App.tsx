import { useState } from "react";
import { Header } from "./components/Header";
import { Sidebar, type Section } from "./components/Sidebar";
import { SoundFx } from "./components/SoundFx";
import { History } from "./sections/History";
import { Home } from "./sections/Home";
import { Onboarding } from "./sections/Onboarding";
import { Settings } from "./sections/Settings";
import { Vocabulary } from "./sections/Vocabulary";
import { ConfigProvider, useConfig } from "./state/ConfigContext";

function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h1 className="section-title">{title}</h1>
      <div className="empty">Kommt in einer der nächsten Phasen.</div>
    </div>
  );
}

function Shell() {
  const { config } = useConfig();
  const [section, setSection] = useState<Section>("home");

  if (!config) {
    return <div className="empty" style={{ paddingTop: 90 }}>Lädt…</div>;
  }
  if (!config.has_seen_onboarding) {
    return <Onboarding />;
  }

  return (
    <div className="app">
      <SoundFx />
      <Header />
      <Sidebar active={section} onSelect={setSection} />
      <main className="content">
        {section === "home" && <Home />}
        {section === "history" && <History />}
        {section === "settings" && <Settings />}
        {section === "meetings" && <Placeholder title="Meetings" />}
        {section === "vocabulary" && <Vocabulary />}
        {section === "help" && <Placeholder title="Hilfe" />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ConfigProvider>
      <Shell />
    </ConfigProvider>
  );
}
