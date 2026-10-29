import { telLink, whatsappLink } from '@carbooking/core';
import { MessageCircle, Phone } from 'lucide-react';
import { Button } from './ui/button';

/** Call / WhatsApp — staff talk to each other outside the app. */
export function ContactButtons({ phone, name, message, size = 'sm' }: { phone: string | null | undefined; name?: string; message?: string; size?: 'sm' | 'md' }) {
  if (!phone) return <span className="text-xs text-muted-fg">No phone number on file</span>;
  return (
    <div className="flex gap-2">
      <Button asChild size={size} variant="secondary">
        <a href={telLink(phone)} aria-label={name ? `Call ${name}` : 'Call'}>
          <Phone /> Call
        </a>
      </Button>
      <Button asChild size={size} variant="secondary">
        <a href={whatsappLink(phone, message)} target="_blank" rel="noreferrer" aria-label={name ? `WhatsApp ${name}` : 'WhatsApp'}>
          <MessageCircle /> WhatsApp
        </a>
      </Button>
    </div>
  );
}
