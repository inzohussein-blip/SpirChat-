// Aggressive client-side compression: images must squeeze through weak links.

const MAX_IMAGE_CHARS = 150_000; // base64 data URL length, ~110 KB of image
const MAX_THUMB_CHARS = 10_000;

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encode(src: ImageBitmap | HTMLImageElement, maxSide: number, quality: number): string {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  // Re-encoding through a canvas also strips EXIF metadata such as GPS location.
  const webp = canvas.toDataURL('image/webp', quality);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
}

function fit(src: ImageBitmap | HTMLImageElement, sides: number[], maxChars: number): string {
  let last = '';
  for (const side of sides) {
    for (const q of [0.7, 0.55, 0.4, 0.3]) {
      last = encode(src, side, q);
      if (last.length <= maxChars) return last;
    }
  }
  throw new Error(`image too large (${last.length})`);
}

export async function compressImage(file: File): Promise<{ image: string; thumb: string }> {
  const src = await loadBitmap(file);
  return {
    image: fit(src, [1080, 800, 600, 400], MAX_IMAGE_CHARS),
    thumb: fit(src, [200, 120], MAX_THUMB_CHARS),
  };
}
