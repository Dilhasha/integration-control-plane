/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Shared helpers for delivering a Moesif sidecar configuration bundle (Fluent
// Bit or OpenTelemetry Collector) to the browser as a single downloadable zip.
// The MI metrics, MI logs and BI logs setup flows all ship the same shape of
// bundle — a folder of config files plus a generated `.env` — so the ZIP writer
// and the download plumbing live here rather than being repeated per flow.

// ── Minimal ZIP writer (store / no compression) ──
// A tiny self-contained ZIP builder so the sidecar files can be delivered as a
// single archive without pulling in a zip dependency. Uses the STORE method (no
// compression), which keeps the implementation to a CRC32 plus the local file
// headers, central directory and end-of-central-directory record.

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Builds an uncompressed ZIP archive from a map of path -> text contents.
export function createZip(files: Record<string, string>): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(contents);
    const crc = crc32(data);
    const size = data.length;

    const localHeader = concatBytes([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(0), // general purpose bit flag
      u16(0), // compression method: 0 = store
      u16(0), // last mod file time
      u16(0), // last mod file date
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
      data,
    ]);
    localParts.push(localHeader);

    centralParts.push(
      concatBytes([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed to extract
        u16(0), // general purpose bit flag
        u16(0), // compression method
        u16(0), // last mod file time
        u16(0), // last mod file date
        u32(crc),
        u32(size), // compressed size
        u32(size), // uncompressed size
        u16(nameBytes.length),
        u16(0), // extra field length
        u16(0), // file comment length
        u16(0), // disk number start
        u16(0), // internal file attributes
        u32(0), // external file attributes
        u32(offset), // relative offset of local header
        nameBytes,
      ]),
    );

    offset += localHeader.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50), // end of central directory signature
    u16(0), // number of this disk
    u16(0), // disk where central directory starts
    u16(centralParts.length), // number of central directory records on this disk
    u16(centralParts.length), // total number of central directory records
    u32(centralDirectory.length), // size of central directory
    u32(offset), // offset of start of central directory
    u16(0), // comment length
  ]);

  const archive = concatBytes([...localParts, centralDirectory, end]);
  return new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' });
}

// Zips the given files under a single top-level folder and triggers a browser
// download. Nesting under `folder` means unzipping produces one tidy directory
// the user can `cd` into and run `docker compose up -d` from, rather than
// scattering config files into their downloads directory.
export function downloadConfigBundle(files: Record<string, string>, folder: string, filename: string): void {
  const zipContents: Record<string, string> = {};
  for (const [name, contents] of Object.entries(files)) {
    zipContents[`${folder}/${name}`] = contents;
  }

  const blob = createZip(zipContents);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
