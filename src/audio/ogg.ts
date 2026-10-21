/** Minimal Ogg page demuxer: returns the packets contained in a buffer. */
export function oggPackets(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  let cur: Buffer[] = [];
  while (i + 27 <= buf.length) {
    if (buf.toString('latin1', i, i + 4) !== 'OggS') {
      i += 1;
      continue;
    }
    const nsegs = buf[i + 26];
    const tableEnd = i + 27 + nsegs;
    if (tableEnd > buf.length) break;
    let total = 0;
    for (let s = 0; s < nsegs; s++) total += buf[i + 27 + s];
    const dataEnd = tableEnd + total;
    if (dataEnd > buf.length) break;
    let p = tableEnd;
    for (let s = 0; s < nsegs; s++) {
      const len = buf[i + 27 + s];
      cur.push(buf.subarray(p, p + len));
      p += len;
      if (len < 255) {
        out.push(Buffer.concat(cur));
        cur = [];
      }
    }
    i = dataEnd;
  }
  return out;
}

/** True when the buffer starts with (or contains near the front) an Ogg page. */
export function looksLikeOgg(buf: Buffer): boolean {
  return buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS';
}
