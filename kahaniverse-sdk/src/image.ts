import sharp from 'sharp';

// The backend caps uploads at 5 MB. Stay comfortably under it; compression
// happens here (on the uploader's machine) so the server never resizes anything.
const MAX_BYTES = 4_800_000;

export interface Prepared {
  buffer: Buffer;
  width: number;
  height: number;
  /** width ≥ 1.2 × height — almost certainly a two-page spread. */
  wide: boolean;
  contentType: 'image/webp';
}

/**
 * Compress a comic/story page to webp, capping the long edge and stepping
 * quality down until it fits under the upload limit. Single pages cap at
 * `maxDim`; spreads are allowed to be wider (`maxDim * 2`) so detail survives.
 */
export async function prepareImage(
  file: string,
  { maxDim = 2048, quality = 82 }: { maxDim?: number; quality?: number } = {},
): Promise<Prepared> {
  const meta = await sharp(file).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const wide = w >= h * 1.2;
  const cap = wide ? maxDim * 2 : maxDim;

  const base = sharp(file, { failOn: 'none' }).rotate(); // honour EXIF orientation
  const resized = w > cap || h > cap
    ? base.resize({ width: w >= h ? cap : undefined, height: h > w ? cap : undefined, fit: 'inside' })
    : base;

  let q = quality;
  let buffer = await resized.clone().webp({ quality: q }).toBuffer();
  while (buffer.byteLength > MAX_BYTES && q > 40) {
    q -= 10;
    buffer = await resized.clone().webp({ quality: q }).toBuffer();
  }
  const out = await sharp(buffer).metadata();

  return {
    buffer,
    width: out.width ?? w,
    height: out.height ?? h,
    wide,
    contentType: 'image/webp',
  };
}
