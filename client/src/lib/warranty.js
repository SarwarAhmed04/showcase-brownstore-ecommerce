const UNITS = new Set(["years", "months", "days"]);

export function normalizeWarranty(value) {
  if (value == null || value === "") {
    return { duration: "", unit: "years", description: "" };
  }
  if (typeof value === "string") {
    return { duration: "", unit: "years", description: value.trim() };
  }
  if (typeof value !== "object") {
    return { duration: "", unit: "years", description: String(value) };
  }
  const durationRaw = value.duration;
  const duration =
    durationRaw == null || durationRaw === ""
      ? ""
      : Number.isFinite(Number(durationRaw))
        ? Number(durationRaw)
        : "";
  const unit = UNITS.has(String(value.unit || "")) ? String(value.unit) : "years";
  const description =
    typeof value.description === "string"
      ? value.description
      : String(value.description?.ku || value.description?.en || value.description?.ar || "");
  return { duration, unit, description };
}

export function warrantyPayload(form) {
  const next = normalizeWarranty(form);
  if (next.duration === "" && !next.description) return null;
  return {
    duration: next.duration === "" ? 0 : Number(next.duration),
    unit: next.unit,
    description: next.description || "",
  };
}

export function formatWarranty(value, t) {
  const w = normalizeWarranty(value);
  if (w.duration === "" && !w.description) return "";
  const n = Number(w.duration);
  let main = "";
  if (Number.isFinite(n) && n > 0) {
    const unit =
      w.unit === "months" ? t.warrantyMonths : w.unit === "days" ? t.warrantyDays : n === 1 ? t.warrantyYear : t.warrantyYears;
    main = `${n} ${unit}`;
  }
  return [main, w.description].filter(Boolean).join(" — ");
}
