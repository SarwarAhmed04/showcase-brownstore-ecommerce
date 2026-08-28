import { useLang } from "../context/LangContext";

export default function Contact() {
  const { t } = useLang();
  const cards = [
    { label: t.phone, value: "+964 773 802 9000", href: "tel:+9647738029000" },
    { label: t.email, value: "info@ibsher.com", href: "mailto:info@ibsher.com" },
    { label: t.hours, value: t.hoursValue },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <h1 className="font-display text-4xl text-brown">{t.contactTitle}</h1>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5"
          >
            <p className="text-sm font-semibold text-tan">{card.label}</p>
            {card.href ? (
              <a href={card.href} className="mt-2 block text-lg text-brown" dir="ltr">
                {card.value}
              </a>
            ) : (
              <p className="mt-2 text-lg text-brown">{card.value}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
