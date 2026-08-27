import fs from 'node:fs';

const vrmPath = process.argv[2];
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });

const buf = fs.readFileSync(vrmPath);
let offset = 12;
let json = null;
let binChunk = null;
while (offset < buf.length) {
  const chunkLen = buf.readUInt32LE(offset);
  const chunkType = buf.toString('ascii', offset + 4, offset + 8);
  const dataStart = offset + 8;
  if (chunkType === 'JSON') json = JSON.parse(buf.toString('utf8', dataStart, dataStart + chunkLen));
  if (chunkType === 'BIN\0') binChunk = buf.subarray(dataStart, dataStart + chunkLen);
  offset = dataStart + chunkLen;
}

console.log('images:', json.images.length, 'textures:', json.textures.length);

for (let i = 0; i < json.images.length; i++) {
  const img = json.images[i];
  const view = json.bufferViews[img.bufferView];
  const data = binChunk.subarray(view.byteOffset, view.byteOffset + view.byteLength);
  const ext = img.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  fs.writeFileSync(`${outDir}/image_${String(i).padStart(2, '0')}_${img.name || 'unnamed'}.${ext}`, data);
}

console.log('--- material -> image map ---');
for (const mat of json.materials) {
  const texIdx = mat.pbrMetallicRoughness?.baseColorTexture?.index;
  const imgIdx = texIdx != null ? json.textures[texIdx]?.source : null;
  console.log(mat.name, '-> baseColorTexture image index', imgIdx, imgIdx != null ? json.images[imgIdx].name : null);
}

fs.writeFileSync(`${outDir}/_gltf.json`, JSON.stringify(json, null, 2));
console.log('DONE, extracted to', outDir);
