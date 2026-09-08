/**
 * @uttily/core — Sanitisation et expurgation des métadonnées EXIF (ADR-042).
 *
 * Supprime les segments d'en-tête sensibles (APP1 Exif/XMP, GPS, commentaires)
 * d'un buffer JPEG sans modifier les pixels ni la qualité de l'image.
 */

export interface ExifSanitizationResult {
  readonly sanitizedBuffer: Uint8Array;
  readonly hadExifData: boolean;
  readonly bytesStripped: number;
}

/**
 * Expurgation déterministe des métadonnées EXIF d'un buffer binaire JPEG.
 *
 * Structure d'un JPEG :
 * - SOI (0xFF 0xD8)
 * - Segments d'en-tête (0xFF 0xXX + 2 octets longueur)
 *   - 0xFF 0xE1 : APP1 (Exif & XMP contenant géolocalisation GPS, horodatage, modèle)
 *   - 0xFF 0xED : APP13 (Photoshop metadata)
 *   - 0xFF 0xFE : COM (Commentaires textuels)
 * - SOS (0xFF 0xDA) : Début du flux de pixels compressés
 */
export function stripJpegExif(buffer: Uint8Array): ExifSanitizationResult {
  // Vérification de signature JPEG SOI (0xFF 0xD8)
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return {
      sanitizedBuffer: buffer,
      hadExifData: false,
      bytesStripped: 0,
    };
  }

  const chunks: Uint8Array[] = [];
  // Copier le marqueur SOI
  chunks.push(new Uint8Array([0xff, 0xd8]));

  let offset = 2;
  let hadExifData = false;
  let bytesStripped = 0;

  while (offset < buffer.length) {
    // Les marqueurs JPEG commencent toujours par 0xFF
    if (buffer[offset] !== 0xff) {
      // Données brutes ou fin anormale : copier le reste tel quel
      chunks.push(buffer.subarray(offset));
      break;
    }

    const marker = buffer[offset + 1];

    // SOS (Start of Scan, 0xFF 0xDA) ou EOI (End of Image, 0xFF 0xD9) :
    // Tout ce qui suit est le flux de données compressées, on conserve l'intégralité
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(buffer.subarray(offset));
      break;
    }

    // Marqueurs autonomes sans longueur (RST, SOI, TEM)
    if ((marker !== undefined && marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      chunks.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    // Vérifier que la longueur du segment est lisible
    if (offset + 4 > buffer.length) {
      chunks.push(buffer.subarray(offset));
      break;
    }

    const segmentLength = (buffer[offset + 2]! << 8) | buffer[offset + 3]!;
    const segmentEnd = offset + 2 + segmentLength;

    if (segmentEnd > buffer.length) {
      // Données tronquées
      chunks.push(buffer.subarray(offset));
      break;
    }

    // Segment APP1 (0xFF 0xE1 = Exif/XMP) ou COM (0xFF 0xFE = Commentaires) :
    // À EXPURGER impérativement pour la confidentialité
    if (marker === 0xe1 || marker === 0xfe) {
      hadExifData = true;
      bytesStripped += 2 + segmentLength;
    } else {
      // Conserver les autres segments techniques (JFIF 0xE0, Quantization 0xDB, DQT/SOF/DHT)
      chunks.push(buffer.subarray(offset, segmentEnd));
    }

    offset = segmentEnd;
  }

  // Assembler les morceaux expurgés
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const sanitizedBuffer = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    sanitizedBuffer.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  return {
    sanitizedBuffer,
    hadExifData,
    bytesStripped,
  };
}
