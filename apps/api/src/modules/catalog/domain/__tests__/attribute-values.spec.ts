import { attributeSignature } from '../attribute-values';

describe('attributeSignature', () => {
  it('produces the same signature regardless of input order (order-independent combination)', () => {
    const a = attributeSignature(['id-2', 'id-1']);
    const b = attributeSignature(['id-1', 'id-2']);
    expect(a).toBe(b);
  });

  it('produces different signatures for different combinations', () => {
    expect(attributeSignature(['id-1'])).not.toBe(attributeSignature(['id-2']));
    expect(attributeSignature(['id-1', 'id-2'])).not.toBe(attributeSignature(['id-1']));
  });

  it('the empty combination (no attributes) has a stable signature', () => {
    expect(attributeSignature([])).toBe(attributeSignature([]));
  });
});
