import { useState } from "react";
import { Header } from "./components/Header";
import { Sidebar, type Section } from "./components/Sidebar";
import { History } from "./sections/History";
import { Home } from "./sections/Home";
import { Settings } from "./sections/Settings";
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

  return (
    <div className="app">
      <Header />
      <Sidebar active={section} onSelect={setSection} />
      <main className="content">
        {section === "home" && <Home />}
        {section === "history" && <History />}
        {section === "settings" && <Settings />}
        {section === "meetings" && <Placeholder title="Meetings" />}
        {section === "vocabulary" && <Placeholder title="Vocabulary" />}
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
