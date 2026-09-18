// 直接解析 GGUF 头部元数据，看这个 7B 文件到底是什么
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录（本脚本住在 测试脚本/ 下）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseGGUF(p, limit = 40) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 26);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let o = 0;
  const magic = buf.toString('ascii', 0, 4); o = 4;
  const ver = buf.readUInt32LE(o); o += 4;
  const nTensor = Number(buf.readBigUInt64LE(o)); o += 8;
  const nKV = Number(buf.readBigUInt64LE(o)); o += 8;

  const S = () => { const l = Number(buf.readBigUInt64LE(o)); o += 8; const s = buf.toString('utf8', o, o + l); o += l; return s; };
  const V = (t) => {
    switch (t) {
      case 0: { const v = buf.readUInt8(o); o += 1; return v; }
      case 1: { const v = buf.readInt8(o); o += 1; return v; }
      case 2: { const v = buf.readUInt16LE(o); o += 2; return v; }
      case 3: { const v = buf.readInt16LE(o); o += 2; return v; }
      case 4: { const v = buf.readUInt32LE(o); o += 4; return v; }
      case 5: { const v = buf.readInt32LE(o); o += 4; return v; }
      case 6: { const v = buf.readFloatLE(o); o += 4; return v; }
      case 7: { const v = buf.readUInt8(o) ? true : false; o += 1; return v; }
      case 8: { return S(); }
      case 9: { const et = buf.readUInt32LE(o); o += 4; const l = Number(buf.readBigUInt64LE(o)); o += 8; const keep = []; for (let i = 0; i < l; i++) { const v = V(et); if (i < 8) keep.push(v); } return `[type${et}]x${l} ${JSON.stringify(keep).slice(0, 120)}`; }
      case 10: { const v = Number(buf.readBigUInt64LE(o)); o += 8; return v; }
      case 11: { const v = Number(buf.readBigInt64LE(o)); o += 8; return v; }
      case 12: { const v = Number(buf.readDoubleLE(o)); o += 8; return v; }
      default: throw new Error('unknown type ' + t + ' at ' + o);
    }
  };

  const out = [];
  let oAfterKV = 0;
  for (let i = 0; i < nKV && i < limit; i++) {
    const k = S(); const t = buf.readUInt32LE(o); o += 4;
    let v; try { v = V(t); } catch (e) { v = '<err ' + e.message + '>'; }
    out.push([k, v]);
  }
  oAfterKV = o;
  return { magic, ver, nTensor, nKV, out, buf, oAfterKV };
}

function readTensors(buf, o, nTensor) {
  const TS = { 0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1', 10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K', 16: 'IQ2_XXS' };
  const S = () => { const l = Number(buf.readBigUInt64LE(o)); o += 8; const s = buf.toString('utf8', o, o + l); o += l; return s; };
  const res = [];
  for (let i = 0; i < nTensor; i++) {
    const name = S();
    const nd = buf.readUInt32LE(o); o += 4;
    const dims = [];
    for (let d = 0; d < nd; d++) { dims.push(Number(buf.readBigUInt64LE(o))); o += 8; }
    const type = buf.readUInt32LE(o); o += 4;
    const off = Number(buf.readBigUInt64LE(o)); o += 8;
    res.push({ name, dims, type: TS[type] || type, off });
  }
  return res;
}

for (const [label, p] of [
  ['3B', path.join(ROOT, 'data/models/qwen2.5-3b-instruct-q4_k_m.gguf')],
  ['7B', path.join(ROOT, 'data/models/qwen2.5-7b-instruct-q4_k_m.gguf')],
]) {
  console.log('\n================ ' + label + ' : ' + p);
  const g = parseGGUF(p, 60);
  console.log('magic=' + g.magic, 'ver=' + g.ver, 'tensors=' + g.nTensor, 'kv=' + g.nKV);
  for (const [k, v] of g.out) {
    if (/tokenizer\.ggml\.(tokens|token_type|merges)/i.test(k)) { console.log('  ' + k + ' = <' + String(v).slice(0, 60) + '…>'); continue; }
    if (/architecture|general\.name|general\.file_type|quantization_version|block_count|context_length|embedding_length|feed_forward|attention|head_count|rope|vocab_size|tokenizer\.ggml\.model|eos|bos|pad|chat_template/i.test(k))
      console.log('  ' + k + ' = ' + v);
  }
  const ts = readTensors(g.buf, g.oAfterKV, g.nTensor);
  for (const name of ['token_embd.weight', 'output.weight', 'output_norm.weight']) {
    const t = ts.find(x => x.name === name);
    console.log('  >> ' + name + ' = ' + (t ? `[${t.dims.join(' x ')}] ${t.type}` : 'NOT FOUND'));
  }
  const qcount = ts.filter(x => /blk\.0\./.test(x.name)).length;
  console.log('  >> 第0层张量数 = ' + qcount + ' ，总张量 = ' + ts.length);
}
