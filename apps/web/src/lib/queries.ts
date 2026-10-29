import { useQuery } from '@tanstack/react-query';
import { get, qs } from './api';
import type { AppNotification, Booking, Reference } from './types';

export function useReference() {
  return useQuery({ queryKey: ['reference'], queryFn: () => get<Reference>('/reference'), staleTime: 5 * 60_000 });
}

export function useBooking(id: string | undefined) {
  return useQuery({ queryKey: ['booking', id], queryFn: () => get<Booking>(`/bookings/${id}`), enabled: Boolean(id) });
}

export function useBookings(scope: 'mine' | 'all' | 'calendar', params: { from?: string; to?: string; status?: string } = {}) {
  return useQuery({ queryKey: ['bookings', scope, params], queryFn: () => get<Booking[]>(`/bookings${qs({ scope, ...params })}`) });
}

export function useCurrentTrip() {
  return useQuery({
    queryKey: ['current-trip'],
    queryFn: () => get<{ running: Booking | null; next: Booking | null }>('/me/current-trip'),
    refetchInterval: 60_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => get<{ items: AppNotification[]; unread: number }>('/notifications'),
    refetchInterval: 120_000,
  });
}
