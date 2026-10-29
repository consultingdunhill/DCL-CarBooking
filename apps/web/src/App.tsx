import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { PrivacyGate } from './components/PrivacyNotice';
import { Shell } from './components/Shell';
import { EmptyState, PageLoader } from './components/ui/misc';
import { useAuth } from './lib/auth';
import { ApprovalsPage } from './pages/admin/ApprovalsPage';
import { AuditPage } from './pages/admin/AuditPage';
import { CarsPage } from './pages/admin/CarsPage';
import { ClientsPage } from './pages/admin/ClientsPage';
import { ClosuresPage } from './pages/admin/ClosuresPage';
import { FuelPage } from './pages/admin/FuelPage';
import { LiveMapPage } from './pages/admin/LiveMapPage';
import { PropertiesPage } from './pages/admin/PropertiesPage';
import { RatesPage } from './pages/admin/RatesPage';
import { ReasonsPage } from './pages/admin/ReasonsPage';
import { ReportsPage } from './pages/admin/ReportsPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { TripDetailPage } from './pages/admin/TripDetailPage';
import { TripsPage } from './pages/admin/TripsPage';
import { UsersPage } from './pages/admin/UsersPage';
import { CalendarPage } from './pages/CalendarPage';
import { LoginPage } from './pages/LoginPage';
import { BookPage } from './pages/staff/BookPage';
import { MyTripsPage } from './pages/staff/MyTripsPage';
import { NotificationsPage } from './pages/staff/NotificationsPage';
import { ProfilePage } from './pages/staff/ProfilePage';
import { TripPage } from './pages/staff/TripPage';

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <EmptyState title="Admins only" description="This page is for fleet administrators." />;
}

const admin = (el: ReactNode) => <AdminOnly>{el}</AdminOnly>;

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <BookPage /> },
      { path: 'trips', element: <MyTripsPage /> },
      { path: 'trips/:bookingId', element: <TripPage /> },
      { path: 'bookings/:bookingId', element: <TripPage /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'admin', element: <Navigate to="/admin/approvals" replace /> },
      { path: 'admin/approvals', element: admin(<ApprovalsPage />) },
      { path: 'admin/live', element: admin(<LiveMapPage />) },
      { path: 'admin/calendar', element: admin(<CalendarPage />) },
      { path: 'admin/trips', element: admin(<TripsPage />) },
      { path: 'admin/trips/:tripId', element: admin(<TripDetailPage />) },
      { path: 'admin/reports', element: admin(<ReportsPage />) },
      { path: 'admin/fuel', element: admin(<FuelPage />) },
      { path: 'admin/closures', element: admin(<ClosuresPage />) },
      { path: 'admin/rates', element: admin(<RatesPage />) },
      { path: 'admin/properties', element: admin(<PropertiesPage />) },
      { path: 'admin/clients', element: admin(<ClientsPage />) },
      { path: 'admin/cars', element: admin(<CarsPage />) },
      { path: 'admin/reasons', element: admin(<ReasonsPage />) },
      { path: 'admin/users', element: admin(<UsersPage />) },
      { path: 'admin/settings', element: admin(<SettingsPage />) },
      { path: 'admin/audit', element: admin(<AuditPage />) },
      { path: '*', element: <EmptyState title="Page not found" /> },
    ],
  },
]);

export function App() {
  const { status, me } = useAuth();
  if (status === 'loading') return <div className="h-dvh"><PageLoader /></div>;
  if (status === 'signedOut' || !me) return <LoginPage />;
  if (me.privacyAckRequired) return <PrivacyGate />;
  return <RouterProvider router={router} />;
}
