import bcrypt from 'bcryptjs';

/** @returns {Promise<string>} hash bcrypt */
export async function hashPassword(plain, cost) {
  return bcrypt.hash(plain, cost);
}

/** @returns {Promise<boolean>} */
export async function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compare(plain, hash);
}
