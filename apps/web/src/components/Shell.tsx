import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  CalendarDays,
  Car,
  ClipboardCheck,
  ClipboardList,
  Fuel,
  Handshake,
  History,
  Home,
  LogOut,
  Map as MapIcon,
  MapPin,
  Settings,
  ShieldCheck,
  Tags,
  UserRound,
  Users,
  Wallet,
  Building2,
  Contact,
  Menu,
  X,
} from 'lucide-react';
import { LocalNotifications } from '@capacitor/local-notifications';
import * as D from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { get } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { ENV, isNative } from '@/lib/env';
import { startQueue } from '@/lib/offline-queue';
import { resumeTracking } from '@/lib/tracking';
import { useLiveStream } from '@/lib/live';
import { useNotifications } from '@/lib/queries';
import type { Approvals } from '@/lib/types';
import { cn, initials } from '@/lib/utils';
import { usePushRegistration } from '@/lib/push';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  end?: boolean;
}

function useApprovalCount(enabled: boolean) {
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => get<Approvals>('/approvals'), enabled, refetchInterval: 60_000 });
  return q.data ? q.data.bookings.length + q.data.joinRequests.length : 0;
}

export function useNavGroups(): { title: string; items: NavItem[] }[] {
  const { isAdmin } = useAuth();
  const approvals = useApprovalCount(isAdmin);
  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Trips',
      items: [
        { to: '/', label: 'Book a trip', icon: <MapPin />, end: true },
        { to: '/trips', label: 'My trips', icon: <History /> },
        { to: '/calendar', label: 'Calendar', icon: <CalendarDays /> },
      ],
    },
  ];
  if (isAdmin) {
    groups.push(
      {
        title: 'Operations',
        items: [
          { to: '/admin/approvals', label: 'Approvals', icon: <ClipboardCheck />, badge: approvals },
          { to: '/admin/live', label: 'Live map', icon: <MapIcon /> },
          { to: '/admin/trips', label: 'Trip history', icon: <ClipboardList /> },
          { to: '/admin/reports', label: 'Reports', icon: <BarChart3 /> },
        ],
      },
      {
        title: 'Costs & results',
        items: [
          { to: '/admin/fuel', label: 'Fuel entries', icon: <Fuel /> },
          { to: '/admin/closures', label: 'CRM closures', icon: <Handshake /> },
          { to: '/admin/rates', label: 'Hourly rates', icon: <Wallet /> },
        ],
      },
      {
        title: 'Setup',
        items: [
          { to: '/admin/properties', label: 'Properties', icon: <Building2 /> },
          { to: '/admin/clients', label: 'Clients', icon: <Contact /> },
          { to: '/admin/cars', label: 'Cars & driver', icon: <Car /> },
          { to: '/admin/reasons', label: 'Visit reasons', icon: <Tags /> },
          { to: '/admin/users', label: 'Users', icon: <Users /> },
          { to: '/admin/settings', label: 'Office & settings', icon: <Settings /> },
          { to: '/admin/audit', label: 'Audit log', icon: <ShieldCheck /> },
        ],
      },
    );
  }
  return groups;
}

function SideLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors lg:py-1.5 [&_svg]:size-[18px]',
          isActive ? 'bg-accent text-accent-fg' : 'text-muted-fg hover:bg-muted hover:text-fg',
        )
      }
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {item.badge ? <span className="rounded-full bg-warning px-1.5 py-0.5 text-[11px] leading-none font-semibold text-white">{item.badge}</span> : null}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const groups = useNavGroups();
  const me = useMe();
  const { signOut } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5 lg:py-4">
        <img src="/icon.svg" alt="" className="size-8" />
        <span className="text-lg font-semibold tracking-tight">{ENV.appName}</span>
      </div>
      <nav className="scroll-shadow flex-1 space-y-5 overflow-y-auto px-3 pb-4 lg:space-y-4">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="mb-1 px-3 text-[11px] font-semibold tracking-wider text-muted-fg/80 uppercase">{g.title}</div>
            <div className="space-y-0.5">
              {g.items.map((i) => (
                <SideLink key={i.to} item={i} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-border p-3">
        <NavLink to="/profile" onClick={onNavigate} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
          <span className="grid size-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-fg">{initials(me.name)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{me.name}</span>
            <span className="block truncate text-xs text-muted-fg">{me.role === 'ADMIN' ? 'Admin' : 'Staff'}</span>
          </span>
        </NavLink>
        <button onClick={() => void signOut()} className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-fg hover:bg-muted hover:text-fg">
          <LogOut className="size-[18px]" /> Sign out
        </button>
      </div>
    </div>
  );
}

function NotificationsLink({ className }: { className?: string }) {
  const unread = useNotifications().data?.unread ?? 0;
  return (
    <NavLink to="/notifications" className={cn('relative grid size-10 place-items-center rounded-full hover:bg-muted', className)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
      <Bell className="size-5" />
      {unread > 0 && <span className="absolute top-1.5 right-1.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 font-semibold text-white">{unread > 9 ? '9+' : unread}</span>}
    </NavLink>
  );
}

const TABS = [
  { to: '/', label: 'Book', icon: Home, end: true },
  { to: '/trips', label: 'Trips', icon: History },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/notifications', label: 'Alerts', icon: Bell },
  { to: '/profile', label: 'Me', icon: UserRound },
];

/**
 * Layout: a sidebar on desktop; on phones a bottom tab bar (staff) and a menu
 * button for the admin sections.
 */
export function Shell() {
  const { isAdmin } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const unread = useNotifications().data?.unread ?? 0;
  const navigate = useNavigate();
  useLiveStream(true);
  usePushRegistration();

  // Offline actions retry in the background; a trip that was running when the app closed keeps tracking.
  useEffect(() => {
    startQueue();
    void resumeTracking().catch((err) => console.warn('Could not resume tracking', err));
    if (!isNative) return;
    const sub = LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
      const link = (notification.extra as { link?: string } | undefined)?.link;
      if (link) navigate(link);
    });
    return () => void sub.then((s) => s.remove());
  }, [navigate]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface lg:block">
        <Sidebar />
      </aside>

      {/* A Radix dialog for Escape, a focus trap and an inert background. */}
      <D.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-black/40 lg:hidden" />
          <D.Content aria-describedby={undefined} className="safe-top fixed inset-y-0 left-0 z-50 w-72 bg-surface shadow-float focus:outline-none lg:hidden">
            <D.Title className="sr-only">Menu</D.Title>
            <D.Close className="absolute top-4 right-3 rounded-lg p-2 hover:bg-muted" aria-label="Close menu">
              <X className="size-5" />
            </D.Close>
            <Sidebar onNavigate={() => setMenuOpen(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="safe-top flex items-center justify-between border-b border-border bg-surface/90 px-3 py-2 backdrop-blur lg:hidden">
          {isAdmin ? (
            <button className="grid size-10 place-items-center rounded-full hover:bg-muted" onClick={() => setMenuOpen(true)} aria-label="Menu">
              <Menu className="size-5" />
            </button>
          ) : (
            <span className="size-10" />
          )}
          <span className="flex items-center gap-2 font-semibold">
            <img src="/icon.svg" alt="" className="size-6" /> {ENV.appName}
          </span>
          <NotificationsLink />
        </header>
        <header className="hidden items-center justify-end gap-2 border-b border-border bg-surface px-6 py-2 lg:flex">
          <NotificationsLink />
        </header>

        {/* `isolate`: page z-indexes (the booking sheet over its map) stay below the menu and dialogs. */}
        <main key={location.pathname.split('/')[1]} className="isolate min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>

        <nav className="safe-bottom grid grid-cols-5 border-t border-border bg-surface lg:hidden">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => cn('relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-primary' : 'text-muted-fg')}
            >
              <t.icon className="size-5" />
              {t.label}
              {t.to === '/notifications' && unread > 0 && <span className="absolute top-1.5 left-[calc(50%+6px)] size-2 rounded-full bg-danger" />}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

/** Standard padded page container. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-5 sm:px-6 lg:py-8', wide ? 'max-w-7xl' : 'max-w-4xl', className)}>{children}</div>;
}
