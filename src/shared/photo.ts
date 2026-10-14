/** Turn a picked image file into a small square JPEG data URL (centre-cropped), for profile photos. */
export async function squarePhoto(file: File, size = 320, quality = 0.85): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose a photo.');
  if (file.size > 25 * 1024 * 1024) throw new Error('That photo is too big. Please pick a smaller one.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That photo couldn't be opened. Try a JPEG or PNG."));
      i.src = url;
    });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Photos are not supported on this device.');
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
