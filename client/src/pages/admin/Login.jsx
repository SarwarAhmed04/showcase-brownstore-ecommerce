import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";

export default function AdminLogin() {
  const { t } = useLang();
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@brownstore.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/admin/products" replace />;

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
      navigate("/admin/products");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full rounded-3xl bg-white p-8 shadow-xl ring-1 ring-brown/10"
      >
        <img src="/logo.png" alt="" className="mx-auto h-14 w-14" />
        <h1 className="mt-4 text-center font-display text-2xl">{t.admin}</h1>
        <label className="mt-6 block text-sm font-medium">{t.emailLabel}</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-xl border border-brown/10 px-3 py-2 outline-none focus:ring-2 focus:ring-tan"
          required
        />
        <label className="mt-4 block text-sm font-medium">{t.password}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-brown/10 px-3 py-2 outline-none focus:ring-2 focus:ring-tan"
          required
        />
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-full bg-brown py-2.5 font-semibold text-cream disabled:opacity-60"
        >
          {t.login}
        </button>
      </form>
    </div>
  );
}
