import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../features/internal/notifications-support-view.tsx');

describe('NotificationsSupportPage (Chantier 16 & 21-U1-D23)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('garde la protection plateforme, le filtre et la lecture Core dans la route', () => {
    expect(pageSource).toContain('requireSupportPlatformAdmin');
    expect(pageSource).toContain('listNotificationsSupport');
    expect(pageSource).toContain('validStatus');
    expect(pageSource).toContain('<NotificationsSupportView');
  });

  it('déporte le tableau et les actions sécurisées dans la feature interne', () => {
    expect(featureSource).toContain('Console Notifications & Invitations');
    expect(featureSource).toContain('NotificationActionButtons');
    expect(featureSource).not.toContain('requireSupportPlatformAdmin');
  });
});
