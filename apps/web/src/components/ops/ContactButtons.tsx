import { telLink, whatsappLink } from '@carbooking/core';
import { MessageCircle, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Call and WhatsApp buttons for a phone number (icon-only when `compact`). */
export function ContactButtons({ phone, name, compact, className }: { phone: string | null | undefined; name: string; compact?: boolean; className?: string }) {
  if (!phone) return <span className={cn('text-xs text-muted-fg', className)}>No phone number on file</span>;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button asChild variant="secondary" size={compact ? 'icon-sm' : 'sm'}>
        <a href={telLink(phone)} onClick={stop} aria-label={`Call ${name}`} title={`Call ${name} on ${phone}`}>
          <Phone />
          {!compact && 'Call'}
        </a>
      </Button>
      <Button asChild variant="secondary" size={compact ? 'icon-sm' : 'sm'}>
        <a href={whatsappLink(phone)} onClick={stop} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${name}`} title={`WhatsApp ${name}`}>
          <MessageCircle />
          {!compact && 'WhatsApp'}
        </a>
      </Button>
    </div>
  );
}
