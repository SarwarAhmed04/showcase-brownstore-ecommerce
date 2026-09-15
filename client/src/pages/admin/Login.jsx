import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import AdminBrand from "../../components/AdminBrand";
import LanguageSwitcher from "../../components/LanguageSwitcher";

export default function AdminLogin() {
  const { t } = useLang();
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("karim@brown.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/admin" replace />;

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
      navigate("/admin");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-theme="cream" className="flex min-h-svh flex-col bg-[#faf4ec] text-brown">
      <div className="flex items-center justify-between px-6 py-5">
        <AdminBrand />
        <LanguageSwitcher />
      </div>
      <div className="mx-auto flex w-full max-w-md flex-1 items-center px-4 pb-16">
        <form
          onSubmit={onSubmit}
          className="w-full rounded-[1.75rem] bg-white p-8 text-brown shadow-[0_18px_40px_-24px_rgb(61_35_23/0.28)] ring-1 ring-brown/[0.06]"
        >
          <h1 className="font-display text-2xl text-brown">{t.login}</h1>
          <p className="mt-1 text-sm text-brown/50">{t.adminHeader}</p>
          <label className="mt-6 block text-sm font-medium text-brown">
            {t.emailLabel}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-xl border border-brown/10 bg-[#faf4ec] px-3 py-2.5 text-brown outline-none placeholder:text-brown/35 focus:ring-2 focus:ring-tan"
            required
          />
          <label className="mt-4 block text-sm font-medium text-brown">
            {t.password}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-xl border border-brown/10 bg-[#faf4ec] px-3 py-2.5 text-brown outline-none placeholder:text-brown/35 focus:ring-2 focus:ring-tan"
            required
          />
          {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
          <button
            type="submit"
            disabled={busy}
            className="mt-6 w-full rounded-full bg-tan py-2.5 font-semibold text-brown disabled:opacity-60"
          >
            {t.login}
          </button>
        </form>
      </div>
    </div>
  );
}
