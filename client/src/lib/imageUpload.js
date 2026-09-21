function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

function coverCanvas(img, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const sw = width / scale;
  const sh = height / scale;
  ctx.fillStyle = "#f5efe6";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(
    img,
    (img.naturalWidth - sw) / 2,
    (img.naturalHeight - sh) / 2,
    sw,
    sh,
    0,
    0,
    width,
    height
  );
  return canvas;
}

function fitCanvas(img, maxEdge) {
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function scaleCanvas(canvas, factor) {
  const next = document.createElement("canvas");
  next.width = Math.max(1, Math.round(canvas.width * factor));
  next.height = Math.max(1, Math.round(canvas.height * factor));
  next.getContext("2d").drawImage(canvas, 0, 0, next.width, next.height);
  return next;
}

export async function fileToJpegDataUrl(file, options = {}) {
  const maxJsonBytes = options.maxJsonBytes || 850000;
  const img = await loadImage(file);
  let canvas =
    options.width && options.height
      ? coverCanvas(img, options.width, options.height)
      : fitCanvas(img, options.maxEdge || 1600);

  let quality = 0.84;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > maxJsonBytes && quality > 0.5) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  while (dataUrl.length > maxJsonBytes && canvas.width > 640) {
    canvas = scaleCanvas(canvas, 0.85);
    quality = 0.72;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > maxJsonBytes) {
    throw new Error("Image too large");
  }
  return dataUrl;
}

export function bannerUploadSize(slot) {
  return slot <= 3 ? { width: 1920, height: 720 } : { width: 1600, height: 480 };
}
