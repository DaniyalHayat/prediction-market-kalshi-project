const HEADER_BYTES = 128;

export class SharedEventRing {
  constructor({capacity = 1024, slotBytes = 4096, buffer} = {}) {
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 32768 || (capacity & (capacity - 1)) !== 0) throw new RangeError('capacity must be a power of two from 2..32768');
    if (!Number.isInteger(slotBytes) || slotBytes < 4 || slotBytes > 65536 || (slotBytes & 3) !== 0) throw new RangeError('slotBytes must be a multiple of four from 4..65536');
    const bytes = HEADER_BYTES + capacity * (slotBytes + 4);
    if (bytes > 128 * 1024 * 1024) throw new RangeError('Ring memory exceeds 128 MiB');
    if (buffer && (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== bytes)) throw new RangeError('Shared buffer shape mismatch');
    this.capacity = capacity; this.slotBytes = slotBytes; this.buffer = buffer || new SharedArrayBuffer(bytes);
    this.indices = new Uint32Array(this.buffer, 0, HEADER_BYTES / 4); this.bytes = new Uint8Array(this.buffer);
    this.lengths = new Uint32Array(this.buffer);
    if (buffer) {
      if (Atomics.load(this.indices, 1) !== capacity || Atomics.load(this.indices, 2) !== slotBytes) throw new RangeError('Shared ring configuration mismatch');
    } else {
      Atomics.store(this.indices, 1, capacity); Atomics.store(this.indices, 2, slotBytes);
    }
  }
  get size() { const tail = Atomics.load(this.indices, 16); return Math.min(this.capacity, (Atomics.load(this.indices, 0) - tail) >>> 0); }
  offer(payload) {
    if (!(payload instanceof Uint8Array) || payload.byteLength > this.slotBytes) throw new RangeError('Payload exceeds slot or is not bytes');
    const head = Atomics.load(this.indices, 0), tail = Atomics.load(this.indices, 16);
    if (((head - tail) >>> 0) >= this.capacity) return false;
    const offset = HEADER_BYTES + (head & (this.capacity - 1)) * (this.slotBytes + 4);
    this.bytes.set(payload, offset + 4); this.lengths[offset / 4] = payload.byteLength;
    Atomics.store(this.indices, 0, (head + 1) >>> 0); return true;
  }
  poll() {
    const tail = Atomics.load(this.indices, 16), head = Atomics.load(this.indices, 0);
    if (tail === head) return null;
    const offset = HEADER_BYTES + (tail & (this.capacity - 1)) * (this.slotBytes + 4), length = this.lengths[offset / 4];
    if (length > this.slotBytes) throw new Error('Corrupt ring slot');
    const payload = this.bytes.slice(offset + 4, offset + 4 + length);
    Atomics.store(this.indices, 16, (tail + 1) >>> 0); return payload;
  }
}
