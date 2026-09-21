import { useEffect, useState } from "react";
import { api } from "../../api";
import { useLang } from "../../context/LangContext";
import { imgUrl } from "../../lib/img";
import { bannerUploadSize, fileToJpegDataUrl } from "../../lib/imageUpload";
import Spinner from "../../components/Spinner";
import { BannerCopy } from "../../components/HomeBanners";

const ALIGNS = [
  "top-start",
  "top-center",
  "top-end",
  "middle-start",
  "middle-center",
  "middle-end",
  "bottom-start",
  "bottom-center",
  "bottom-end",
];

const DURATIONS = ["1d", "7d", "30d", "unlimited"];

function emptyLoc() {
  return { ku: "", en: "", ar: "" };
}

function remainingLabel(item, t) {
  if (!item.expiresAt || item.duration === "unlimited") return t.bannerUnlimitedLive;
  const ms = new Date(item.expiresAt).getTime() - Date.now();
  if (ms <= 0) return t.bannerExpired;
  const days = Math.floor(ms / 86400000);
  const hours = Math.max(1, Math.floor((ms % 86400000) / 3600000));
  if (days > 0) return t.bannerRemainingDays.replace("{n}", String(days));
  return t.bannerRemainingHours.replace("{n}", String(hours));
}

function LocFields({ label, value, onChange, t }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-brown/50">{label}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input
          value={value.ku}
          onChange={(event) => onChange({ ...value, ku: event.target.value })}
          placeholder={t.nameKu}
          className="rounded-xl border border-brown/10 bg-cream px-3 py-2 text-sm text-brown outline-none focus:ring-2 focus:ring-tan"
        />
        <input
          value={value.en}
          onChange={(event) => onChange({ ...value, en: event.target.value })}
          placeholder={t.nameEn}
          className="rounded-xl border border-brown/10 bg-cream px-3 py-2 text-sm text-brown outline-none focus:ring-2 focus:ring-tan"
        />
        <input
          value={value.ar}
          onChange={(event) => onChange({ ...value, ar: event.target.value })}
          placeholder={t.nameAr}
          className="rounded-xl border border-brown/10 bg-cream px-3 py-2 text-sm text-brown outline-none focus:ring-2 focus:ring-tan"
        />
      </div>
    </div>
  );
}

function SlotCard({ item, t, busySlot, onUpload, onRemove, onMove, onSave }) {
  const slider = item.slot <= 3;
  const [title, setTitle] = useState(item.title || emptyLoc());
  const [subtitle, setSubtitle] = useState(item.subtitle || emptyLoc());
  const [textAlign, setTextAlign] = useState(item.textAlign || "bottom-start");
  const [link, setLink] = useState(item.link || "");
  const [duration, setDuration] = useState(item.duration || "unlimited");

  useEffect(() => {
    setTitle(item.title || emptyLoc());
    setSubtitle(item.subtitle || emptyLoc());
    setTextAlign(item.textAlign || "bottom-start");
    setLink(item.link || "");
    setDuration(item.duration || "unlimited");
  }, [item]);

  return (
    <article className="rounded-[1.5rem] bg-white p-5 shadow-sm ring-1 ring-brown/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-xl text-brown">
            {t.bannerSlot} {item.slot}
          </p>
          <p className="mt-1 text-sm text-brown/50">
            {slider ? t.bannerSliderHint : t.bannerInlineHint}
          </p>
          <p className="mt-2 text-xs font-semibold tracking-wide text-brown/40">
            {slider ? t.bannerSizeSlider : t.bannerSizeInline}
          </p>
          {item.image ? (
            <p className={`mt-2 text-xs font-semibold ${item.expired ? "text-red-700" : "text-brown/45"}`}>
              {remainingLabel(item, t)}
            </p>
          ) : null}
        </div>
        <label className="text-xs font-semibold text-brown/50">
          {t.bannerPosition}
          <select
            value={item.slot}
            disabled={Boolean(busySlot)}
            onChange={(event) => onMove(item.slot, Number(event.target.value))}
            className="ms-2 rounded-full border border-brown/10 bg-cream px-3 py-1.5 text-sm font-semibold text-brown"
          >
            {[1, 2, 3, 4, 5].map((slot) => (
              <option key={slot} value={slot}>
                {slot}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className={`relative mt-4 overflow-hidden rounded-2xl bg-cream ${
          slider ? "aspect-[3/1]" : "aspect-[4/1]"
        }`}
      >
        {item.image ? (
          <>
            <img src={imgUrl(item.image)} alt="" className="h-full w-full object-cover" />
            <BannerCopy banner={{ ...item, title, subtitle, textAlign }} compact={!slider} />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-brown/30">
            {t.bannerEmpty}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <label className="cursor-pointer rounded-full bg-tan px-4 py-2 text-xs font-semibold text-brown">
          {t.changeImage}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            disabled={Boolean(busySlot)}
            onChange={(event) => onUpload(item.slot, event)}
          />
        </label>
        {item.image ? (
          <button
            type="button"
            disabled={Boolean(busySlot)}
            onClick={() => onRemove(item.slot)}
            className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-brown ring-1 ring-brown/10"
          >
            {t.bannerRemove}
          </button>
        ) : null}
        {busySlot === item.slot ? (
          <span className="self-center text-xs text-brown/40">{t.loading}</span>
        ) : null}
      </div>

      <div className="mt-5 space-y-4 border-t border-brown/10 pt-4">
        <LocFields label={t.bannerTitle} value={title} onChange={setTitle} t={t} />
        <LocFields label={t.bannerSubtitle} value={subtitle} onChange={setSubtitle} t={t} />
        <label className="block">
          <p className="mb-1.5 text-xs font-semibold text-brown/50">{t.bannerLink}</p>
          <input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder={t.bannerLinkHint}
            dir="ltr"
            className="w-full rounded-xl border border-brown/10 bg-cream px-3 py-2 text-sm text-brown outline-none focus:ring-2 focus:ring-tan"
          />
        </label>
        <label className="block">
          <p className="mb-1.5 text-xs font-semibold text-brown/50">{t.bannerDuration}</p>
          <select
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            className="w-full rounded-xl border border-brown/10 bg-cream px-3 py-2 text-sm font-semibold text-brown outline-none focus:ring-2 focus:ring-tan"
          >
            {DURATIONS.map((value) => (
              <option key={value} value={value}>
                {t[`bannerDuration_${value}`] || value}
              </option>
            ))}
          </select>
        </label>
        <div>
          <p className="mb-1.5 text-xs font-semibold text-brown/50">{t.bannerTextPlace}</p>
          <div className="grid w-36 grid-cols-3 gap-1">
            {ALIGNS.map((align) => (
              <button
                key={align}
                type="button"
                title={t[`bannerAlign_${align.replaceAll("-", "_")}`] || align}
                onClick={() => setTextAlign(align)}
                className={`h-8 rounded-md ring-1 ${
                  textAlign === align ? "bg-brown ring-brown" : "bg-cream ring-brown/10 hover:ring-tan"
                }`}
              />
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-brown/40">
            {t[`bannerAlign_${textAlign.replaceAll("-", "_")}`] || textAlign}
          </p>
        </div>
        <button
          type="button"
          disabled={Boolean(busySlot)}
          onClick={() => onSave(item.slot, { title, subtitle, textAlign, link, duration })}
          className="rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream"
        >
          {t.bannerSaveText}
        </button>
      </div>
    </article>
  );
}

export default function AdminBanners() {
  const { t } = useLang();
  const [banners, setBanners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busySlot, setBusySlot] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    api
      .adminBanners()
      .then((data) => setBanners(data.banners || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function onUpload(slot, event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusySlot(slot);
    setError("");
    setMessage("");
    try {
      const image = await fileToJpegDataUrl(file, bannerUploadSize(slot));
      const data = await api.uploadBannerImage(slot, image);
      setBanners(data.banners || []);
      setMessage(t.bannerSaved);
    } catch (err) {
      setError(
        err.message === "Failed to fetch" || err.message === "Image too large"
          ? t.bannerUploadFailed
          : err.message
      );
    } finally {
      setBusySlot(0);
    }
  }

  async function onRemove(slot) {
    setBusySlot(slot);
    setError("");
    setMessage("");
    try {
      const data = await api.removeBannerImage(slot);
      setBanners(data.banners || []);
      setMessage(t.bannerSaved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusySlot(0);
    }
  }

  async function onMove(from, to) {
    if (from === to) return;
    setBusySlot(from);
    setError("");
    setMessage("");
    try {
      const data = await api.moveBanner(from, to);
      setBanners(data.banners || []);
      setMessage(t.bannerSaved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusySlot(0);
    }
  }

  async function onSave(slot, body) {
    setBusySlot(slot);
    setError("");
    setMessage("");
    try {
      const data = await api.patchBanner(slot, body);
      setBanners(data.banners || []);
      setMessage(t.bannerSaved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusySlot(0);
    }
  }

  if (loading) return <Spinner label={t.loading} />;

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-3xl">{t.banners}</h2>
        <p className="mt-2 max-w-2xl text-sm text-brown/50">{t.bannersLead}</p>
      </div>
      {error ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mb-4 text-sm text-brown/60">{message}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {banners.map((item) => (
          <SlotCard
            key={item.slot}
            item={item}
            t={t}
            busySlot={busySlot}
            onUpload={onUpload}
            onRemove={onRemove}
            onMove={onMove}
            onSave={onSave}
          />
        ))}
      </div>
    </div>
  );
}
