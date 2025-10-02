import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

interface ImageUploadResult {
  original: string;
  medium: string;
  thumbnail: string;
}

interface ImageSizes {
  original: { width?: number; height?: number };
  medium: { width: number; height: number };
  thumbnail: { width: number; height: number };
}

class S3Service {
  private s3Client: S3Client;
  private bucketName: string;
  private region: string;

  constructor() {
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.bucketName = process.env.AWS_S3_BUCKET || 'lawyer-consultation-files';

    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  /**
   * Upload profile image with multiple sizes
   */
  async uploadProfileImage(imageBuffer: Buffer, userId: string, originalName: string): Promise<ImageUploadResult> {
    const fileExtension = originalName.split('.').pop()?.toLowerCase() || 'jpg';
    const baseFileName = `profile-images/${userId}/${uuidv4()}`;

    const sizes: ImageSizes = {
      original: {}, // Keep original size but optimize
      medium: { width: 300, height: 300 },
      thumbnail: { width: 150, height: 150 }
    };

    const uploadPromises = Object.entries(sizes).map(async ([sizeType, dimensions]) => {
      let processedBuffer: Buffer;
      let fileName: string;

      if (sizeType === 'original') {
        // Optimize original image without resizing
        processedBuffer = await sharp(imageBuffer)
          .jpeg({ quality: 85, progressive: true })
          .png({ compressionLevel: 6 })
          .webp({ quality: 85 })
          .toBuffer();
        fileName = `${baseFileName}-original.${fileExtension}`;
      } else {
        // Resize and optimize
        processedBuffer = await sharp(imageBuffer)
          .resize(dimensions.width, dimensions.height, {
            fit: 'cover',
            position: 'center'
          })
          .jpeg({ quality: 80, progressive: true })
          .png({ compressionLevel: 6 })
          .webp({ quality: 80 })
          .toBuffer();
        fileName = `${baseFileName}-${sizeType}.${fileExtension}`;
      }

      const uploadParams = {
        Bucket: this.bucketName,
        Key: fileName,
        Body: processedBuffer,
        ContentType: `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`,
        CacheControl: 'max-age=31536000', // 1 year cache
        Metadata: {
          userId,
          sizeType,
          uploadedAt: new Date().toISOString()
        }
      };

      await this.s3Client.send(new PutObjectCommand(uploadParams));
      return {
        sizeType,
        url: `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${fileName}`
      };
    });

    const results = await Promise.all(uploadPromises);

    return {
      original: results.find(r => r.sizeType === 'original')?.url || '',
      medium: results.find(r => r.sizeType === 'medium')?.url || '',
      thumbnail: results.find(r => r.sizeType === 'thumbnail')?.url || ''
    };
  }

  /**
   * Delete profile images
   */
  async deleteProfileImages(imageUrls: string[]): Promise<void> {
    const deletePromises = imageUrls.map(url => {
      if (!url) return Promise.resolve();

      const key = url.split(`${this.bucketName}.s3.${this.region}.amazonaws.com/`)[1];
      if (!key) return Promise.resolve();

      const deleteParams = {
        Bucket: this.bucketName,
        Key: key
      };

      return this.s3Client.send(new DeleteObjectCommand(deleteParams));
    });

    await Promise.all(deletePromises);
  }

  /**
   * Generate presigned URL for direct upload (alternative method)
   */
  async generatePresignedUrl(fileName: string, contentType: string): Promise<string> {
    const key = `profile-images/temp/${uuidv4()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
      CacheControl: 'max-age=31536000',
    });

    return await getSignedUrl(this.s3Client, command, { expiresIn: 3600 }); // 1 hour
  }

  /**
   * Validate image file
   */
  async validateImage(buffer: Buffer): Promise<{ isValid: boolean; error?: string; metadata?: any }> {
    try {
      const metadata = await sharp(buffer).metadata();

      // Check file type
      if (!['jpeg', 'jpg', 'png', 'webp'].includes(metadata.format || '')) {
        return { isValid: false, error: 'Invalid image format. Only JPEG, PNG, and WebP are allowed.' };
      }

      // Check dimensions
      if (!metadata.width || !metadata.height) {
        return { isValid: false, error: 'Unable to read image dimensions.' };
      }

      if (metadata.width < 50 || metadata.height < 50) {
        return { isValid: false, error: 'Image must be at least 50x50 pixels.' };
      }

      if (metadata.width > 5000 || metadata.height > 5000) {
        return { isValid: false, error: 'Image dimensions cannot exceed 5000x5000 pixels.' };
      }

      return { isValid: true, metadata };
    } catch (error) {
      return { isValid: false, error: 'Invalid or corrupted image file.' };
    }
  }
}

export default new S3Service();