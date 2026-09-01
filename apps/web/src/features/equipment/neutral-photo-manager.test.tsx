import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NeutralPhotoManager } from './neutral-photo-manager';

describe('gestionnaire photo neutre', () => {
  it('présente les photos sans vocabulaire ni slots de catégorie', () => {
    const html = renderToStaticMarkup(
      <NeutralPhotoManager
        photos={{
          count: 2,
          minRequired: 3,
          isComplete: false,
          items: [
            {
              id: 'photo-1',
              publicId: 'photo-public-1',
              storageKey: 'photo-storage-1',
              sortOrder: 0,
              slotKey: 'HERO_PROFILE',
              fileState: 'AVAILABLE',
              byteSize: 1024,
              mimeType: 'image/jpeg',
              checksumSha256: 'sha-1',
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        }}
      />,
    );

    expect(html).toContain('Photos de l’équipement');
    expect(html).toContain('2/3 photos valides');
    expect(html).toContain('/api/public/product-photos/photo-public-1');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('HERO_PROFILE');
    expect(html).not.toContain('vues requises');
  });
});
