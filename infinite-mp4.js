/* MP4 writer reused unchanged from ScoreMotion js/ui-and-export.js (Glisscore, AGPL-3.0). */
//#region muxer
/* Minimal MP4 writer (H.264 + AAC) – no external libraries */
function _B(...parts) {
  let n = 0; const arr = parts.map(p => typeof p === 'string' ? Uint8Array.from(p, c => c.charCodeAt(0)) : (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  arr.forEach(a => n += a.length); const out = new Uint8Array(n); let o = 0; arr.forEach(a => { out.set(a, o); o += a.length; }); return out;
}
const _u16 = n => [(n >> 8) & 255, n & 255];
const _u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const _zeros = n => new Uint8Array(n);
function _box(type, ...parts) { const body = _B(...parts); return _B(_u32(body.length + 8), type, body); }
function _full(type, ver, flags, ...parts) { return _box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts); }
function _table64(vals) { const o = new Uint8Array(vals.length * 8), dv = new DataView(o.buffer); vals.forEach((v, i) => { dv.setUint32(i * 8, Math.floor(v / 4294967296)); dv.setUint32(i * 8 + 4, v >>> 0); }); return o; }
function _table(vals) { const o = new Uint8Array(vals.length * 4), dv = new DataView(o.buffer); vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0)); return o; }
const _MATRIX = _B(_u32(0x10000), _u32(0), _u32(0), _u32(0), _u32(0x10000), _u32(0), _u32(0), _u32(0), _u32(0x40000000));
function _rle(vals) { const out = []; let prev = null, cnt = 0; vals.forEach(v => { if (v === prev) cnt++; else { if (cnt) out.push(cnt, prev); prev = v; cnt = 1; } }); if (cnt) out.push(cnt, prev); return out; }

class Mp4Writer {
  constructor(o) {
    this.noVideo = !!o.noVideo; this.w = o.width || 0; this.h = o.height || 0; this.fps = o.fps || 30; this.audio = o.audio || null; this.codec = o.codec === 'hevc' ? 'hevc' : 'avc';
    this.vts = 90000; this.vdur = Math.round(90000 / o.fps); this.pcm = !!(o.audio && o.audio.pcm);          // pcm: the sound is stored as it is (24-bit), in a QuickTime file
    this.v = []; this.a = []; this.avcC = null; this.encAsc = null;
    this.sink = o.sink || null; this.co64 = !!o.co64; this.pend = []; this.pos = 0; this.big = false;          // with a sink the samples are written out as they come (a long video never sits in memory) and the table at the end says where they are
    // Safari can hand back a differently-wrapped AAC setup block, which produces a silent track. We know the audio is
    // AAC-LC at a known rate and channel count, so we write the standard 2-byte AudioSpecificConfig ourselves.
    this.asc = this.audio && !this.pcm ? Mp4Writer._aacLcAsc(this.audio.sampleRate, this.audio.channels) : null;
  }
  static _aacLcAsc(sampleRate, channels) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const fi = rates.indexOf(sampleRate), bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    if (!(channels >= 1 && channels <= 7)) throw new Error('Unsupported AAC channel count: ' + channels);
    put(2, 5);                                   // audio object type 2 = AAC-LC
    if (fi >= 0) put(fi, 4); else { put(15, 4); put(sampleRate, 24); }   // sample rate index, or explicit rate
    put(channels, 4);                            // channel configuration
    while (bits.length % 8) bits.push(0);
    const out = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
    return out;
  }
  setTags(t) { this.tags = t; }
  _udta() {          // iTunes-style tags: title, artist, album artist, composer, album, year
    const t = this.tags; if (!t) return new Uint8Array(0); const te = new TextEncoder();
    const item = (k, v) => v ? _box(k, _full('data', 0, 1, _u32(0), te.encode(v))) : new Uint8Array(0);
    const num = (k, n, bytes) => n ? _box(k, _full('data', 0, 21, _u32(0), bytes === 1 ? [n & 255] : _u16(n))) : new Uint8Array(0);          // whole numbers
    const pair = (k, n) => n ? _box(k, _full('data', 0, 0, _u32(0), [0, 0], _u16(n), [0, 0], [0, 0])) : new Uint8Array(0);          // track and disc: number, total (left empty)
    const ilst = _box('ilst', item('\xA9nam', t.title), item('\xA9ART', t.artist), item('aART', t.albumArtist), item('\xA9alb', t.album), item('\xA9day', t.year), pair('trkn', +t.track || 0), pair('disk', +t.disc || 0),
      item('\xA9wrt', t.composer), item('\xA9wrk', t.work), item('\xA9mvn', t.movement), num('\xA9mvi', +t.movementNo || 0, 2), num('shwm', t.showWork ? 1 : 0, 1), item('\xA9gen', t.genre), item('\xA9cmt', t.comment), num('cpil', t.compilation ? 1 : 0, 1));
    return _box('udta', _full('meta', 0, 0, _full('hdlr', 0, 0, _u32(0), 'mdir', 'appl', _u32(0), _u32(0), [0]), ilst));
  }
  setAudioTrim(delay, length) { this.trim = { delay: Math.max(0, Math.round(delay)), length: Math.round(length) }; }
  /* The sound ends where the edit list says, so the media ends there too: the encoder's last frames past the end are dropped and the last one is cut short. Some players (Apple's decoder among them) play to the end of the media and ignore the end of the edit list, which would add a stretch of padding. */
  _cutTail() {
    const t = this.trim; if (!t || this.pcm || !(t.length > 0) || !this.a.length) return;
    const need = t.delay + t.length; let sum = 0, keep = 0;
    for (; keep < this.a.length && sum < need; keep++) sum += this.a[keep].dur;
    if (sum < need) return;
    this.a.length = keep; if (sum > need) this.a[keep - 1].dur -= sum - need;
  }
  addVideo(chunk, meta) {
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.avcC) this.avcC = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description);
    const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); const sm = { d, key: chunk.type === 'key' }; this.v.push(sm); if (this.sink) this.pend.push(sm);
  }
  addPcm(d, frames) { const sm = { d, dur: frames }; this.a.push(sm); if (this.sink) this.pend.push(sm); }          // a block of 24-bit big-endian sound, channels interleaved
  addAudio(chunk, meta) {
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.encAsc) {
      this.encAsc = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description);
      const hex = a => Array.from(a).map(x => ('0' + x.toString(16)).slice(-2)).join(' ');
      const same = this.encAsc.length === this.asc.length && this.encAsc.every((x, i) => x === this.asc[i]);
      if (typeof dbg === 'function') dbg('AAC setup: the encoder reported ' + this.encAsc.length + ' bytes [' + hex(this.encAsc.subarray(0, 24)) + '] for ' + this.audio.sampleRate + ' Hz, ' + this.audio.channels + ' ch. The MP4 uses the standard AAC-LC setup [' + hex(this.asc) + ']' + (same ? ' (identical)' : ' (DIFFERENT, so the encoder value was not used)'));
    }
    const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
    const sr = this.audio.sampleRate; const dur = chunk.duration ? Math.round(chunk.duration * sr / 1e6) : 1024;
    const sm = { d, dur }; this.a.push(sm); if (this.sink) this.pend.push(sm);
  }
  _stco(offs) { return this.big ? _full('co64', 0, 0, _u32(offs.length), _table64(offs)) : _full('stco', 0, 0, _u32(offs.length), _table(offs)); }          // 64-bit places when the file is over 4GB
  _chunks(samples, per) { const out = []; for (let i = 0; i < samples.length; i += per) out.push(samples.slice(i, i + per)); return out; }
  /* trim = { delay, length } for the sound: the encoder's start padding is skipped and the track ends at the exact length (an edit list, so players start the sound on time) */
  _trak(id, kind, ts, durMedia, stsd, sttsVals, samples, chunks, offsets, keyList, trim) {
    const durMovie = trim ? Math.round(trim.length * Mp4Writer.MT / ts) : Math.ceil(durMedia * Mp4Writer.MT / ts);
    const edts = trim ? _box('edts', _full('elst', 0, 0, _u32(1), _u32(durMovie), _u32(trim.delay), _u16(1), _u16(0))) : new Uint8Array(0);
    const tkhd = _full('tkhd', 0, 3, _u32(0), _u32(0), _u32(id), _u32(0), _u32(durMovie), _zeros(8), _u16(0), _u16(0), _u16(kind === 'soun' ? 0x100 : 0), _u16(0), _MATRIX,
      _u32(kind === 'vide' ? this.w * 65536 : 0), _u32(kind === 'vide' ? this.h * 65536 : 0));
    const mdhd = _full('mdhd', 0, 0, _u32(0), _u32(0), _u32(ts), _u32(durMedia), _u16(0x55c4), _u16(0));
    const hdlr = _full('hdlr', 0, 0, _u32(0), kind, _zeros(12), kind === 'vide' ? 'VideoHandler\0' : 'SoundHandler\0');
    const mhd = kind === 'vide' ? _full('vmhd', 0, 1, _zeros(8)) : _full('smhd', 0, 0, _zeros(4));
    const dinf = _box('dinf', _full('dref', 0, 0, _u32(1), _full('url ', 0, 1)));
    const stts = _full('stts', 0, 0, _u32(sttsVals.length / 2), _table(sttsVals));
    const stscVals = []; let prev = -1;
    chunks.forEach((c, i) => { if (c.length !== prev) { stscVals.push(i + 1, c.length, 1); prev = c.length; } });
    const stsc = _full('stsc', 0, 0, _u32(stscVals.length / 3), _table(stscVals));
    const stsz = _full('stsz', 0, 0, _u32(0), _u32(samples.length), _table(samples.map(s => s.d.length)));
    const stco = this._stco(offsets);
    const stss = keyList ? _full('stss', 0, 0, _u32(keyList.length), _table(keyList)) : new Uint8Array(0);
    const roll = kind === 'soun' ? [_full('sgpd', 1, 0, 'roll', _u32(2), _u32(1), [0xff, 0xff]), _full('sbgp', 0, 0, 'roll', _u32(1), _u32(samples.length), _u32(1))] : [];          // every AAC frame needs the one before it to start cleanly (a pre-roll of one frame): without this, Apple's decoder ignores the edit list and plays the padding
    const stbl = _box('stbl', stsd, stts, stss, stsc, stsz, stco, ...roll);
    return _box('trak', tkhd, edts, _box('mdia', mdhd, hdlr, _box('minf', mhd, dinf, stbl)));
  }
  /* the bitrate the encoder really produced, so players show the true figure (kbps) */
  audioKbps() {
    const sr = this.audio.sampleRate; let bytes = 0, samples = 0;
    for (const c of this.a) { bytes += c.d.length; samples += c.dur; }
    return samples ? bytes * 8 * sr / samples / 1000 : 0;
  }
  _esds() {
    const asc = this.asc, bps = Math.round(this.audioKbps() * 1000);
    const dcd = _B([0x40, 0x15, 0, 0, 0], _u32(bps), _u32(bps), [0x05, asc.length], asc);
    const es = _B([0, 0, 0], [0x04, dcd.length], dcd, [0x06, 0x01, 0x02]);
    return _full('esds', 0, 0, [0x03, es.length], es);
  }
  _moov(vOff, aOff, vChunks, aChunks) {
    const hasA = !!(this.audio && this.a.length && (this.asc || this.pcm));
    const vDurMedia = this.v.length * this.vdur;
    const keyList = []; this.v.forEach((s, i) => { if (s.key) keyList.push(i + 1); });
    const ve = this.codec === 'hevc' ? ['hvc1', 'hvcC'] : ['avc1', 'avcC'];
    const avc1 = this.noVideo ? null : _box(ve[0], _zeros(6), _u16(1), _u16(0), _u16(0), _zeros(12), _u16(this.w), _u16(this.h), _u32(0x480000), _u32(0x480000), _u32(0), _u16(1), _zeros(32), _u16(0x18), _u16(0xffff), _box(ve[1], this.avcC));
    const vtrak = this.noVideo ? new Uint8Array(0) : this._trak(1, 'vide', this.vts, vDurMedia, _full('stsd', 0, 0, _u32(1), avc1), [this.v.length, this.vdur], this.v, vChunks, vOff, keyList);
    let atrak = new Uint8Array(0), aDurMs = 0;
    if (hasA && this.pcm) {
      const sr = this.audio.sampleRate, ch = this.audio.channels, frames = this.a.reduce((n, x) => n + x.dur, 0), bpf = 3 * ch;
      const in24 = _box('in24', _zeros(6), _u16(1), _u16(1), _u16(0), _u32(0), _u16(ch), _u16(16), _u16(0), _u16(0), _u32((sr * 65536) >>> 0), _u32(1), _u32(3), _u32(bpf), _u32(3), _box('wave', _box('frma', 'in24'), _box('enda', [0, 0]), _u32(8), _u32(0)));
      const sc = []; let pv = -1; aChunks.forEach((c, i) => { if (c[0].dur !== pv) { sc.push(i + 1, c[0].dur, 1); pv = c[0].dur; } });
      aDurMs = Math.ceil(frames * Mp4Writer.MT / sr);
      atrak = _box('trak', _full('tkhd', 0, 3, _u32(0), _u32(0), _u32(2), _u32(0), _u32(aDurMs), _zeros(8), _u16(0), _u16(0), _u16(0x100), _u16(0), _MATRIX, _u32(0), _u32(0)), _box('mdia', _full('mdhd', 0, 0, _u32(0), _u32(0), _u32(sr), _u32(frames), _u16(0x55c4), _u16(0)), _full('hdlr', 0, 0, _u32(0), 'soun', _zeros(12), 'SoundHandler\0'),
        _box('minf', _full('smhd', 0, 0, _zeros(4)), _box('dinf', _full('dref', 0, 0, _u32(1), _full('url ', 0, 1))), _box('stbl', _full('stsd', 0, 0, _u32(1), in24), _full('stts', 0, 0, _u32(1), _u32(frames), _u32(1)),
          _full('stsc', 0, 0, _u32(sc.length / 3), _table(sc)), _full('stsz', 0, 0, _u32(bpf), _u32(frames)), this._stco(aOff)))));
    } else if (hasA) {
      const sr = this.audio.sampleRate, ch = this.audio.channels;
      const aDurMedia = this.a.reduce((s, x) => s + x.dur, 0); aDurMs = Math.ceil((this.trim && this.trim.length > 0 ? this.trim.length : aDurMedia) * Mp4Writer.MT / sr);
      const mp4a = _box('mp4a', _zeros(6), _u16(1), _zeros(8), _u16(ch), _u16(16), _u16(0), _u16(0), _u32((sr * 65536) >>> 0), this._esds());
      atrak = this._trak(2, 'soun', sr, aDurMedia, _full('stsd', 0, 0, _u32(1), mp4a), _rle(this.a.map(x => x.dur)), this.a, aChunks, aOff, null, this.trim && this.trim.length > 0 ? this.trim : null);
    }
    const durMs = Math.max(Math.ceil(vDurMedia * Mp4Writer.MT / this.vts), aDurMs);
    const mvhd = _full('mvhd', 0, 0, _u32(0), _u32(0), _u32(Mp4Writer.MT), _u32(durMs), _u32(0x10000), _u16(0x100), _u16(0), _zeros(8), _MATRIX, _zeros(24), _u32(hasA ? 3 : 2));
    return _box('moov', mvhd, vtrak, atrak, this._udta());
  }
  _ftyp() { return this.pcm ? _box('ftyp', 'qt  ', _u32(0x20050300), 'qt  ') : this.noVideo ? _box('ftyp', 'M4A ', _u32(0), 'M4A ', 'mp42', 'isom') : _box('ftyp', 'isom', _u32(512), 'isom', 'iso2', this.codec === 'hevc' ? 'hvc1' : 'avc1', 'mp41'); }
  /* with a sink: the file starts with its type and the header of the media data (its size is filled in at the end), then samples are written as they come (drain) */
  async begin() { const f = this._ftyp(); this.mdatAt = f.length; this.pos = f.length + 16; await this.sink.put(_B(f, _u32(1), 'mdat', new Uint8Array(8)).buffer); }
  async drain() {
    if (!this.sink || !this.pend.length) return; const list = this.pend; this.pend = []; let n = 0; for (const x of list) n += x.d.length;
    const buf = new Uint8Array(n); let q = 0; for (const x of list) { buf.set(x.d, q); x.o = this.pos + q; q += x.d.length; x.d = { length: x.d.length }; }          // each sample keeps its size and place, not its bytes
    this.pos += n; await this.sink.put(buf.buffer);
  }
  /* the table of where everything is goes after the media data; the size of the media data is then written into its header. The file is over 4GB: places are 64-bit */
  async finalizeStream() {
    if (!this.noVideo && !this.avcC) throw new Error('No video data was produced.');
    await this.drain(); this._cutTail();
    const vPer = Math.max(1, Math.round(this.fps)), aPer = this.audio && !this.pcm ? Math.max(1, Math.ceil(this.audio.sampleRate / 1024)) : 1;
    const vChunks = this._chunks(this.v, vPer), aChunks = (this.audio && this.a.length && (this.asc || this.pcm)) ? this._chunks(this.a, aPer) : [];
    this.big = this.co64 || this.pos > 0xfffffff0;
    const moov = this._moov(vChunks.map(c => c[0].o), aChunks.map(c => c[0].o), vChunks, aChunks);
    await this.sink.put(moov.slice().buffer); await this.sink.done();
    const hd = new DataView(new ArrayBuffer(8)); hd.setUint32(0, Math.floor((this.pos - this.mdatAt) / 4294967296)); hd.setUint32(4, (this.pos - this.mdatAt) >>> 0);
    await this.sink.patch(this.mdatAt + 8, hd.buffer);
    return this.pos + moov.length;
  }
  finalize() {
    if (!this.noVideo && !this.avcC) throw new Error('No video data was produced.'); this._cutTail();
    const vPer = Math.max(1, Math.round(this.fps));
    const aPer = this.audio && !this.pcm ? Math.max(1, Math.ceil(this.audio.sampleRate / 1024)) : 1;
    const vChunks = this._chunks(this.v, vPer), aChunks = (this.audio && this.a.length && (this.asc || this.pcm)) ? this._chunks(this.a, aPer) : [];
    const order = []; const total = Math.max(vChunks.length, aChunks.length);
    for (let i = 0; i < total; i++) { if (vChunks[i]) order.push(['v', i]); if (aChunks[i]) order.push(['a', i]); }
    const ftyp = this._ftyp();
    const zeroV = new Array(vChunks.length).fill(0), zeroA = new Array(aChunks.length).fill(0);
    const moovLen = this._moov(zeroV, zeroA, vChunks, aChunks).length;
    let pos = ftyp.length + moovLen + 8; const vOff = [], aOff = [], body = [];
    order.forEach(([k, i]) => {
      const list = k === 'v' ? vChunks[i] : aChunks[i]; (k === 'v' ? vOff : aOff).push(pos);
      list.forEach(s => { body.push(s.d); pos += s.d.length; });
    });
    if (pos > 0xfffffff0) throw new Error('The video is too large for a single MP4 file. Try a lower quality or a shorter video.');
    const moov = this._moov(vOff, aOff, vChunks, aChunks);
    const mdatHead = _B(_u32(pos - (ftyp.length + moov.length)), 'mdat');
    return new Blob([ftyp, moov, mdatHead, ...body], { type: this.pcm ? 'video/quicktime' : this.noVideo ? 'audio/mp4' : 'video/mp4' });
  }
}
Mp4Writer.MT = 90000;          // the movie's time unit (ticks a second): fine enough that an edit list lands within a fraction of a sample

