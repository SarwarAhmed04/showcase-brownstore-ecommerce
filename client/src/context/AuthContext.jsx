import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, getToken, setToken } from "../api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setReady(true);
      return;
    }
    api
      .me()
      .then((data) => setUser(data.user))
      .catch(() => setToken(""))
      .finally(() => setReady(true));
  }, []);

  const value = useMemo(
    () => ({
      user,
      ready,
      async login(email, password) {
        const data = await api.login(email, password);
        setToken(data.token);
        setUser(data.user);
        return data.user;
      },
      logout() {
        setToken("");
        setUser(null);
      },
    }),
    [user, ready]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
