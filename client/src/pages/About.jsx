import { useLang } from "../context/LangContext";

export default function About() {
  const { t } = useLang();
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <img src="/logo.png" alt="" className="mb-6 h-16 w-16" />
      <h1 className="font-display text-4xl text-brown">{t.aboutTitle}</h1>
      <p className="mt-6 text-lg leading-8 text-brown/75">{t.aboutBody}</p>
    </div>
  );
}
