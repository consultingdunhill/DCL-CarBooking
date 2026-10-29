import { DomainError, normalizeRow, type RawRow } from '@carbooking/core';
import type { FastifyRequest } from 'fastify';
import Papa from 'papaparse';

const MAX_ROWS = 20_000;

/** Read an uploaded CSV (multipart field "file") into normalised rows. */
export async function readCsvUpload(req: FastifyRequest): Promise<{ fileName: string; rows: RawRow[] }> {
  const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
  if (!file) throw new DomainError('NO_FILE', 'Choose a CSV file to upload');
  const buf = await file.toBuffer();
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy' });
  if (parsed.errors.length && parsed.data.length === 0) {
    throw new DomainError('BAD_CSV', `Couldn't read the CSV: ${parsed.errors[0]!.message}`);
  }
  if (parsed.data.length > MAX_ROWS) throw new DomainError('CSV_TOO_LARGE', `Up to ${MAX_ROWS} rows per upload`);
  return { fileName: file.filename, rows: parsed.data.map(normalizeRow) };
}

export function csvTemplate(headers: string[]) {
  return headers.join(',') + '\r\n';
}
