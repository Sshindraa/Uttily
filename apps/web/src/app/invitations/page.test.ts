import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('invitations authentication continuity', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('preserves the invitation token while redirecting an anonymous user to sign-in', () => {
    expect(pageSource).toContain('prefilledToken');
    expect(pageSource).toContain('/invitations?token=');
    expect(pageSource).toContain('redirect_url=');
  });
});
