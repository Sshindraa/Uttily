/**
 * Capture directe d'une frame haute résolution depuis l'élément vidéo HTML.
 *
 * Invariant strict : l'overlay SVG/CSS client n'est JAMAIS rendu sur le canvas.
 * Seuls les pixels bruts du capteur vidéo sont transformés en Blob.
 */
export async function captureVideoFrame(video: HTMLVideoElement, quality = 0.95): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const width = video.videoWidth || 1920;
  const height = video.videoHeight || 1080;

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Impossible d’initialiser le contexte graphique 2D pour la capture.');
  }

  // Dessin exclusif des pixels du flux vidéo
  ctx.drawImage(video, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Échec de la génération du fichier image.'));
        }
      },
      'image/jpeg',
      quality,
    );
  });
}
