import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import type React from "react";
import { useEffect } from "react";
import { useAuthStore } from "@/stores/authStore";
import Login from "@/pages/Login";
import InviteAccept from "@/pages/InviteAccept";
import Dashboard from "@/pages/Dashboard";
import Journal from "@/pages/Journal";
import Inventory from "@/pages/Inventory";
import FixedAssets from "@/pages/FixedAssets";
import Reports from "@/pages/Reports";
import Settings from "@/pages/Settings";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status, bootstrap } = useAuthStore();
  useEffect(() => {
    if (status === "idle") {
      bootstrap();
    }
  }, [status, bootstrap]);

  if (status === "idle" || status === "loading") {
    return <div className="p-6 text-sm text-zinc-500">Loading...</div>;
  }
  if (status !== "authed") {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/invite" element={<InviteAccept />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Dashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/journal"
          element={
            <RequireAuth>
              <Journal />
            </RequireAuth>
          }
        />
        <Route
          path="/inventory"
          element={
            <RequireAuth>
              <Inventory />
            </RequireAuth>
          }
        />
        <Route
          path="/fixed-assets"
          element={
            <RequireAuth>
              <FixedAssets />
            </RequireAuth>
          }
        />
        <Route
          path="/reports"
          element={
            <RequireAuth>
              <Reports />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <Settings />
            </RequireAuth>
          }
        />
      </Routes>
    </Router>
  );
}
