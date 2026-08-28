import { omitFields } from '../omit-fields';

describe('omitFields', () => {
  it('removes the given keys while keeping the rest', () => {
    const result = omitFields({ a: 1, b: 2, c: 3 }, ['b']);
    expect(result).toEqual({ a: 1, c: 3 });
  });

  it('does not mutate the original object', () => {
    const original = { a: 1, cost: 100 };
    const result = omitFields(original, ['cost']);
    expect(original).toEqual({ a: 1, cost: 100 });
    expect(result).toEqual({ a: 1 });
  });

  it('is a no-op when the key list is empty', () => {
    const original = { a: 1, b: 2 };
    expect(omitFields(original, [])).toEqual(original);
  });
});
