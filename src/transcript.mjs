import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { plain, same, UUID } from './control.mjs';
const setImmediatePromise = () => new Promise(resolve => setImmediate(resolve));

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Preserve every JavaScript UTF-16 code unit, including unmatched surrogates.
const shaText = text => crypto.createHash('sha256').update(text, 'utf16le').digest('hex');
const SMALL_RECORD_BUFFER_BYTES = 65536;
const MAX_JSON_DEPTH = 256;
const MAX_SCAN_BYTES_PER_PROBE = 262144;
const CHECKPOINT_BYTES = 1048576;
const APPEND_WAIT_MS = 250;
async function bytes(handle, offset, count) {
  const buffer = Buffer.alloc(count);
  const result = await handle.read(buffer, 0, count, offset);
  if (result.bytesRead !== count) throw new Error('transcript changed');
  return buffer;
}
const HEADER_WINDOW = 32768;
// OMP title slot (session-entries.ts SessionTitleSlotEntry, written by
// session-title-slot.ts serializeTitleSlot): exactly 256 UTF-8 bytes including
// the newline, { type: 'title', v: 1, title, source?: 'auto'|'user', updatedAt, pad }.
const TITLE_SLOT_BYTES = 256;
const TITLE_KEYS = new Set(['type', 'v', 'title', 'source', 'updatedAt', 'pad']);
function titleSlot(row, length) {
  return length === TITLE_SLOT_BYTES && row !== null && typeof row === 'object' && !Array.isArray(row) &&
    row.type === 'title' && row.v === 1 && typeof row.title === 'string' && typeof row.updatedAt === 'string' &&
    typeof row.pad === 'string' && (row.source === undefined || row.source === 'auto' || row.source === 'user') &&
    Object.keys(row).every(key => TITLE_KEYS.has(key));
}
// Parses only complete, newline-terminated leading records inside the bounded
// window. The first record is the session header, or a verified title slot
// immediately followed by the header. The record after the header is never parsed.
function sessionHeader(window) {
  let start = 0;
  for (let index = 0; index < 2; index++) {
    const end = window.indexOf(10, start);
    if (end < 0) break; // incomplete or oversized leading record
    let row;
    try { row = JSON.parse(window.subarray(start, end).toString('utf8')); } catch { break; }
    if (row?.type === 'session' && !Array.isArray(row)) return row;
    if (index > 0 || !titleSlot(row, end + 1 - start)) break;
    start = end + 1;
  }
  throw new Error('transcript header invalid');
}
async function fileStat(handle) {
  const stat = await handle.stat({ bigint: true });
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('transcript offset unavailable');
  return { dev: stat.dev, ino: stat.ino, size };
}
function sameFile(stat, identity) {
  return stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino;
}
function decimalIdentity(value) { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value); }
async function openHeader(file) {
  const pathStat = await plain(file);
  const identity = await fs.lstat(file, { bigint: true });
  if (identity.isSymbolicLink() || !identity.isFile() || identity.dev !== BigInt(pathStat.dev))
    throw new Error('transcript changed');
  const handle = await fs.open(file, 'r');
  try {
    const current = await fileStat(handle);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('transcript changed');
    return { handle, stat: current, header: sessionHeader(await bytes(handle, 0, Math.min(current.size, HEADER_WINDOW))) };
  } catch (error) { await handle.close(); throw error; }
}
async function open(file, identity) {
  const { handle, stat, header } = await openHeader(file);
  try {
    const normalize = text => process.platform === 'win32' ? text.replaceAll('\\', '/').toLowerCase() : text;
    if (header.version !== 3 || header.id !== identity.sessionId || typeof header.cwd !== 'string' ||
        normalize(header.cwd) !== normalize(identity.cwd)) throw new Error('transcript identity mismatch');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

export async function validateSavedSession(file, identity) {
  const { handle } = await open(file, identity);
  await handle.close();
  return true;
}

// Setup derives the target from the same bounded strict header parser; it never
// reads past the header or accepts a non-v3, non-UUID or relative identity.
export async function sessionIdentity(file) {
  const { handle, header } = await openHeader(file);
  await handle.close();
  if (header.version !== 3 || typeof header.id !== 'string' || !UUID.test(header.id) ||
      typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw new Error('transcript header invalid');
  return { sessionId: header.id, cwd: path.resolve(header.cwd) };
}

// OMP rewrites its fixed-width title slot (bytes 0..255) in place (auto title
// after the first prompt, or a user rename) without changing the file's length or
// any other byte. Whenever a fence window overlaps the slot (start < 256, i.e. a
// file of at most 32768 + 255 bytes) and the file head is a verified slot, the
// fence hashes only the window bytes at or after offset 256; a verifier accepts
// that hash only while bytes 0..255 are still a verified slot, read from the file
// head independently of the window. Every other fenced byte, the header and the
// slot's own shape stay exact. A whole-window hash persisted before this masking
// is still accepted unchanged.
async function headTitleSlot(handle) {
  let head;
  try { head = await bytes(handle, 0, TITLE_SLOT_BYTES); } catch { return false; }
  if (head.indexOf(10) !== TITLE_SLOT_BYTES - 1) return false;
  let row;
  try { row = JSON.parse(head.subarray(0, TITLE_SLOT_BYTES - 1).toString('utf8')); } catch { return false; }
  return titleSlot(row, TITLE_SLOT_BYTES);
}
const overlapsSlot = (start, offset) => start < TITLE_SLOT_BYTES && offset >= TITLE_SLOT_BYTES;
const afterSlot = (window, start) => window.subarray(TITLE_SLOT_BYTES - start);
async function fencedPrefix(handle, start, offset) {
  const window = await bytes(handle, start, offset - start);
  return sha(overlapsSlot(start, offset) && await headTitleSlot(handle) ? afterSlot(window, start) : window);
}
async function prefixMatches(handle, proof) {
  const window = await bytes(handle, proof.start, proof.offset - proof.start);
  return sha(window) === proof.prefix ||
    (overlapsSlot(proof.start, proof.offset) && await headTitleSlot(handle) && sha(afterSlot(window, proof.start)) === proof.prefix);
}

// A fence precedes submission. Admission requires the exact sole user message
// in the appended region, not a marker echoed by an assistant or tool.
export async function fence(file, identity, text) {
  const { handle, stat } = await open(file, identity);
  try {
    if (stat.size < 1 || (await bytes(handle, stat.size - 1, 1))[0] !== 10) throw new Error('partial transcript');
    const start = Math.max(0, stat.size - 32768);
    return { file, identity, offset: stat.size, start, prefix: await fencedPrefix(handle, start, stat.size),
      dev: stat.dev.toString(), ino: stat.ino.toString(), textHash: shaText(text) };
  } finally { await handle.close(); }
}

function rejected(failure, fields = {}) {
  return { result: false, diagnostic: { failure, ...fields } };
}

function scannerState(proof, handle) {
  return {
    proof, handle, cursor: proof.offset, hash: crypto.createHash('sha256'), pending: Buffer.alloc(0), rowParser: null,
    userCount: 0, textMatches: null, compactionCount: 0,
    compactionBeforeUser: false, lastMessageRole: null, lastMessageStopReason: null,
    lastMessageAfterUser: false, tailAllInert: true, tailCustomMessages: 0,
    blankLine: false, checkpointAt: proof.offset,
  };
}

class JsonRowStream {
  constructor() {
    this.stack = []; this.rootStarted = false; this.rootComplete = false; this.lex = null; this.token = null;
    this.utf8Remaining = 0; this.utf8Min = 0x80; this.utf8Max = 0xbf;
    this.resetRow();
  }
  resetRow() {
    this.rowType = undefined; this.role = null; this.stopReason = null;
    this.messageContentKind = null; this.messageContentHash = null; this.messageArrayLength = 0;
    this.contentElementType = null; this.contentTextHash = null;
    this.customType = null; this.display = undefined; this.rootContentKind = null;
    this.rootHasMessage = false; this.rootHasRole = false;
  }
  validateUtf8(byte) {
    if (this.utf8Remaining) {
      if (byte < this.utf8Min || byte > this.utf8Max) return false;
      this.utf8Remaining--; this.utf8Min = 0x80; this.utf8Max = 0xbf;
      return true;
    }
    if (byte <= 0x7f) return true;
    if (byte >= 0xc2 && byte <= 0xdf) this.utf8Remaining = 1;
    else if (byte === 0xe0) { this.utf8Remaining = 2; this.utf8Min = 0xa0; }
    else if ((byte >= 0xe1 && byte <= 0xec) || (byte >= 0xee && byte <= 0xef)) this.utf8Remaining = 2;
    else if (byte === 0xed) { this.utf8Remaining = 2; this.utf8Max = 0x9f; }
    else if (byte === 0xf0) { this.utf8Remaining = 3; this.utf8Min = 0x90; }
    else if (byte >= 0xf1 && byte <= 0xf3) this.utf8Remaining = 3;
    else if (byte === 0xf4) { this.utf8Remaining = 3; this.utf8Max = 0x8f; }
    else return false;
    return true;
  }
  targetForKey(frame, key) {
    if (frame.target === 'root') {
      if (key === 'type') return 'root.type';
      if (key === 'message') { this.rootHasMessage = true; return 'message'; }
      if (key === 'role') { this.rootHasRole = true; return 'root.role'; }
      if (key === 'customType') return 'root.customType';
      if (key === 'display') return 'root.display';
      if (key === 'content') return 'root.content';
    }
    if (frame.target === 'message') {
      if (key === 'role') return 'message.role';
      if (key === 'stopReason') return 'message.stopReason';
      if (key === 'content') return 'message.content';
    }
    if (frame.target === 'content.element') {
      if (key === 'type') return 'content.type';
      if (key === 'text') return 'content.text';
    }
    return null;
  }
  isRelevantKey(frame, key) { return this.targetForKey(frame, key) !== null; }
  childTarget(parent) {
    if (parent.kind === 'object') return this.targetForKey(parent, parent.key);
    if (parent.kind === 'array' && parent.target === 'message.content' && parent.index === 0) return 'content.element';
    return null;
  }
  resetTarget(target) {
    if (target === 'root') this.resetRow();
    else if (target === 'message') {
      this.role = null; this.stopReason = null; this.messageContentKind = null;
      this.messageContentHash = null; this.messageArrayLength = 0;
      this.contentElementType = null; this.contentTextHash = null;
    } else if (target === 'message.content') {
      this.messageContentKind = null; this.messageContentHash = null; this.messageArrayLength = 0;
      this.contentElementType = null; this.contentTextHash = null;
    } else if (target === 'content.element') {
      this.contentElementType = null; this.contentTextHash = null;
    } else if (target === 'root.customType') this.customType = null;
    else if (target === 'root.display') this.display = undefined;
    else if (target === 'root.content') this.rootContentKind = null;
  }
  beginString(target, key = false) {
    const hash = !key && (target === 'message.content' || target === 'content.text') ? crypto.createHash('sha256') : null;
    const captureLimit = key ? 64 : target === 'root.customType' ? 128 :
      ['root.type', 'message.role', 'message.stopReason', 'content.type'].includes(target) ? 64 : 0;
    this.lex = { key, target, hash, decoder: hash ? new StringDecoder('utf8') : null,
      captureLimit, byteLength: 0, parts: [], overflow: false,
      escape: false, unicodeLeft: 0, unicodeValue: 0, highSurrogate: null };
  }
  appendStringBytes(bytes) {
    const lex = this.lex;
    if (lex.hash) {
      const decoded = lex.decoder.write(bytes);
      if (decoded) lex.hash.update(decoded, 'utf16le');
    }
    if (lex.captureLimit && !lex.overflow) {
      if (lex.byteLength + bytes.length > lex.captureLimit) {
        lex.overflow = true; lex.parts = [];
      } else {
        lex.parts.push(Buffer.from(bytes));
        lex.byteLength += bytes.length;
      }
    }
  }
  emitText(text) {
    // JSON \\u escapes can decode to an unmatched surrogate. Never re-encode
    // hashed text through UTF-8, which replaces it with U+FFFD.
    if (this.lex.hash) this.lex.hash.update(text, 'utf16le');
    else this.appendStringBytes(Buffer.from(text, 'utf8'));
  }
  flushHighSurrogate() {
    if (this.lex.highSurrogate === null) return;
    this.emitText(String.fromCharCode(this.lex.highSurrogate));
    this.lex.highSurrogate = null;
  }
  emitUnicodeUnit(unit) {
    const high = this.lex.highSurrogate;
    if (high !== null) {
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        this.emitText(String.fromCharCode(high, unit));
        this.lex.highSurrogate = null;
        return;
      }
      this.flushHighSurrogate();
    }
    if (unit >= 0xd800 && unit <= 0xdbff) this.lex.highSurrogate = unit;
    else this.emitText(String.fromCharCode(unit));
  }
  finishString() {
    if (this.utf8Remaining) return false;
    this.flushHighSurrogate();
    const lex = this.lex;
    if (lex.decoder) {
      const tail = lex.decoder.end();
      if (tail) lex.hash.update(tail, 'utf16le');
    }
    const value = lex.captureLimit && !lex.overflow ? Buffer.concat(lex.parts).toString('utf8') : undefined;
    const hash = lex.hash?.digest('hex');
    this.lex = null;
    if (lex.key) {
      const frame = this.stack.at(-1);
      if (!frame || frame.kind !== 'object') return false;
      if (value !== undefined && this.isRelevantKey(frame, value)) {
        if (frame.seen.has(value)) return false;
        frame.seen.add(value);
      }
      frame.key = value;
      frame.state = 'colon';
      return true;
    }
    this.completeValue(lex.target, 'string', { value, hash });
    return true;
  }
  completeValue(target, type, value) {
    if (target === 'root.type' && type === 'string') this.rowType = value.value;
    else if (target === 'message.role' && type === 'string') this.role = value.value;
    else if (target === 'message.stopReason' && type === 'string') this.stopReason = value.value;
    else if (target === 'message.content') {
      this.messageContentKind = type;
      if (type === 'string') this.messageContentHash = value.hash;
      if (type === 'array') this.messageArrayLength = value.length;
    } else if (target === 'content.type' && type === 'string') this.contentElementType = value.value;
    else if (target === 'content.text' && type === 'string') this.contentTextHash = value.hash;
    else if (target === 'root.customType' && type === 'string') this.customType = value.value;
    else if (target === 'root.display' && type === 'boolean') this.display = value;
    else if (target === 'root.content') this.rootContentKind = type;
    const parent = this.stack.at(-1);
    if (!parent) this.rootComplete = true;
    else if (parent.kind === 'object') { parent.key = null; parent.state = 'commaOrEnd'; }
    else { parent.index++; parent.state = 'commaOrEnd'; }
  }
  startValue(byte) {
    const parent = this.stack.at(-1);
    const target = parent ? this.childTarget(parent) : 'root';
    if (!this.rootStarted) {
      if (byte !== 123) return false; // Transcript entries are JSON objects.
      this.rootStarted = true;
    }
    this.resetTarget(target);
    if (byte === 123 || byte === 91) {
      if (this.stack.length >= MAX_JSON_DEPTH) return false;
      this.stack.push({ kind: byte === 123 ? 'object' : 'array', target,
        state: byte === 123 ? 'keyOrEnd' : 'valueOrEnd', key: null, index: 0, seen: new Set() });
      return true;
    }
    if (byte === 34) { this.beginString(target); return true; }
    if (byte === 116 || byte === 102 || byte === 110) {
      const expected = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null';
      this.token = { kind: 'literal', target, expected, index: 1, value: byte === 116 ? true : byte === 102 ? false : null };
      return true;
    }
    if (byte === 45 || (byte >= 48 && byte <= 57)) {
      const state = byte === 45 ? 'sign' : byte === 48 ? 'zero' : 'int';
      this.token = { kind: 'number', target, state };
      return true;
    }
    return false;
  }
  numberStep(byte) {
    const token = this.token;
    const digit = byte >= 48 && byte <= 57;
    const delimiter = byte === 32 || byte === 9 || byte === 13 || byte === 44 || byte === 93 || byte === 125;
    const complete = ['zero','int','frac','expDigits'].includes(token.state);
    if (delimiter) {
      if (!complete) return false;
      this.token = null; this.completeValue(token.target, 'number');
      return 'again';
    }
    if (digit) {
      if (token.state === 'sign') token.state = byte === 48 ? 'zero' : 'int';
      else if (token.state === 'zero') return false;
      else if (token.state === 'dot') token.state = 'frac';
      else if (token.state === 'exp' || token.state === 'expSign') token.state = 'expDigits';
      return true;
    }
    if (byte === 46 && ['zero','int'].includes(token.state)) token.state = 'dot';
    else if ((byte === 69 || byte === 101) && ['zero','int','frac'].includes(token.state)) token.state = 'exp';
    else if ((byte === 43 || byte === 45) && token.state === 'exp') token.state = 'expSign';
    else return false;
    return true;
  }
  structureByte(byte) {
    const space = byte === 32 || byte === 9 || byte === 13;
    const frame = this.stack.at(-1);
    if (!frame) {
      if (space && !this.rootStarted) return true;
      if (this.rootComplete) return space;
      return this.startValue(byte);
    }
    if (space) return true;
    if (frame.kind === 'object') {
      if (frame.state === 'keyOrEnd' && byte === 125) {
        this.stack.pop(); this.completeValue(frame.target, 'object'); return true;
      }
      if (frame.state === 'keyOrEnd' || frame.state === 'key') {
        if (byte !== 34) return false;
        this.beginString(null, true); return true;
      }
      if (frame.state === 'colon') {
        if (byte !== 58) return false;
        frame.state = 'value'; return true;
      }
      if (frame.state === 'value') return this.startValue(byte);
      if (frame.state === 'commaOrEnd') {
        if (byte === 44) { frame.state = 'key'; return true; }
        if (byte === 125) { this.stack.pop(); this.completeValue(frame.target, 'object'); return true; }
      }
      return false;
    }
    if (frame.state === 'valueOrEnd' && byte === 93) {
      this.stack.pop(); this.completeValue(frame.target, 'array', { length: frame.index }); return true;
    }
    if (frame.state === 'valueOrEnd' || frame.state === 'value') return this.startValue(byte);
    if (frame.state === 'commaOrEnd') {
      if (byte === 44) { frame.state = 'value'; return true; }
      if (byte === 93) { this.stack.pop(); this.completeValue(frame.target, 'array', { length: frame.index }); return true; }
    }
    return false;
  }
  writeStringByte(byte) {
    const lex = this.lex;
    if (lex.unicodeLeft) {
      const digit = byte >= 48 && byte <= 57 ? byte - 48 :
        byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
      if (digit < 0) return false;
      lex.unicodeValue = lex.unicodeValue * 16 + digit;
      if (--lex.unicodeLeft === 0) this.emitUnicodeUnit(lex.unicodeValue);
      return true;
    }
    if (lex.escape) {
      lex.escape = false;
      if (byte === 117) { lex.unicodeLeft = 4; lex.unicodeValue = 0; return true; }
      let escaped;
      if (byte === 34) escaped = '"';
      else if (byte === 92) escaped = '\\';
      else if (byte === 47) escaped = '/';
      else if (byte === 98) escaped = '\b';
      else if (byte === 102) escaped = '\f';
      else if (byte === 110) escaped = '\n';
      else if (byte === 114) escaped = '\r';
      else if (byte === 116) escaped = '\t';
      else return false;
      this.flushHighSurrogate(); this.emitText(escaped); return true;
    }
    if (byte === 92) { lex.escape = true; return true; }
    if (byte === 34) return this.finishString();
    return false;
  }
  write(buffer) {
    for (let index = 0; index < buffer.length;) {
      const byte = buffer[index];
      if (this.token?.kind === 'number') {
        const step = this.numberStep(byte);
        if (step === false) return false;
        if (step === 'again') continue;
        if (!this.validateUtf8(byte)) return false;
        index++; continue;
      }
      if (!this.validateUtf8(byte)) return false;
      if (this.lex) {
        if (this.lex.unicodeLeft || this.lex.escape || byte === 34 || byte === 92) {
          if (!this.writeStringByte(byte)) return false;
          index++; continue;
        }
        if (byte < 32) return false;
        let end = index + 1;
        while (end < buffer.length && buffer[end] !== 34 && buffer[end] !== 92 && buffer[end] >= 32) {
          if (!this.validateUtf8(buffer[end])) return false;
          end++;
        }
        this.flushHighSurrogate();
        this.appendStringBytes(buffer.subarray(index, end));
        index = end; continue;
      }
      if (this.token?.kind === 'literal') {
        const token = this.token;
        if (byte !== token.expected.charCodeAt(token.index)) return false;
        token.index++; index++;
        if (token.index === token.expected.length) {
          this.token = null; this.completeValue(token.target, token.value === null ? 'null' : 'boolean', token.value);
        }
        continue;
      }
      if (!this.structureByte(byte)) return false;
      index++;
    }
    return true;
  }
  finish() {
    if (this.lex || (this.token && this.token.kind !== 'number') || this.utf8Remaining) return null;
    if (this.token?.kind === 'number') {
      if (!['zero','int','frac','expDigits'].includes(this.token.state)) return null;
      const token = this.token; this.token = null; this.completeValue(token.target, 'number');
    }
    if (!this.rootComplete || this.stack.length) return null;
    const row = { type: this.rowType };
    if (this.rowType === 'message') row.message = {
      role: this.role, stopReason: this.stopReason, contentKind: this.messageContentKind,
      contentHash: this.messageContentHash, contentArrayLength: this.messageArrayLength,
      contentElementType: this.contentElementType, contentTextHash: this.contentTextHash,
    };
    if (this.rowType === 'custom_message') {
      row.customType = this.customType; row.display = this.display;
      if (this.rootContentKind === 'string') row.content = '';
      else if (this.rootContentKind === 'array') row.content = [];
      if (this.rootHasMessage) row.message = undefined;
      if (this.rootHasRole) row.role = undefined;
    }
    return row;
  }
}

function processRecord(scan, row, streamed = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'malformed_json';
  if (row.type === 'branch_summary') return 'branch_switch';
  if (row.type === 'compaction') {
    scan.compactionCount = Math.min(2, scan.compactionCount + 1);
    if (scan.compactionCount > 1) return 'ambiguous_compaction';
    if (scan.userCount !== 1) scan.compactionBeforeUser = true;
  }
  if (row.type === 'message') {
    const message = row.message;
    const role = message?.role ?? null;
    if (role === 'user') {
      scan.userCount = Math.min(2, scan.userCount + 1);
      if (scan.userCount > 1) return 'user_count';
      let textHash;
      if (streamed) {
        if (message.contentKind === 'string') textHash = message.contentHash;
        else if (message.contentKind === 'array' && message.contentArrayLength === 1 &&
            message.contentElementType === 'text') textHash = message.contentTextHash;
        if (typeof textHash !== 'string') return 'user_content_shape';
      } else {
        const content = message.content;
        const text = typeof content === 'string' ? content :
          Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : null;
        if (typeof text !== 'string') return 'user_content_shape';
        textHash = shaText(text);
      }
      scan.textMatches = textHash === scan.proof.textHash;
      if (!scan.textMatches) return 'user_text_mismatch';
    }
    scan.lastMessageRole = role;
    scan.lastMessageStopReason = message?.stopReason ?? null;
    scan.lastMessageAfterUser = scan.userCount === 1 && role !== 'user';
    scan.tailAllInert = true;
    scan.tailCustomMessages = 0;
    return null;
  }
  if (scan.lastMessageRole !== null) {
    if (!inertTailRow(row)) scan.tailAllInert = false;
    if (row.type === 'custom_message') scan.tailCustomMessages = Math.min(3, scan.tailCustomMessages + 1);
  }
  return null;
}

function parseSmallRecord(scan, bytes) {
  let row;
  try { row = JSON.parse(bytes.toString('utf8')); } catch { return 'malformed_json'; }
  return processRecord(scan, row, false);
}

function finishStreamedRecord(scan, rowBytes) {
  if (!scan.rowParser) scan.rowParser = new JsonRowStream();
  if (!scan.rowParser.write(rowBytes)) return 'malformed_json';
  const row = scan.rowParser.finish();
  scan.rowParser = null;
  return row ? processRecord(scan, row, true) : 'malformed_json';
}

function blankRecord(bytes) {
  for (const byte of bytes) if (byte !== 9 && byte !== 13 && byte !== 32) return false;
  return true;
}

function feed(scan, chunk) {
  let start = 0;
  for (;;) {
    const end = chunk.indexOf(10, start);
    if (end < 0) break;
    const part = chunk.subarray(start, end);
    const rowBytes = scan.rowParser ? part :
      scan.pending.length ? Buffer.concat([scan.pending, part]) : part;
    if (!scan.rowParser && blankRecord(rowBytes)) scan.blankLine = true;
    else {
      if (scan.blankLine) return 'malformed_json';
      const failure = scan.rowParser || rowBytes.length > SMALL_RECORD_BUFFER_BYTES ?
        finishStreamedRecord(scan, rowBytes) : parseSmallRecord(scan, rowBytes);
      if (failure) return failure;
    }
    scan.pending = Buffer.alloc(0);
    scan.rowParser = null;
    start = end + 1;
  }
  const remainder = chunk.subarray(start);
  if (scan.rowParser) {
    if (!scan.rowParser.write(remainder)) return 'malformed_json';
  } else if (scan.pending.length + remainder.length > SMALL_RECORD_BUFFER_BYTES) {
    scan.rowParser = new JsonRowStream();
    const initial = scan.pending.length ? Buffer.concat([scan.pending, remainder]) : remainder;
    if (!scan.rowParser.write(initial)) return 'malformed_json';
    scan.pending = Buffer.alloc(0);
  } else if (remainder.length) {
    scan.pending = scan.pending.length ? Buffer.concat([scan.pending, remainder]) : Buffer.from(remainder);
  }
  return null;
}

function scanDiagnostic(scan, failure, extra = {}) {
  return {
    ...(failure ? { failure } : {}),
    identityMatches: true, fenceMatches: true,
    processedBytes: scan.cursor - scan.proof.offset,
    userCount: scan.userCount, textMatches: scan.textMatches,
    ...extra,
  };
}


function finalResult(scan) {
  if (scan.userCount !== 1) return rejected('user_count', scanDiagnostic(scan));
  if (scan.textMatches !== true) return rejected('user_text_mismatch', scanDiagnostic(scan));
  if (scan.compactionCount && (scan.compactionBeforeUser || !scan.lastMessageAfterUser ||
      scan.lastMessageRole !== 'assistant' || scan.lastMessageStopReason !== 'stop' ||
      !scan.tailAllInert || scan.tailCustomMessages > MAX_TAIL_CUSTOM_MESSAGES))
    return rejected('ambiguous_compaction', scanDiagnostic(scan));
  return { result: true, diagnostic: scanDiagnostic(scan, null, { textMatches: true }) };
}

async function openScanner(proof) {
  if (!proof || !decimalIdentity(proof.dev) || !decimalIdentity(proof.ino) ||
      !Number.isSafeInteger(proof.offset) || proof.offset < 0 ||
      !Number.isSafeInteger(proof.start) || proof.start < 0 || proof.start > proof.offset ||
      proof.offset - proof.start > HEADER_WINDOW || !/^[a-f0-9]{64}$/.test(proof.prefix) ||
      !/^[a-f0-9]{64}$/.test(proof.textHash)) return { result: false, diagnostic: { failure: 'invalid_proof' } };
  let handle;
  try {
    const opened = await open(proof.file, proof.identity);
    handle = opened.handle;
    const identityMatches = sameFile(opened.stat, proof);
    if (opened.stat.size < proof.offset) return { result: false, diagnostic: { failure: 'file_truncated', identityMatches } };
    const fenceMatches = await prefixMatches(handle, proof);
    if (!fenceMatches) return { result: false, diagnostic: { failure: 'fence_changed', identityMatches, fenceMatches } };
    const scan = scannerState(proof, handle);
    handle = undefined;
    return { scan };
  } catch {
    return { result: false, diagnostic: { failure: 'probe_error' } };
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function scanStep(scan) {
  const { proof, handle } = scan;
  try {
    const stat = await fileStat(handle);
    if (!sameFile(stat, proof))
      return rejected('file_identity_mismatch', scanDiagnostic(scan, null, { identityMatches: false }));
    if (stat.size < scan.cursor) return rejected('file_truncated', scanDiagnostic(scan));
    if (!await prefixMatches(handle, proof))
      return rejected('fence_changed', scanDiagnostic(scan, null, { fenceMatches: false }));
    if (stat.size === scan.cursor) {
      // A terminal event can precede the final transcript write; an open JSONL
      // row is not a failure until evidence changes or observation is aborted.
      return { result: null, diagnostic: scanDiagnostic(scan, 'awaiting_persistence') };
    }
    const count = Math.min(MAX_SCAN_BYTES_PER_PROBE, stat.size - scan.cursor);
    const chunk = await bytes(handle, scan.cursor, count);
    scan.hash.update(chunk);
    scan.cursor += count;
    const failure = feed(scan, chunk);
    if (failure) return rejected(failure, scanDiagnostic(scan));
    const after = await fileStat(handle);
    if (!sameFile(after, proof))
      return rejected('file_identity_mismatch', scanDiagnostic(scan, null, { identityMatches: false }));
    if (after.size < scan.cursor) return rejected('file_truncated', scanDiagnostic(scan));
    if (after.size > scan.cursor)
      return { result: null, moreAvailable: true, diagnostic: scanDiagnostic(scan, 'scanning') };
    if (scan.pending.length || scan.rowParser)
      return { result: null, diagnostic: scanDiagnostic(scan, 'awaiting_persistence') };
    const result = finalResult(scan);
    return result.result === true ? { ...result, endOffset: scan.cursor } : result;
  } catch {
    return rejected('probe_error', scanDiagnostic(scan));
  }
}

async function pathStillFenced(scan, exactSize = false) {
  let handle;
  try {
    const opened = await open(scan.proof.file, scan.proof.identity);
    handle = opened.handle;
    if (!sameFile(opened.stat, scan.proof))
      return { failure: 'file_identity_mismatch', identityMatches: false };
    if (opened.stat.size < scan.cursor) return { failure: 'file_truncated', identityMatches: true };
    if (exactSize && opened.stat.size !== scan.cursor) return { failure: 'transcript_changed', identityMatches: true };
    if (!await prefixMatches(handle, scan.proof))
      return { failure: 'fence_changed', identityMatches: true, fenceMatches: false };
    return null;
  } catch { return { failure: 'probe_error' }; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function verifyAppend(scan, signal) {
  const { proof } = scan;
  let handle;
  try {
    const opened = await open(proof.file, proof.identity);
    handle = opened.handle;
    if (!sameFile(opened.stat, proof))
      return { failure: 'file_identity_mismatch', identityMatches: false };
    if (opened.stat.size !== scan.cursor) return { failure: 'transcript_changed', identityMatches: true };
    if (!await prefixMatches(handle, proof))
      return { failure: 'fence_changed', identityMatches: true, fenceMatches: false };
    const hash = crypto.createHash('sha256');
    let offset = proof.offset;
    while (offset < scan.cursor) {
      if (signal?.aborted) return { failure: 'admission_aborted' };
      const count = Math.min(MAX_SCAN_BYTES_PER_PROBE, scan.cursor - offset);
      hash.update(await bytes(handle, offset, count));
      offset += count;
      await setImmediatePromise();
    }
    const digest = hash.digest('hex');
    if (digest !== scan.hash.copy().digest('hex')) return { failure: 'append_integrity_mismatch' };
    const after = await fileStat(handle);
    if (!sameFile(after, proof))
      return { failure: 'file_identity_mismatch', identityMatches: false };
    if (after.size !== scan.cursor) return { failure: 'transcript_changed', identityMatches: true };
    const current = await pathStillFenced(scan, true);
    if (current) return current;
    return { digest, endOffset: scan.cursor };
  } catch { return { failure: 'probe_error' }; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function waitForAppend(file, signal, hook) {
  if (signal?.aborted) return false;
  const controller = new AbortController();
  let timer, watcher, abortHandler;
  let aborted = new Promise(() => {});
  if (signal) aborted = new Promise(resolve => {
    abortHandler = () => resolve(false);
    signal.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    let changed;
    if (hook) changed = Promise.resolve().then(() => hook(APPEND_WAIT_MS));
    else {
      try {
        watcher = fs.watch(file, { signal: controller.signal });
        changed = watcher.next().then(() => true, () => true);
      } catch { changed = Promise.resolve(true); }
    }
    const fallback = new Promise(resolve => { timer = setTimeout(() => resolve(true), APPEND_WAIT_MS); });
    const outcome = await Promise.race([changed.then(() => true), fallback, aborted]);
    return outcome !== false && !signal?.aborted;
  } finally {
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    controller.abort();
    if (watcher) await watcher.return().catch(() => {});
  }
}

// Transcript correlation is incremental and has no aggregate-growth or
// elapsed-time ceiling. Each probe and each record is bounded; shutdown aborts
// observation, leaving the receipt unknown rather than replaying the task.
export async function reconcileAdmission(proof, options = {}) {
  const opened = await openScanner(proof);
  const fail = diagnostic => {
    try { options.onFailure?.(diagnostic); } catch { /* Diagnostics never gate admission. */ }
    return false;
  };
  if (!opened.scan) return fail(opened.diagnostic);
  const scan = opened.scan;
  const hooks = options.testHooks ?? {};
  const reportProgress = async () => {
    const processed = scan.cursor - proof.offset;
    if (processed - (scan.checkpointAt - proof.offset) < CHECKPOINT_BYTES) return true;
    try {
      await options.onProgress?.({
        fileDev: proof.dev, fileIno: proof.ino, fenceOffset: proof.offset,
        processedOffset: scan.cursor, appendHash: scan.hash.copy().digest('hex'),
      });
      scan.checkpointAt = scan.cursor;
      return true;
    } catch { return false; }
  };
  try {
    for (;;) {
      if (options.signal?.aborted) return fail({ failure: 'admission_aborted' });
      const observed = await scanStep(scan);
      if (observed.result === false) return fail(observed.diagnostic ?? { failure: 'probe_error' });
      if (observed.result === true) {
        const integrity = await verifyAppend(scan, options.signal);
        if (!integrity.digest) return fail({ ...observed.diagnostic, failure: integrity.failure });
        const proofRecord = {
          fileDev: proof.dev, fileIno: proof.ino, fenceOffset: proof.offset,
          endOffset: integrity.endOffset, appendHash: integrity.digest,
        };
        try { await options.onVerified?.(proofRecord); }
        catch { return fail({ ...observed.diagnostic, failure: 'admission_proof_persist_failed' }); }
        return true;
      }
      if (!await reportProgress()) return fail({ ...observed.diagnostic, failure: 'admission_checkpoint_failed' });
      if (observed.moreAvailable) { await setImmediatePromise(); continue; }
      const pathFailure = await pathStillFenced(scan);
      if (pathFailure) return fail({ ...observed.diagnostic, ...pathFailure });
      if (typeof hooks.afterEmptyAdmissionProbe === 'function') await hooks.afterEmptyAdmissionProbe();
      if (!await waitForAppend(proof.file, options.signal, hooks.wait)) return fail({ failure: 'admission_aborted' });
    }
  } catch {
    return fail({ failure: options.signal?.aborted ? 'admission_aborted' : 'probe_error' });
  } finally { await scan.handle.close().catch(() => {}); }
}

// OMP may append one compaction while the submitted run is still in progress,
// so it can sit between the sole user and the final message. Admission then
// requires the sole user before the compaction and a settled final `stop`
// assistant as the last message row; only the compaction or inert, bounded
// `custom_message` rows may follow. A custom_message is extension context, not
// a `message` row, so it can never supply the sole user or an assistant stop.
// Without a compaction, the sole exact user rule above is unchanged.
const MAX_TAIL_CUSTOM_MESSAGES = 2;
function inertTailRow(row) {
  // Shape per OMP CustomMessageEntry (session-entries.ts): extension context with boolean display.
  return row.type === 'custom' || row.type === 'compaction' ||
    (row.type === 'custom_message' && typeof row.customType === 'string' && Buffer.byteLength(row.customType) <= 128 &&
      typeof row.display === 'boolean' && (typeof row.content === 'string' || Array.isArray(row.content)) &&
      !('message' in row) && !('role' in row));
}

// Separate native authority for supported saved-session hosts. The ordinary
// byte fence above never accepts replacement files. No serialized receipt can
// recreate the live manager/operation authority used by this alternate proof.
const MAX_ENTRIES = 100000, MAX_ROW = 8 * 1024 * 1024, CHUNK = 262144;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const textHash = text => hash(Buffer.from(text, 'utf16le'));
const fail = (nativeFailure = 'native_snapshot_invalid') => { throw Object.assign(Error('native lineage unconfirmed'), {nativeFailure}); };
function canonical(value, depth = 0) {
  if (depth > 128) fail();
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
}
const digest = value => hash(canonical(value));
const userText = message => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) && message.content.length === 1 && message.content[0]?.type === 'text' &&
    typeof message.content[0].text === 'string' ? message.content[0].text : undefined;
const userStamp = message => digest([message?.role, message?.timestamp, message?.content]);
function identity(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 256 ||
      typeof entry.type !== 'string' || !entry.type || entry.type.length > 128 ||
      !(entry.parentId === null || typeof entry.parentId === 'string') ||
      (entry.activeLeafId !== undefined && entry.activeLeafId !== null && typeof entry.activeLeafId !== 'string')) fail();
  const role = entry.type === 'message' ? entry.message?.role : undefined;
  if (entry.type === 'message' && typeof role !== 'string') fail();
  return [entry.id, entry.parentId, entry.type, entry.activeLeafId ?? null, entry.activeLeafId !== undefined,
    role ?? null, role === 'user' ? digest(entry.message) : null, entry.timestamp ?? null];
}
function snapshot(manager) {
  const entries = manager.getEntries(), leaf = manager.getLeafId(), branch = manager.getBranch();
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES || !Array.isArray(branch)) fail();
  const rows = [], ids = new Set(), byId = new Map();
  for (const entry of entries) {
    const row = identity(entry);
    if (ids.has(entry.id)) fail('native_duplicate_id');
    if (entry.parentId !== null && !ids.has(entry.parentId)) fail('native_parent_invalid');
    if (entry.activeLeafId != null && entry.activeLeafId !== entry.id && !ids.has(entry.activeLeafId)) fail('native_leaf_mismatch');
    ids.add(entry.id); byId.set(entry.id, entry); rows.push(row);
  }
  if (leaf !== null && !ids.has(leaf)) fail('native_leaf_mismatch');
  let parent = null;
  for (const entry of branch) {
    if (entry.parentId !== parent || !byId.has(entry.id) || digest(identity(manager.getEntry(entry.id))) !== digest(identity(entry))) fail('native_branch_mismatch');
    parent = entry.id;
  }
  if (parent !== leaf || (entries.length && (entries.at(-1).activeLeafId !== undefined ? entries.at(-1).activeLeafId : entries.at(-1).id) !== leaf)) fail('native_leaf_mismatch');
  const header = manager.getHeader();
  if (!header || header.type !== 'session' || header.version !== 3) fail('native_header_invalid');
  return { entries, rows, ids, byId, leaf, branchIds: branch.map(e => e.id), headerDigest: digest(header),
    rowsDigest: digest(rows), branchDigest: digest(branch.map(identity)) };
}

// Resident entry objects are mutable. Retain only immutable projections/digests,
// the ID set, and the actual manager reference; never shallow entry snapshots.
export function captureNativeAdmission(manager, binding, rawFence, text, host, ownerEpoch, current) {
  if (!['getEntries','getBranch','getLeafId','getEntry','getHeader'].every(k => typeof manager?.[k] === 'function')) return;
  try {
    const before = snapshot(manager);
    if (!before.leaf || manager.getSessionId() !== binding.sessionId || !same(manager.getSessionFile(), rawFence.file)) return;
    return { manager, binding: { ...binding }, rawFence, host, ownerEpoch, current, operationId: crypto.randomUUID(),
      managerToken: crypto.randomUUID(), anchor: before.leaf, prefixCount: before.rows.length,
      prefixDigest: before.rowsDigest, ids: before.ids, idSetDigest: digest([...before.ids].sort()),
      textHash: textHash(text), textLength: text.length, valid: true, invoked: false,
      promptCount: 0, userStartCount: 0, userEndCount: 0, inputCount: 0 };
  } catch { return; }
}
function guard(capture, signal) {
  if (!capture?.valid || signal?.aborted || !capture.current() ||
      capture.manager.getSessionId() !== capture.binding.sessionId ||
      !same(capture.manager.getSessionFile(), capture.rawFence.file)) fail('native_owner_changed');
}
export function invokeNativeAdmission(capture) {
  if (!capture) return;
  guard(capture);
  const now = snapshot(capture.manager);
  if (now.leaf !== capture.anchor || now.rows.length !== capture.prefixCount || now.rowsDigest !== capture.prefixDigest) fail();
  capture.invoked = true;
}
export function observeNativeAdmission(capture, phase, event, ownedPhaseToken) {
  if (!capture?.valid || !capture.invoked) return;
  try {
    guard(capture);
    if (phase === 'phase_continuation') {
      if (!event.token || event.token.valid === false || capture.continuationToken) fail('native_continuation_conflict');
      validateNative(capture, true);
      if (capture.pendingPreparation) {
        if (capture.pendingPreparation !== event.token) fail('native_continuation_conflict');
        capture.pendingPreparation = undefined;
      } else capture.continuationToken = event.token;
    } else if (phase === 'input') {
      if (capture.promptCount !== 0 || capture.userStartCount !== 0 || capture.userEndCount !== 0 || capture.producedProof ||
          ++capture.inputCount !== 1 || event.source !== 'extension' || event.images?.length || textHash(event.text) !== capture.textHash) fail('native_event_order');
    } else if (phase === 'before_agent_start') {
      const promptReason = event.reason === undefined || event.reason === 'prompt';
      if (!promptReason || event.images?.length) fail();
      if (capture.continuationToken) {
        if (capture.continuationToken.valid === false) fail();
        validateNative(capture);
        capture.continuationToken = undefined; // One prompt per accepted owned nonterminal END.
      } else if (capture.promptCount === 1) {
        if (!ownedPhaseToken || ownedPhaseToken.valid === false || capture.pendingPreparation) fail('native_continuation_conflict');
        validateNative(capture);
        // Preparation may precede detached predecessor END. It is staged, not
        // authorized, until that exact owned phase supplies a true END.
        capture.pendingPreparation = ownedPhaseToken;
      } else {
        if (++capture.promptCount !== 1 || textHash(event.prompt) !== capture.textHash) fail();
        const now = snapshot(capture.manager);
        if (now.rows.slice(capture.prefixCount).some(row => row[5] === 'user')) fail();
      }
    } else if (event?.message?.role === 'user') {
      const message = event.message, text = userText(message);
      if (text === undefined || textHash(text) !== capture.textHash || text.length !== capture.textLength ||
          !Number.isSafeInteger(message.timestamp) || message.timestamp <= 0) fail();
      if (phase === 'message_start') {
        if (++capture.userStartCount !== 1 || capture.promptCount !== 1) fail();
        capture.userStamp = userStamp(message);
        // Extension observers are awaited individually; native persistence may
        // land between observers of the same event. Pin an exact resident user
        // when available, otherwise defer identity binding without granting it.
        const accepted = nativeUserSnapshot(capture, true);
        if (accepted) { capture.userId = accepted.userId; capture.userDigest = accepted.userDigest; }
      } else {
        if (++capture.userEndCount !== 1 || capture.userStartCount !== 1 || capture.userStamp !== userStamp(message)) fail();
        const accepted = nativeUserSnapshot(capture, true);
        if (accepted) { capture.userId = accepted.userId; capture.userDigest = accepted.userDigest; }
      }
    }
  } catch (error) { capture.valid = false; capture.failure = error?.nativeFailure ?? 'native_snapshot_invalid'; }
}
function nativeUserSnapshot(capture, allowPendingUser = false) {
  guard(capture);
  const now = snapshot(capture.manager);
  if (now.rows.length < capture.prefixCount || digest(now.rows.slice(0, capture.prefixCount)) !== capture.prefixDigest)
    fail('native_prefix_changed');
  if (!now.branchIds.includes(capture.anchor)) fail('native_anchor_missing');
  const added = now.entries.slice(capture.prefixCount);
  if (added.some(e => capture.ids.has(e.id) || e.type === 'branch_summary' || e.type === 'reset_boundary')) fail('native_boundary');
  const users = added.filter(e => e.type === 'message' && e.message.role === 'user');
  if (users.length === 0 && allowPendingUser && capture.userId === undefined) return;
  if (users.length !== 1) fail('native_user_count');
  const user = users[0], text = userText(user.message), anchorIndex = now.branchIds.indexOf(capture.anchor);
  if (capture.ids.has(user.id) || text === undefined || textHash(text) !== capture.textHash || text.length !== capture.textLength ||
      userStamp(user.message) !== capture.userStamp || now.branchIds.indexOf(user.id) <= anchorIndex) fail('native_user_mismatch');
  const userDigest = digest(identity(user));
  if (capture.userId !== undefined && (capture.userId !== user.id || capture.userDigest !== userDigest)) fail('native_user_identity_changed');
  return { ...now, userId: user.id, userParentId: user.parentId, userDigest,
    ancestryDigest: digest(now.branchIds.slice(anchorIndex)) };
}
function validateNative(capture, allowStagedPreparation = false) {
  if (!capture.invoked || capture.promptCount !== 1 || capture.userStartCount !== 1 || capture.userEndCount !== 1) fail('native_event_order');
  if (capture.pendingPreparation && !allowStagedPreparation) fail('native_continuation_conflict');
  const accepted = nativeUserSnapshot(capture);
  if (capture.userId === undefined) { capture.userId = accepted.userId; capture.userDigest = accepted.userDigest; }
  return accepted;
}

// END may contain only compacted live context. This certificate is separate
// from user admission: bind the exact current assistant, not just its native ID.
export function nativeAssistantStamp(message) {
  try {
    if (message?.role !== 'assistant' || !Number.isSafeInteger(message.timestamp) || message.timestamp <= 0 ||
        typeof message.provider !== 'string' || !message.provider || typeof message.model !== 'string' || !message.model ||
        typeof message.stopReason !== 'string' || !message.stopReason || !Array.isArray(message.content) ||
        typeof message.responseId !== 'string' || !message.responseId) return;
    return Object.freeze({timestamp:message.timestamp,provider:message.provider,model:message.model,
      stopReason:message.stopReason,responseId:message.responseId,
      digest:digest([message.timestamp,message.provider,message.model,message.stopReason,message.responseId,message.content])});
  } catch { return; }
}
function endpointEntry(native, stamp) {
  let found;
  for (const entry of native.entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant' || entry.message.responseId !== stamp.responseId) continue;
    if (found || nativeAssistantStamp(entry.message)?.digest !== stamp.digest) fail('native_endpoint_mismatch');
    found = entry;
  }
  if (!found) fail('native_endpoint_mismatch');
  return found;
}
const compactionIdentity = entry => digest([identity(entry), entry.firstKeptEntryId]);
function compactionEnd(capture, native, stamp, previousStamp) {
  if (!stamp) fail('native_compaction_unconfirmed');
  const branch = native.branchIds, userAt = branch.indexOf(native.userId);
  let compactAt = branch.length - 1;
  while (compactAt >= 0 && native.byId.get(branch[compactAt]).type !== 'compaction') compactAt--;
  const compact = native.byId.get(branch[compactAt]), keptAt = branch.indexOf(compact?.firstKeptEntryId);
  if (!compact || capture.ids.has(compact.id) || compactAt <= userAt || keptAt <= userAt || keptAt >= compactAt)
    fail('native_compaction_unconfirmed');
  const endpoint = endpointEntry(native, stamp), endpointAt = branch.indexOf(endpoint.id);
  if (capture.ids.has(endpoint.id) || endpointAt <= compactAt) fail('native_endpoint_mismatch');
  for (let i = endpointAt + 1; i < branch.length; i++)
    if (native.byId.get(branch[i]).type === 'message') fail('native_endpoint_mismatch');
  let rebasesPrevious = false;
  if (previousStamp) {
    const previous = endpointEntry(native, previousStamp), previousAt = branch.indexOf(previous.id);
    rebasesPrevious = previousAt > userAt && previousAt < keptAt;
  }
  return Object.freeze({compactionId:compact.id,compactionDigest:compactionIdentity(compact),
    endpointId:endpoint.id,endpointDigest:stamp.digest,stamp,rebasesPrevious});
}
export function nativeCompactionEnd(capture, stamp, previousStamp, willContinue) {
  try { return compactionEnd(capture, validateNative(capture, willContinue === true), stamp, previousStamp); }
  catch { return; }
}
function nativeAuthorityDigest(capture, native) {
  const bound = capture.compactionEnd;
  if (!bound) return native.rowsDigest;
  const current = compactionEnd(capture, native, bound.stamp);
  if (current.compactionId !== bound.compactionId || current.compactionDigest !== bound.compactionDigest ||
      current.endpointId !== bound.endpointId || current.endpointDigest !== bound.endpointDigest)
    fail('native_endpoint_mismatch');
  return digest([native.rowsDigest,bound.compactionId,bound.compactionDigest,bound.endpointId,bound.endpointDigest]);
}

// JSON.parse alone accepts duplicate object keys. Reject them (including escaped
// equivalents) before parsing, with bounded row bytes/depth and fatal UTF-8.
function strictRow(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      if (i >= text.length) fail();
      let j = i + 1; while (/\s/.test(text[j] ?? '') && j < text.length) j++;
      if (text[j] === ':') {
        const keys = stack.at(-1), key = JSON.parse(text.slice(start, i + 1));
        if (!(keys instanceof Set) || keys.has(key)) fail();
        keys.add(key);
      }
    } else if (c === '{' || c === '[') {
      if (stack.length >= 128) fail();
      stack.push(c === '{' ? new Set() : null);
    } else if (c === '}' || c === ']') stack.pop();
  }
  const row = JSON.parse(text);
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
  return row;
}
const fileIdentity = stat => ({ dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size),
  mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString() });
async function scanFile(handle, size, capture, signal, onRow) {
  const hash = crypto.createHash('sha256'); let cursor = 0, pending = [], length = 0;
  while (cursor < size) {
    guard(capture, signal);
    const buffer = Buffer.alloc(Math.min(CHUNK, size - cursor));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
    if (bytesRead !== buffer.length) fail();
    hash.update(buffer); cursor += bytesRead;
    if (onRow) {
      let start = 0;
      for (let i = 0; i < buffer.length; i++) if (buffer[i] === 10) {
        const part = buffer.subarray(start, i); length += part.length;
        if (!length || length > MAX_ROW) fail();
        pending.push(part); onRow(strictRow(Buffer.concat(pending, length)), length + 1);
        pending = []; length = 0; start = i + 1;
      }
      if (start < buffer.length) { const part = buffer.subarray(start); pending.push(part); length += part.length; }
      if (length > MAX_ROW) fail();
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  if (length) fail();
  return hash.digest('hex');
}
export async function reconcileNativeAdmission(capture, options = {}) {
  let handle;
  try {
    guard(capture, options.signal);
    // Initial production is one-use. A final semantic revalidation may replace
    // only this live operation's exact previously produced proof.
    if (capture.producedProof ? options.previousProof !== capture.producedProof : options.previousProof !== undefined) fail();
    const native = validateNative(capture), file = capture.rawFence.file;
    const boundEnd = capture.compactionEnd, authorityDigest = nativeAuthorityDigest(capture, native);
    await plain(file);
    const pathBefore = fileIdentity(await fs.lstat(file, { bigint: true }));
    handle = await fs.open(file, 'r');
    const opened = fileIdentity(await handle.stat({ bigint: true }));
    if (digest(opened) !== digest(pathBefore) || !Number.isSafeInteger(opened.size) || opened.size <= 0) fail();
    let headerSeen = false, entryIndex = 0, titleSeen = false;
    const contentDigest = await scanFile(handle, opened.size, capture, options.signal, (row, rowBytes) => {
      if (!headerSeen) {
        if (!titleSeen && titleSlot(row, rowBytes)) { titleSeen = true; return; }
        if (row.type !== 'session' || row.version !== 3 || row.id !== capture.binding.sessionId ||
            !same(row.cwd, capture.binding.cwd) || digest(row) !== native.headerDigest) fail();
        headerSeen = true; return;
      }
      if (entryIndex >= native.rows.length || digest(identity(row)) !== digest(native.rows[entryIndex++])) fail();
      if (boundEnd && ((row.id === boundEnd.endpointId && nativeAssistantStamp(row.message)?.digest !== boundEnd.endpointDigest) ||
          (row.id === boundEnd.compactionId && compactionIdentity(row) !== boundEnd.compactionDigest)))
        fail('native_endpoint_mismatch');
    });
    if (!headerSeen || entryIndex !== native.rows.length) fail();
    // A second full hash authenticates all bytes, not just admission projections.
    if (await scanFile(handle, opened.size, capture, options.signal) !== contentDigest) fail();
    await plain(file);
    if (digest(fileIdentity(await handle.stat({ bigint: true }))) !== digest(opened) ||
        digest(fileIdentity(await fs.lstat(file, { bigint: true }))) !== digest(opened)) fail();
    const after = validateNative(capture);
    if (after.rowsDigest !== native.rowsDigest || after.branchDigest !== native.branchDigest || after.leaf !== native.leaf ||
        after.headerDigest !== native.headerDigest || capture.compactionEnd !== boundEnd ||
        nativeAuthorityDigest(capture, after) !== authorityDigest) fail();
    const evidence = { kind: 'native-lineage-v1', host: capture.host, operationId: capture.operationId,
      ownerEpoch: capture.ownerEpoch, managerToken: capture.managerToken, sessionId: capture.binding.sessionId,
      planId: capture.binding.planId, step: capture.binding.step,
      cwd: capture.binding.cwd, file, originalFence: { fileDev: capture.rawFence.dev, fileIno: capture.rawFence.ino,
        start: capture.rawFence.start, offset: capture.rawFence.offset, prefixHash: capture.rawFence.prefix, textHash: capture.rawFence.textHash },
      anchorId: capture.anchor, prefixCount: capture.prefixCount, prefixDigest: capture.prefixDigest,
      idSetDigest: capture.idSetDigest, userId: native.userId, userParentId: native.userParentId,
      textLength: capture.textLength, textHash: capture.textHash, userDigest: native.userDigest,
      ancestryDigest: native.ancestryDigest, branchDigest: native.branchDigest, leafId: native.leaf,
      nativeDigest: authorityDigest, headerDigest: native.headerDigest,
      fileDev: opened.dev, fileIno: opened.ino, byteLength: opened.size, contentDigest };
    guard(capture, options.signal);
    await options.onVerified?.(evidence);
    guard(capture, options.signal);
    // A proof persisted during navigation or a rewrite cannot advance the step.
    const committed = validateNative(capture);
    if (committed.rowsDigest !== native.rowsDigest || committed.branchDigest !== native.branchDigest || committed.headerDigest !== native.headerDigest ||
        capture.compactionEnd !== boundEnd || nativeAuthorityDigest(capture, committed) !== authorityDigest ||
        digest(fileIdentity(await handle.stat({ bigint: true }))) !== digest(opened) ||
        digest(fileIdentity(await fs.lstat(file, { bigint: true }))) !== digest(opened)) fail();
    guard(capture, options.signal);
    const finalNative = validateNative(capture);
    if (finalNative.rowsDigest !== native.rowsDigest || finalNative.branchDigest !== native.branchDigest ||
        finalNative.headerDigest !== native.headerDigest || capture.compactionEnd !== boundEnd ||
        nativeAuthorityDigest(capture, finalNative) !== authorityDigest) fail();
    capture.producedProof = evidence;
    return true;
  } catch (error) {
    try { options.onFailure?.({failure:error?.nativeFailure ?? 'native_snapshot_invalid'}); } catch {}
    return false;
  }
  finally { await handle?.close().catch(() => {}); }
}

// Synchronous advancement boundary after the supervisor's last await. A saved
// proof is not a substitute for the still-live captured owner/manager/epoch.
export function commitNativeAdmission(capture, evidence) {
  guard(capture);
  if (capture.producedProof !== evidence || capture.consumed) return false;
  const current = validateNative(capture);
  if (nativeAuthorityDigest(capture, current) !== evidence.nativeDigest || current.branchDigest !== evidence.branchDigest ||
      current.headerDigest !== evidence.headerDigest || current.leaf !== evidence.leafId) return false;
  capture.consumed = true; capture.valid = false;
  return true;
}
