import { describe, it, expect } from 'vitest';
import { assertLocalhost } from './assert-localhost';

describe('assertLocalhost', () => {
  it('accepte localhost', () => {
    expect(() => assertLocalhost('postgresql://u:p@localhost:5432/db')).not.toThrow();
  });

  it('accepte 127.0.0.1', () => {
    expect(() => assertLocalhost('postgresql://u:p@127.0.0.1:5432/db')).not.toThrow();
  });

  it('accepte [::1] (IPv6 localhost avec crochets)', () => {
    expect(() => assertLocalhost('postgresql://u:p@[::1]:5432/db')).not.toThrow();
  });

  it('rejette un hôte distant', () => {
    expect(() => assertLocalhost('postgresql://u:p@example.com:5432/db')).toThrow();
  });

  it('rejette une IP distante', () => {
    expect(() => assertLocalhost('postgresql://u:p@1.2.3.4:5432/db')).toThrow();
  });
});
