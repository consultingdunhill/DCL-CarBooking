import { useMutation } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { download, errorMessage } from '@/lib/api';

/**
 * CSV upload with a template download. Shows the server's summary of the last
 * upload underneath.
 */
export function ImportCard<T>({
  title,
  description,
  templatePath,
  templateName,
  upload,
  onSuccess,
  renderResult,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  templatePath: string;
  templateName: string;
  upload: (file: File) => Promise<T>;
  onSuccess?: (result: T) => void;
  renderResult: (result: T) => ReactNode;
  children?: ReactNode;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const [downloading, setDownloading] = useState(false);

  const mutation = useMutation({
    mutationFn: (f: File) => upload(f),
    onSuccess: (r) => {
      setResult(r);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      onSuccess?.(r);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  async function getTemplate() {
    setDownloading(true);
    try {
      await download(templatePath, templateName);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void getTemplate()} loading={downloading}>
            {!downloading && <Download />} Template
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {children}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
          <Button variant="secondary" onClick={() => inputRef.current?.click()} aria-controls={inputId}>
            <FileSpreadsheet /> Choose CSV file
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-fg">{file ? file.name : 'No file chosen'}</span>
          <Button onClick={() => file && mutation.mutate(file)} disabled={!file} loading={mutation.isPending}>
            {!mutation.isPending && <Upload />} Upload
          </Button>
        </div>
        {result && <div className="rounded-xl border border-border bg-surface-2 p-4">{renderResult(result)}</div>}
      </CardBody>
    </Card>
  );
}
