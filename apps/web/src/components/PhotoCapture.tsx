import { Camera, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Shrink a camera photo before upload: odometer photos don't need 12 MP. */
async function compress(file: File, maxSide = 1600): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/heic' || file.type === 'image/heif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.82));
  } catch {
    return file;
  }
}

/** Take (or choose) a photo of the dashboard showing the odometer. */
export function PhotoCapture({ value, onChange, label = 'Photo of the odometer', error }: { value: Blob | null; onChange: (b: Blob | null) => void; label?: string; error?: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return setUrl(null);
    const u = URL.createObjectURL(value);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">
        {label} <span className="text-danger">*</span>
      </span>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onChange(await compress(f));
          e.target.value = '';
        }}
      />
      {url ? (
        <div className="relative overflow-hidden rounded-xl border border-border">
          <img src={url} alt="Odometer" className="max-h-56 w-full object-cover" />
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="absolute right-2 bottom-2 inline-flex items-center gap-1.5 rounded-lg bg-black/60 px-3 py-1.5 text-sm font-medium text-white backdrop-blur"
          >
            <RefreshCw className="size-4" /> Retake
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={cn(
            'flex h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-muted-fg transition-colors hover:border-primary hover:text-primary',
            error ? 'border-danger text-danger' : 'border-border',
          )}
        >
          <Camera className="size-7" />
          <span className="text-sm font-medium">Take photo</span>
        </button>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
