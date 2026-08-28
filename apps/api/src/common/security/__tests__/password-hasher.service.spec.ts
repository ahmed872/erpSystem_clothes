import { PasswordHasherService } from '../password-hasher.service';

describe('PasswordHasherService', () => {
  const hasher = new PasswordHasherService();

  it('verifies a password against its own hash', async () => {
    const hash = await hasher.hash('Sup3rSecret!');
    await expect(hasher.verify(hash, 'Sup3rSecret!')).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hasher.hash('Sup3rSecret!');
    await expect(hasher.verify(hash, 'WrongPassword1')).resolves.toBe(false);
  });

  it('never stores the plaintext password in the hash', async () => {
    const hash = await hasher.hash('Sup3rSecret!');
    expect(hash).not.toContain('Sup3rSecret!');
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const h1 = await hasher.hash('Sup3rSecret!');
    const h2 = await hasher.hash('Sup3rSecret!');
    expect(h1).not.toBe(h2);
  });

  it('gracefully returns false (not throw) for a malformed hash', async () => {
    await expect(hasher.verify('not-a-real-argon2-hash', 'anything')).resolves.toBe(false);
  });
});
