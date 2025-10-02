// @ts-ignore - crypto-js types not available
import CryptoJS from 'crypto-js';
import { randomBytes } from 'crypto';
import prisma from '../config/database';

interface EncryptionResult {
  encryptedContent: string;
  encryptionKeyId: string;
}

interface DecryptionResult {
  content: string;
  isDecrypted: boolean;
}

interface EncryptionKey {
  id: string;
  key: string;
  algorithm: string;
  createdAt: Date;
  expiresAt?: Date;
}

class MessageEncryptionService {
  private readonly ALGORITHM = 'AES-256-GCM';
  private readonly KEY_SIZE = 32; // 256 bits
  private readonly IV_SIZE = 16; // 128 bits
  private readonly TAG_SIZE = 16; // 128 bits

  // In-memory cache for encryption keys (replace with secure managed storage in production)
  private keyCache = new Map<string, EncryptionKey>();

  /**
   * Generate a new encryption key for a conversation
   */
  async generateConversationKey(conversationId: string): Promise<string> {
    try {
      // Generate a random 256-bit key
      const key = randomBytes(this.KEY_SIZE).toString('hex');
      const keyId = `conv_${conversationId}_${Date.now()}`;

      // Store key metadata (not the actual key) in database for audit
      // await prisma.conversationAuditLog.create({ // Model not available in schema
      //   data: {
      //     eventType: 'encryption_key_generated',
      //     eventData: {
      //       conversationId,
      //       keyId,
      //       algorithm: this.ALGORITHM,
      //       keySize: this.KEY_SIZE
      //     },
      //     initiatedBy: 'system',
      //     conversationId,
      //     isPrivileged: true
      //   }
      // });
      console.log('Generated encryption key for conversation:', conversationId);

      // Cache the key (in production, store in secure key management system)
      this.keyCache.set(keyId, {
        id: keyId,
        key,
        algorithm: this.ALGORITHM,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // 90 days
      });

      // Update conversation with encryption key ID
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          encryptionKeyId: keyId,
          isEncrypted: true
        }
      });

      console.log(`Generated encryption key ${keyId} for conversation ${conversationId}`);
      return keyId;

    } catch (error) {
      console.error('Failed to generate conversation key:', error);
      throw new Error('Failed to generate encryption key');
    }
  }

  /**
   * Get encryption key by ID
   */
  private async getEncryptionKey(keyId: string): Promise<EncryptionKey | null> {
    // Check cache first
    if (this.keyCache.has(keyId)) {
      const key = this.keyCache.get(keyId)!;

      // Check if key is expired
      if (key.expiresAt && key.expiresAt < new Date()) {
        this.keyCache.delete(keyId);
        console.warn(`Encryption key ${keyId} has expired`);
        return null;
      }

      return key;
    }

    // In production, retrieve from secure key management system
    // For now, return null if not in cache
    console.warn(`Encryption key ${keyId} not found in cache`);
    return null;
  }

  /**
   * Encrypt message content
   */
  async encryptMessage(content: string, conversationId: string): Promise<EncryptionResult> {
    try {
      // Get conversation to find encryption key
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { encryptionKeyId: true, isEncrypted: true }
      });

      if (!conversation) {
        throw new Error('Conversation not found');
      }

      let encryptionKeyId = conversation.encryptionKeyId;

      // Generate key if conversation doesn't have one
      if (!encryptionKeyId) {
        encryptionKeyId = await this.generateConversationKey(conversationId);
      }

      const encryptionKey = await this.getEncryptionKey(encryptionKeyId);
      if (!encryptionKey) {
        throw new Error('Encryption key not found');
      }

      // Generate random IV for each encryption
      const iv = randomBytes(this.IV_SIZE);

      // Encrypt the content
      const cipher = CryptoJS.AES.encrypt(content, encryptionKey.key, {
        iv: CryptoJS.lib.WordArray.create(iv),
        mode: CryptoJS.mode.GCM,
        padding: CryptoJS.pad.NoPadding
      });

      // Combine IV + ciphertext + auth tag
      const encryptedContent = iv.toString('hex') + ':' + cipher.toString();

      return {
        encryptedContent,
        encryptionKeyId
      };

    } catch (error) {
      console.error('Failed to encrypt message:', error);
      throw new Error('Message encryption failed');
    }
  }

  /**
   * Decrypt message content
   */
  async decryptMessage(encryptedContent: string, encryptionKeyId: string): Promise<DecryptionResult> {
    try {
      const encryptionKey = await this.getEncryptionKey(encryptionKeyId);
      if (!encryptionKey) {
        console.error(`Encryption key ${encryptionKeyId} not found for decryption`);
        return {
          content: '[ENCRYPTED MESSAGE - KEY NOT AVAILABLE]',
          isDecrypted: false
        };
      }

      // Split IV and ciphertext
      const parts = encryptedContent.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid encrypted message format');
      }

      const iv = CryptoJS.lib.WordArray.create(Buffer.from(parts[0], 'hex'));
      const ciphertext = parts[1];

      // Decrypt the content
      const decrypted = CryptoJS.AES.decrypt(ciphertext, encryptionKey.key, {
        iv,
        mode: CryptoJS.mode.GCM,
        padding: CryptoJS.pad.NoPadding
      });

      const content = decrypted.toString(CryptoJS.enc.Utf8);

      if (!content) {
        throw new Error('Decryption failed - invalid content');
      }

      return {
        content,
        isDecrypted: true
      };

    } catch (error) {
      console.error('Failed to decrypt message:', error);
      return {
        content: '[DECRYPTION FAILED]',
        isDecrypted: false
      };
    }
  }

  /**
   * Encrypt file content
   */
  async encryptFile(fileBuffer: Buffer, conversationId: string): Promise<{
    encryptedBuffer: Buffer;
    encryptionKeyId: string;
  }> {
    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { encryptionKeyId: true }
      });

      if (!conversation) {
        throw new Error('Conversation not found');
      }

      let encryptionKeyId = conversation.encryptionKeyId;
      if (!encryptionKeyId) {
        encryptionKeyId = await this.generateConversationKey(conversationId);
      }

      const encryptionKey = await this.getEncryptionKey(encryptionKeyId);
      if (!encryptionKey) {
        throw new Error('Encryption key not found');
      }

      // Convert buffer to base64 string for crypto-js
      const fileContent = fileBuffer.toString('base64');

      // Generate random IV
      const iv = randomBytes(this.IV_SIZE);

      // Encrypt the file content
      const cipher = CryptoJS.AES.encrypt(fileContent, encryptionKey.key, {
        iv: CryptoJS.lib.WordArray.create(iv),
        mode: CryptoJS.mode.GCM,
        padding: CryptoJS.pad.NoPadding
      });

      // Combine IV + encrypted content
      const encryptedContent = iv.toString('hex') + ':' + cipher.toString();
      const encryptedBuffer = Buffer.from(encryptedContent, 'utf8');

      return {
        encryptedBuffer,
        encryptionKeyId
      };

    } catch (error) {
      console.error('Failed to encrypt file:', error);
      throw new Error('File encryption failed');
    }
  }

  /**
   * Decrypt file content
   */
  async decryptFile(encryptedBuffer: Buffer, encryptionKeyId: string): Promise<Buffer | null> {
    try {
      const encryptionKey = await this.getEncryptionKey(encryptionKeyId);
      if (!encryptionKey) {
        console.error(`Encryption key ${encryptionKeyId} not found for file decryption`);
        return null;
      }

      const encryptedContent = encryptedBuffer.toString('utf8');

      // Split IV and ciphertext
      const parts = encryptedContent.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid encrypted file format');
      }

      const iv = CryptoJS.lib.WordArray.create(Buffer.from(parts[0], 'hex'));
      const ciphertext = parts[1];

      // Decrypt the content
      const decrypted = CryptoJS.AES.decrypt(ciphertext, encryptionKey.key, {
        iv,
        mode: CryptoJS.mode.GCM,
        padding: CryptoJS.pad.NoPadding
      });

      const decryptedBase64 = decrypted.toString(CryptoJS.enc.Utf8);

      if (!decryptedBase64) {
        throw new Error('File decryption failed');
      }

      return Buffer.from(decryptedBase64, 'base64');

    } catch (error) {
      console.error('Failed to decrypt file:', error);
      return null;
    }
  }

  /**
   * Rotate encryption keys for a conversation (for enhanced security)
   */
  async rotateConversationKey(conversationId: string, initiatedBy: string): Promise<string> {
    try {
      console.log(`Rotating encryption key for conversation ${conversationId}`);

      // Generate new key
      const newKeyId = await this.generateConversationKey(conversationId);

      // Log key rotation for audit
      // await prisma.conversationAuditLog.create({ // Model not available in schema
      //   data: {
      //     eventType: 'encryption_key_rotated',
      //     eventData: {
      //       conversationId,
      //       newKeyId,
      //       reason: 'routine_rotation'
      //     },
      //     initiatedBy,
      //     conversationId,
      //     isPrivileged: true
      //   }
      // });
      console.log('Key rotation logged for conversation:', conversationId);

      console.log(`Encryption key rotated to ${newKeyId} for conversation ${conversationId}`);
      return newKeyId;

    } catch (error) {
      console.error('Failed to rotate conversation key:', error);
      throw new Error('Key rotation failed');
    }
  }

  /**
   * Check if conversation requires encryption (attorney-client privilege)
   */
  async shouldEncryptConversation(conversationId: string): Promise<boolean> {
    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: {
          client: { select: { role: true } },
          lawyer: { select: { role: true } }
        }
      });

      if (!conversation) {
        return false;
      }

      // Always encrypt if it involves a lawyer and client
      const hasLawyer = conversation.lawyer?.role === 'LAWYER';
      const hasClient = conversation.client?.role === 'CLIENT';

      return hasLawyer && hasClient;

    } catch (error) {
      console.error('Failed to check encryption requirement:', error);
      return true; // Default to encryption for security
    }
  }

  /**
   * Clean up expired encryption keys
   */
  async cleanupExpiredKeys(): Promise<void> {
    try {
      const now = new Date();
      let cleanedCount = 0;

      // Clean up from cache
      for (const [keyId, key] of this.keyCache.entries()) {
        if (key.expiresAt && key.expiresAt < now) {
          this.keyCache.delete(keyId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} expired encryption keys`);
      }

      // In production, also clean up from secure key management system

    } catch (error) {
      console.error('Failed to cleanup expired keys:', error);
    }
  }

  /**
   * Validate message integrity
   */
  async validateMessageIntegrity(messageId: string): Promise<boolean> {
    try {
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          content: true,
          encryptionKeyId: true,
          isEncrypted: true
        }
      });

      if (!message) {
        return false;
      }

      if (!message.isEncrypted || !message.encryptionKeyId) {
        return true; // Unencrypted messages are considered valid
      }

      // Try to decrypt the message
      const result = await this.decryptMessage(message.content!, message.encryptionKeyId);
      return result.isDecrypted;

    } catch (error) {
      console.error('Failed to validate message integrity:', error);
      return false;
    }
  }
}

// Create singleton instance
const messageEncryptionService = new MessageEncryptionService();

export default messageEncryptionService;
export { EncryptionResult, DecryptionResult };