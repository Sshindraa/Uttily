import { describe, it, expect } from 'vitest';
import { parseUpdateProduct, parseUpdateVariant, parseUpdateInventoryItem } from './parsers';
import type {
  UpdateProductInput,
  UpdateVariantInput,
  UpdateInventoryItemInput,
} from '@uttily/core';

type SuccessResult<T> = { input: T };

describe('parseUpdateProduct - description', () => {
  it('absente → undefined (ne pas modifier)', () => {
    const fd = new FormData();
    fd.append('productId', '00000000-0000-0000-0000-000000000001');
    const result = parseUpdateProduct(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateProductInput>;
    expect(success.input.description).toBeUndefined();
  });

  it('présente vide → "" (effacer)', () => {
    const fd = new FormData();
    fd.append('productId', '00000000-0000-0000-0000-000000000001');
    fd.append('description', '');
    const result = parseUpdateProduct(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateProductInput>;
    expect(success.input.description).toBe('');
  });

  it('présente non-vide → trimmed', () => {
    const fd = new FormData();
    fd.append('productId', '00000000-0000-0000-0000-000000000001');
    fd.append('description', '  Nouvelle description  ');
    const result = parseUpdateProduct(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateProductInput>;
    expect(success.input.description).toBe('Nouvelle description');
  });
});

describe('parseUpdateVariant - skuSuffix', () => {
  it('absent → undefined (ne pas modifier)', () => {
    const fd = new FormData();
    fd.append('variantId', '00000000-0000-0000-0000-000000000001');
    const result = parseUpdateVariant(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateVariantInput>;
    expect(success.input.skuSuffix).toBeUndefined();
  });

  it('présent vide → null (effacer)', () => {
    const fd = new FormData();
    fd.append('variantId', '00000000-0000-0000-0000-000000000001');
    fd.append('skuSuffix', '');
    const result = parseUpdateVariant(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateVariantInput>;
    expect(success.input.skuSuffix).toBeNull();
  });

  it('présent non-vide → trimmed', () => {
    const fd = new FormData();
    fd.append('variantId', '00000000-0000-0000-0000-000000000001');
    fd.append('skuSuffix', '  RED  ');
    const result = parseUpdateVariant(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateVariantInput>;
    expect(success.input.skuSuffix).toBe('RED');
  });
});

describe('parseUpdateInventoryItem - serialNumber et notes', () => {
  it('absents → undefined (ne pas modifier)', () => {
    const fd = new FormData();
    fd.append('itemId', '00000000-0000-0000-0000-000000000001');
    const result = parseUpdateInventoryItem(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateInventoryItemInput>;
    expect(success.input.serialNumber).toBeUndefined();
    expect(success.input.notes).toBeUndefined();
  });

  it('présents vides → null (effacer)', () => {
    const fd = new FormData();
    fd.append('itemId', '00000000-0000-0000-0000-000000000001');
    fd.append('serialNumber', '');
    fd.append('notes', '');
    const result = parseUpdateInventoryItem(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateInventoryItemInput>;
    expect(success.input.serialNumber).toBeNull();
    expect(success.input.notes).toBeNull();
  });

  it('présents non-vides → trimmed', () => {
    const fd = new FormData();
    fd.append('itemId', '00000000-0000-0000-0000-000000000001');
    fd.append('serialNumber', '  SN-001  ');
    fd.append('notes', '  Note importante  ');
    const result = parseUpdateInventoryItem(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateInventoryItemInput>;
    expect(success.input.serialNumber).toBe('SN-001');
    expect(success.input.notes).toBe('Note importante');
  });

  it('mixte : serialNumber vide (null) et notes absent (undefined)', () => {
    const fd = new FormData();
    fd.append('itemId', '00000000-0000-0000-0000-000000000001');
    fd.append('serialNumber', '');
    const result = parseUpdateInventoryItem(fd);
    expect(result).not.toHaveProperty('fieldErrors');
    const success = result as SuccessResult<UpdateInventoryItemInput>;
    expect(success.input.serialNumber).toBeNull();
    expect(success.input.notes).toBeUndefined();
  });
});
