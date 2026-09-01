import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/app/actions/product-photos', () => ({
  uploadProductPhotoAction: vi.fn(),
}));

import { NeutralPhotoUploader } from './neutral-photo-uploader';

describe('uploader photo neutre', () => {
  it('permet l’ajout sans vocabulaire, slot ni règle vélo', () => {
    const html = renderToStaticMarkup(
      <NeutralPhotoUploader
        organizationId="org-1"
        productId="product-1"
        photos={[{ id: 'photo-1', publicId: 'photo-public-1' }]}
        count={2}
        minRequired={3}
        isComplete={false}
      />,
    );

    expect(html).toContain('Photos de l’équipement');
    expect(html).toContain('2/3 photos valides');
    expect(html).toContain('Ajouter une photo');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).not.toContain('Photo Coach');
    expect(html).not.toContain('HERO_PROFILE');
    expect(html).not.toContain('Standard Photo Coach');
    expect(html).not.toContain('🚲');
  });
});
