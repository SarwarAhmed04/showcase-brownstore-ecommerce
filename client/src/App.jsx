import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { LangProvider } from "./context/LangContext";
import { CatalogProvider } from "./lib/catalogStore";
import { StoreProvider } from "./store";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Shop from "./pages/Shop";
import Category from "./pages/Category";
import Product from "./pages/Product";
import Search from "./pages/Search";
import Saved from "./pages/Saved";
import Contact from "./pages/Contact";
import NotFound from "./pages/NotFound";
import { AdminThemeRoot } from "./adminTheme";
import AdminLogin from "./pages/admin/Login";
import AdminLayout from "./pages/admin/AdminLayout";
import AdminDashboard from "./pages/admin/Dashboard";
import AdminProducts from "./pages/admin/Products";
import AdminCategories from "./pages/admin/Categories";
import AdminCommissions from "./pages/admin/Commissions";
import AdminVendorControls from "./pages/admin/VendorControls";
import AdminActivity from "./pages/admin/Activity";
import AdminBanners from "./pages/admin/Banners";
import AdminAccounts from "./pages/admin/Accounts";

export default function App() {
  return (
    <LangProvider>
      <AuthProvider>
        <CatalogProvider>
          <StoreProvider>
            <BrowserRouter>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/shop" element={<Shop />} />
                  <Route path="/category/:slug" element={<Category />} />
                  <Route path="/product/:slug" element={<Product />} />
                  <Route path="/deals" element={<Navigate to="/shop" replace />} />
                  <Route path="/search" element={<Search />} />
                  <Route path="/saved" element={<Saved />} />
                  <Route path="/about" element={<Navigate to="/" replace />} />
                  <Route path="/contact" element={<Contact />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
                <Route element={<AdminThemeRoot />}>
                <Route path="/admin/login" element={<AdminLogin />} />
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<AdminDashboard />} />
                  <Route path="products" element={<AdminProducts />} />
                  <Route path="categories" element={<AdminCategories />} />
                  <Route path="vendors" element={<AdminVendorControls />} />
                  <Route path="platforms" element={<AdminCommissions />} />
                  <Route path="platforms/:partner" element={<AdminCommissions />} />
                  <Route path="commissions" element={<AdminCommissions />} />
                  <Route path="commissions/:partner" element={<AdminCommissions />} />
                  <Route path="activity" element={<AdminActivity />} />
                  <Route path="banners" element={<AdminBanners />} />
                  <Route path="accounts" element={<AdminAccounts />} />
                </Route>
                </Route>
              </Routes>
            </BrowserRouter>
          </StoreProvider>
        </CatalogProvider>
      </AuthProvider>
    </LangProvider>
  );
}
