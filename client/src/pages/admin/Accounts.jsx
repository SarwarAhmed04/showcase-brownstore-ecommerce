import { useEffect, useState } from "react";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import Spinner from "../../components/Spinner";

export default function AdminAccounts() {
  const { t } = useLang();
  const { user } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [canDelete, setCanDelete] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function load() {
    return api
      .adminAccounts()
      .then((data) => {
        setAccounts(data.accounts || []);
        setCanDelete(Boolean(data.canDelete));
      });
  }

  useEffect(() => {
    load()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function onAdd(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.createAdminAccount({ email, password });
      setEmail("");
      setPassword("");
      setMessage(t.accountCreated);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(account) {
    if (!canDelete || account.isPrimary) return;
    if (!window.confirm(t.deleteAccountConfirm)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.deleteAdminAccount(account.id);
      setMessage(t.accountDeleted);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label={t.loading} />;

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-3xl">{t.accounts}</h2>
      </div>

      {error ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mb-4 text-sm text-brown/70">{message}</p> : null}

      <div className="grid items-start gap-6 md:grid-cols-2">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.addAccount}
          </p>
          <form onSubmit={onAdd} className="mt-5 space-y-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-brown/50">{t.emailLabel}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="off"
                className="w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm outline-none ring-tan/40 focus:ring-2"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-brown/50">{t.password}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm outline-none ring-tan/40 focus:ring-2"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-full bg-brown px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
            >
              {t.addAccount}
            </button>
          </form>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.existingAccounts}
          </p>
          {accounts.length ? (
            <div className="mt-5 grid gap-3">
              {accounts.map((account) => (
                <article
                  key={account.id}
                  className="flex min-w-0 flex-col justify-between gap-3 rounded-2xl bg-cream p-4 ring-1 ring-brown/5"
                >
                  <div className="min-w-0">
                    <p className="break-all font-medium leading-snug">{account.email}</p>
                    <p className="mt-1 text-xs text-brown/40">
                      {account.isPrimary ? t.primaryAdmin : t.admin}
                      {account.email === user?.email ? ` · ${t.you}` : ""}
                    </p>
                  </div>
                  {canDelete && !account.isPrimary ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDelete(account)}
                      className="self-start rounded-full bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-800 disabled:opacity-50"
                    >
                      {t.deleteAccount}
                    </button>
                  ) : account.isPrimary ? (
                    <span className="self-start rounded-full bg-tan/30 px-3 py-1 text-xs font-semibold text-brown">
                      {t.primaryAdmin}
                    </span>
                  ) : (
                    <span className="text-xs text-brown/35">{t.onlyPrimaryCanDelete}</span>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-5 text-sm text-brown/45">{t.noProducts}</p>
          )}
        </section>
      </div>
    </div>
  );
}
