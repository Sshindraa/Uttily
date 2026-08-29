import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Alert, Badge, Button, Dialog, Field, Icon, LinkButton } from './primitives';

describe('@uttily/ui primitives', () => {
  it('renders native controls with the shared interaction contract', () => {
    const html = renderToStaticMarkup(
      <Field
        label="Destination"
        htmlFor="destination"
        help="Ville ou lieu de retrait"
        error="Choisissez un lieu."
      >
        <input id="destination" />
      </Field>,
    );

    expect(html).toContain('for="destination"');
    expect(html).toContain('aria-describedby="destination-help destination-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('Ville ou lieu de retrait');
    expect(html).toContain('role="alert"');
  });

  it('keeps button, link, status and icon semantics explicit', () => {
    const html = renderToStaticMarkup(
      <>
        <Button disabled>Enregistrer</Button>
        <LinkButton href="/fr/search" variant="secondary">
          Rechercher
        </LinkButton>
        <Badge tone="success">Disponible</Badge>
        <Alert tone="danger">Une action est nécessaire.</Alert>
        <Icon name="search" />
      </>,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('href="/fr/search"');
    expect(html).toContain('Disponible');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('exposes a uniquely labelled modal contract', () => {
    const html = renderToStaticMarkup(
      <Dialog open title="Confirmer la suppression" onClose={() => undefined}>
        Cette action est définitive.
      </Dialog>,
    );

    expect(html).toContain('<dialog');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toContain('aria-label="Fermer"');
  });
});
