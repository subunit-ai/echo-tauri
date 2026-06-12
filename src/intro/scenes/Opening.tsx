import { useTranslation } from "react-i18next";
import { BrandMark } from "../../components/BrandMark";
import { useTypewriter } from "../useTypewriter";
import type { SceneProps } from "../Intro";

// Cinematic opening: brand blooms in, the tagline types itself, then the
// call-to-action fades up. The aurora behind runs at full strength here.
export function Opening({ next }: SceneProps) {
  const { t } = useTranslation();
  const { shown, done } = useTypewriter(t("intro.tagline"), { cps: 20, startDelay: 700 });

  return (
    <div className="intro-brand">
      <BrandMark size={76} />
      <h1 className="intro-wordmark">Echo</h1>
      <p className={`intro-tagline ${done ? "" : "intro-caret"}`}>{shown}</p>
      {done ? (
        <button type="button" className="intro-btn intro-fade-late" autoFocus onClick={next}>
          {t("intro.begin")}
        </button>
      ) : (
        <div style={{ height: 42 }} />
      )}
    </div>
  );
}
