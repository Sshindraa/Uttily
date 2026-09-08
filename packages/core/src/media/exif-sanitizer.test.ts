import { describe, it, expect } from 'vitest';
import { stripJpegExif } from './exif-sanitizer';

describe('EXIF Sanitizer (ADR-042)', () => {
  it('laisse inchangé un buffer non-JPEG sans erreur', () => {
    const rawData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // Signature PNG
    const result = stripJpegExif(rawData);
    expect(result.hadExifData).toBe(false);
    expect(result.bytesStripped).toBe(0);
    expect(result.sanitizedBuffer).toEqual(rawData);
  });

  it('supprime proprement les blocs APP1 (Exif) et préserve les blocs techniques', () => {
    // Construction d'un JPEG synthétique valide avec APP0 (JFIF), APP1 (EXIF) et SOS
    const jfifSegment = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0x00)]; // 16 octets
    const exifSegment = [
      0xff,
      0xe1,
      0x00,
      0x1c, // longueur 28 (2 + 26)
      0x45,
      0x78,
      0x69,
      0x66,
      0x00,
      0x00, // "Exif\0\0"
      ...new Array(20).fill(0x42), // Données GPS / camera
    ];
    const sosSegment = [
      0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    ];
    const rawScanData = [0x12, 0x34, 0x56, 0x78, 0xff, 0xd9]; // Données pixels + EOI

    const fullJpeg = new Uint8Array([
      0xff,
      0xd8, // SOI
      ...jfifSegment,
      ...exifSegment,
      ...sosSegment,
      ...rawScanData,
    ]);

    const result = stripJpegExif(fullJpeg);

    expect(result.hadExifData).toBe(true);
    expect(result.bytesStripped).toBe(exifSegment.length);
    expect(result.sanitizedBuffer.length).toBe(fullJpeg.length - exifSegment.length);

    // Vérifier que le segment EXIF a complètement disparu du buffer assaini
    const resultString = Buffer.from(result.sanitizedBuffer).toString('latin1');
    expect(resultString).not.toContain('Exif');
    // Vérifier que le début (SOI) et la fin (EOI) sont préservés
    expect(result.sanitizedBuffer[0]).toBe(0xff);
    expect(result.sanitizedBuffer[1]).toBe(0xd8);
    expect(result.sanitizedBuffer[result.sanitizedBuffer.length - 2]).toBe(0xff);
    expect(result.sanitizedBuffer[result.sanitizedBuffer.length - 1]).toBe(0xd9);
  });
});
