import { describe, it, expect } from 'vitest';
import * as schema from './schema';

describe('@uttily/database schema', () => {
  it('expose les tables du Lot 1', () => {
    expect(schema.users).toBeDefined();
    expect(schema.organizations).toBeDefined();
    expect(schema.organizationMemberships).toBeDefined();
    expect(schema.locations).toBeDefined();
    expect(schema.locationOpeningHours).toBeDefined();
    expect(schema.locationScheduleExceptions).toBeDefined();
    expect(schema.organizationInvitations).toBeDefined();
    expect(schema.auditLog).toBeDefined();
  });
});
