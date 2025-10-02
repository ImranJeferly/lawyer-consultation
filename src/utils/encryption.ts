import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // For GCM, 96-bit IV is recommended
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

interface EncryptedData {
  encrypted: string;
  iv: string;
  salt: string;
  tag: string;
}

/**
 * Derives a key from a password and salt using PBKDF2
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 10000, KEY_LENGTH, 'sha256');
}

/**
 * Encrypts data using AES-256-GCM
 */
export async function encryptData(data: string, password: string): Promise<string> {
  try {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(password, salt);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    const result: EncryptedData = {
      encrypted,
      iv: iv.toString('hex'),
      salt: salt.toString('hex'),
      tag: tag.toString('hex'),
    };
    
    return JSON.stringify(result);
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypts data encrypted with encryptData
 */
export async function decryptData(encryptedData: string, password: string): Promise<string> {
  try {
    const data: EncryptedData = JSON.parse(encryptedData);
    
    const salt = Buffer.from(data.salt, 'hex');
    const iv = Buffer.from(data.iv, 'hex');
    const tag = Buffer.from(data.tag, 'hex');
    const key = deriveKey(password, salt);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Generates a secure random string
 */
export function generateSecureRandom(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hashes a string using SHA-256
 */
export function hashString(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compares a plaintext string with its hash
 */
export function compareHash(plaintext: string, hash: string): boolean {
  const plaintextHash = hashString(plaintext);
  return crypto.timingSafeEqual(Buffer.from(plaintextHash), Buffer.from(hash));
}

/**
 * Generates a cryptographically secure random code
 */
export function generateRandomCode(length: number, charset: string = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'): string {
  let result = '';
  const bytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  
  return result;
}

export default {
  encryptData,
  decryptData,
  generateSecureRandom,
  hashString,
  compareHash,
  generateRandomCode,
};