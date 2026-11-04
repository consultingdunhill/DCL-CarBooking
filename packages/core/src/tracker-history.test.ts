import { describe, expect, it } from 'vitest';
import { parseOverseeHistory } from './tracker-history';

/** A trimmed Oversee export, in the shape the site's table2excel writes it. */
function exportHtml(rows: string[][]) {
  const header = ['Date and Time', 'Coordinates/Address', 'Speed (Km/h)', 'Direction(&deg;)', 'Ignition', 'Mileage (Km)', 'Digit Inputs', 'Voltage/Battery (V/%)', 'Data Type'];
  const tr = (cells: string[]) => `<tr>${cells.map((c) => `<td>\n                    ${c}\n                </td>`).join('')}</tr>`;
  return (
    '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><meta http-equiv="content-type" content="application/vnd.ms-excel; charset=UTF-8">' +
    `<head><!--[if gte mso 9]><xml><x:ExcelWorkbook></x:ExcelWorkbook></xml><![endif]--></head><body><table>${tr(header)}${rows.map(tr).join('')}</table></body></html>`
  );
}

const row = (time: string, coords: string, speed = '0', heading = '0°', ignition = 'OFF', odometer = '99436.479') => [time, coords, speed, heading, ignition, odometer, '1111000000000000', '12.1 V', 'GPS Location'];

describe('parseOverseeHistory', () => {
  it('reads each position, converting Kenya wall-clock time to UTC', () => {
    const h = parseOverseeHistory(
      exportHtml([row('2026-11-03 11:30:05', '-1.25457,36.80612', '31', '261°', 'ON', '99489.762'), row('2026-11-03 11:30:11', '-1.25457,36.80583', '9', '268°', 'ON', '99489.801')]),
      180,
    );
    expect(h.fixes).toEqual([
      { recordedAt: new Date('2026-11-03T08:30:05Z'), lat: -1.25457, lng: 36.80612, speedKmh: 31, heading: 261, ignition: true, odometerKm: 99489.762 },
      { recordedAt: new Date('2026-11-03T08:30:11Z'), lat: -1.25457, lng: 36.80583, speedKmh: 9, heading: 268, ignition: true, odometerKm: 99489.801 },
    ]);
    expect(h).toMatchObject({ skipped: 0, duplicates: 0 });
  });

  it('skips rows without a position and repeats of a time, and sorts oldest first', () => {
    const h = parseOverseeHistory(
      exportHtml([
        row('2026-11-03 14:45:28', '-1.25472,36.80363'),
        row('2026-11-03 14:45:25', 'Not Locate'),
        row('2026-11-03 14:45:28', '-1.25472,36.80363'),
        row('2026-11-03 14:40:00', '-1.25465,36.80363'),
        row('not a time', '-1.25465,36.80363'),
        row('2026-11-03 14:41:00', '0,0'),
      ]),
      180,
    );
    expect(h.fixes.map((f) => f.recordedAt.toISOString())).toEqual(['2026-11-03T11:40:00.000Z', '2026-11-03T11:45:28.000Z']);
    expect(h).toMatchObject({ skipped: 3, duplicates: 1 });
  });

  it('turns away a file that is not the location history report', () => {
    expect(() => parseOverseeHistory('<table><tr><td>Time</td><td>Operation Type</td></tr></table>', 180)).toThrow(/Location History Records Report/);
    expect(() => parseOverseeHistory('Date,Lat,Lng\n2026-11-03,1,2', 180)).toThrow(/Location History Records Report/);
  });
});
