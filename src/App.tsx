import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import type React from "react";
import { Suspense, lazy, useEffect } from "react";
import { useAuthStore } from "@/stores/authStore";

const Login = lazy(() => import("@/pages/Login"));
const InviteAccept = lazy(() => import("@/pages/InviteAccept"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Journal = lazy(() => import("@/pages/Journal"));
const Inventory = lazy(() => import("@/pages/Inventory"));
const FixedAssets = lazy(() => import("@/pages/FixedAssets"));
const Reports = lazy(() => import("@/pages/Reports"));
const Settings = lazy(() => import("@/pages/Settings"));
const Users = lazy(() => import("@/pages/Users"));
const Vendors = lazy(() => import("@/pages/Vendors"));
const Customers = lazy(() => import("@/pages/Customers"));
const PendingApproval = lazy(() => import("@/pages/PendingApproval"));
const SuperAdmin = lazy(() => import("@/pages/SuperAdmin"));

function RouteLoading() {
  return <div className="p-6 text-sm text-zinc-500">Loading...</div>;
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const { status, bootstrap } = useAuthStore();
  useEffect(() => {
    if (status === "idle") {
      bootstrap();
    }
  }, [status, bootstrap]);

  if (status === "idle" || status === "loading") {
    return <RouteLoading />;
  }
  if (status !== "authed") {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { activeOrgId } = useAuthStore();
  return <RequireSession>{activeOrgId ? children : <Navigate to="/pending" replace />}</RequireSession>;
}

export default function App() {
  return (
    <Router>
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/invite" element={<InviteAccept />} />
          <Route
            path="/pending"
            element={
              <RequireSession>
                <PendingApproval />
              </RequireSession>
            }
          />
          <Route
            path="/superadmin"
            element={
              <RequireSession>
                <SuperAdmin />
              </RequireSession>
            }
          />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Navigate to="/settings" replace />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard"
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
            path="/vendors"
            element={
              <RequireAuth>
                <Vendors />
              </RequireAuth>
            }
          />
          <Route
            path="/customers"
            element={
              <RequireAuth>
                <Customers />
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
          <Route
            path="/users"
            element={
              <RequireAuth>
                <Users />
              </RequireAuth>
            }
          />
        </Routes>
      </Suspense>
    </Router>
  );
}
