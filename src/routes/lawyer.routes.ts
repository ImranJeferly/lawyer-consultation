import express from 'express';
import multer from 'multer';
import {
  UserRole,
  VerificationStatus,
  VerificationDocumentType
} from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import prisma from '../config/database';
import documentUploadService from '../services/documentUpload.service';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const REQUIRED_DOCUMENT_TYPES: VerificationDocumentType[] = [
  VerificationDocumentType.BAR_LICENSE,
  VerificationDocumentType.STATE_ID
];

type VerificationDocumentRecord = {
  id: string;
  documentType: VerificationDocumentType;
  fileName: string;
  fileSize: number;
  uploadedAt: Date;
  verificationStatus: string;
  verifierNotes: string | null;
  verifiedAt: Date | null;
};

type LawyerProfileWithDocuments = {
  id: string;
  verificationStatus: VerificationStatus;
  verificationSubmittedAt: Date | null;
  verificationCompletedAt: Date | null;
  verificationNotes: string | null;
  verificationDocuments?: VerificationDocumentRecord[];
};

const toVerificationSummary = (profile?: LawyerProfileWithDocuments | null) => {
  if (!profile) {
    return null;
  }

  const documents: VerificationDocumentRecord[] = profile.verificationDocuments ?? [];
  const documentTypesPresent = new Set(documents.map((document) => document.documentType));
  const missingDocuments = REQUIRED_DOCUMENT_TYPES.filter((type) => !documentTypesPresent.has(type));
  const rejectedDocuments = documents.filter(
    (document) => document.verificationStatus?.toLowerCase() === 'rejected'
  );

  const canSubmit =
    missingDocuments.length === 0 &&
    profile.verificationStatus !== VerificationStatus.UNDER_REVIEW &&
    profile.verificationStatus !== VerificationStatus.VERIFIED;

  return {
    currentStatus: profile.verificationStatus,
    submittedAt: profile.verificationSubmittedAt,
    completedAt: profile.verificationCompletedAt,
    verificationNotes: profile.verificationNotes,
    requiredDocuments: REQUIRED_DOCUMENT_TYPES,
    missingDocuments,
    rejectedDocuments: rejectedDocuments.map((document) => document.documentType),
    canSubmit,
    documents: documents
      .slice()
      .sort(
        (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      )
      .map((document) => ({
        id: document.id,
        documentType: document.documentType,
        fileName: document.fileName,
        fileSize: document.fileSize,
        uploadedAt: document.uploadedAt,
        verificationStatus: document.verificationStatus,
        verifierNotes: document.verifierNotes,
        verifiedAt: document.verifiedAt
      }))
  };
};

async function fetchLawyerProfile(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      lawyerProfile: {
        include: { verificationDocuments: true }
      }
    }
  });
}

function ensureLawyerAccess(user: Awaited<ReturnType<typeof fetchLawyerProfile>>) {
  if (!user || user.role !== UserRole.LAWYER) {
    return false;
  }

  if (!user.lawyerProfile) {
    return false;
  }

  return true;
}

/**
 * GET /api/lawyers/profile
 * Get lawyer's own profile - SIMPLIFIED
 */
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const lawyer = await fetchLawyerProfile(userId);

    if (!ensureLawyerAccess(lawyer)) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const lawyerProfile = lawyer!.lawyerProfile;

    res.json({
      id: lawyer!.id,
      firstName: lawyer!.firstName,
      lastName: lawyer!.lastName,
      email: lawyer!.email,
      phone: lawyer!.phone,
      bio: lawyer!.bio,
      profileImageUrl: lawyer!.profileImageUrl,
      lawyerProfile,
      verification: toVerificationSummary(lawyerProfile)
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * POST /api/lawyers/verification/documents
 * Upload verification document
 */
router.post('/verification/documents', requireAuth, upload.single('document'), async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const lawyer = await fetchLawyerProfile(userId);

    if (!ensureLawyerAccess(lawyer)) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Document file is required' });
    }

    const documentTypeInput = (req.body.documentType ?? '').toString().toUpperCase();
    const documentType = documentTypeInput as VerificationDocumentType;

    if (!documentTypeInput || !Object.values(VerificationDocumentType).includes(documentType)) {
      return res.status(400).json({
        error: 'Invalid or missing document type',
        allowedTypes: Object.values(VerificationDocumentType)
      });
    }

    const profile = lawyer!.lawyerProfile!;

    if (profile.verificationStatus === VerificationStatus.UNDER_REVIEW) {
      return res.status(400).json({ error: 'Unable to upload documents while verification is under review' });
    }

    const uploadResult = await documentUploadService.uploadVerificationDocument(req.file.buffer, {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      lawyerId: profile.id,
      documentType,
      isRequired: REQUIRED_DOCUMENT_TYPES.includes(documentType)
    });

    if (!uploadResult.success) {
      return res.status(400).json({ error: uploadResult.error, virusScanResult: uploadResult.virusScanResult });
    }

    // Reset verification status if documents were requested again
    if (profile.verificationStatus === VerificationStatus.REJECTED) {
      await prisma.lawyerProfile.update({
        where: { id: profile.id },
        data: {
          verificationStatus: VerificationStatus.DOCUMENTS_REQUIRED,
          verificationNotes: null
        }
      });
    }

    const updatedProfile = await prisma.lawyerProfile.findUnique({
      where: { id: profile.id },
      include: { verificationDocuments: true }
    });

    res.status(201).json({
      message: 'Document uploaded successfully',
      documentId: uploadResult.documentId,
      verification: toVerificationSummary(updatedProfile)
    });
  } catch (error) {
    console.error('Upload verification document error:', error);
    res.status(500).json({ error: 'Failed to upload verification document' });
  }
});

/**
 * GET /api/lawyers/verification/documents
 * List verification documents
 */
router.get('/verification/documents', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const lawyer = await fetchLawyerProfile(userId);

    if (!ensureLawyerAccess(lawyer)) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const profile = lawyer!.lawyerProfile!;

    res.json({
      documents: (profile.verificationDocuments ?? []).map(document => ({
        id: document.id,
        documentType: document.documentType,
        fileName: document.fileName,
        fileSize: document.fileSize,
        uploadedAt: document.uploadedAt,
        verificationStatus: document.verificationStatus,
        verifierNotes: document.verifierNotes,
        verifiedAt: document.verifiedAt
      }))
    });
  } catch (error) {
    console.error('Get verification documents error:', error);
    res.status(500).json({ error: 'Failed to fetch verification documents' });
  }
});

/**
 * DELETE /api/lawyers/verification/documents/:documentId
 * Delete a verification document before submission
 */
router.delete('/verification/documents/:documentId', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { documentId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const lawyer = await fetchLawyerProfile(userId);

    if (!ensureLawyerAccess(lawyer)) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const profile = lawyer!.lawyerProfile!;

    if (profile.verificationStatus === VerificationStatus.UNDER_REVIEW) {
      return res.status(400).json({ error: 'Cannot delete documents while verification is under review' });
    }

    const document = await prisma.verificationDocument.findUnique({
      where: { id: documentId }
    });

    if (!document || document.lawyerId !== profile.id) {
      return res.status(404).json({ error: 'Verification document not found' });
    }

    await documentUploadService.deleteDocument(documentId, userId);

    const updatedProfile = await prisma.lawyerProfile.findUnique({
      where: { id: profile.id },
      include: { verificationDocuments: true }
    });

    res.json({
      message: 'Document deleted successfully',
      verification: toVerificationSummary(updatedProfile)
    });
  } catch (error) {
    console.error('Delete verification document error:', error);
    res.status(500).json({ error: 'Failed to delete verification document' });
  }
});

/**
 * POST /api/lawyers/verification/submit
 * Submit profile for verification - SIMPLIFIED
 */
router.post('/verification/submit', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const lawyer = await fetchLawyerProfile(userId);

    if (!ensureLawyerAccess(lawyer)) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const profile = lawyer!.lawyerProfile!;

    if (profile.verificationStatus === VerificationStatus.UNDER_REVIEW) {
      return res.status(400).json({ error: 'Verification already under review' });
    }

    if (profile.verificationStatus === VerificationStatus.VERIFIED) {
      return res.status(400).json({ error: 'Profile already verified' });
    }

    const documents = profile.verificationDocuments ?? [];
    const documentTypesPresent = new Set(documents.map(document => document.documentType));
    const missingDocuments = REQUIRED_DOCUMENT_TYPES.filter(type => !documentTypesPresent.has(type));

    if (missingDocuments.length > 0) {
      return res.status(400).json({
        error: 'Please upload all required documents before submitting',
        missingDocuments
      });
    }

    const rejectedDocuments = documents.filter(document => document.verificationStatus?.toLowerCase() === 'rejected');
    if (rejectedDocuments.length > 0) {
      return res.status(400).json({
        error: 'One or more documents require replacement',
        rejectedDocuments: rejectedDocuments.map(document => document.documentType)
      });
    }

    await prisma.verificationDocument.updateMany({
      where: { lawyerId: profile.id },
      data: { verificationStatus: 'pending' }
    });

    const updatedProfile = await prisma.lawyerProfile.update({
      where: { id: profile.id },
      data: {
        verificationStatus: VerificationStatus.UNDER_REVIEW,
        verificationSubmittedAt: new Date(),
        verificationCompletedAt: null,
        verificationNotes: null
      },
      include: {
        verificationDocuments: true
      }
    });

    res.json({
      message: 'Verification submitted successfully. Our team will review your documents shortly.',
      verification: toVerificationSummary(updatedProfile)
    });
  } catch (error) {
    console.error('Submit verification error:', error);
    res.status(500).json({ error: 'Failed to submit for verification' });
  }
});

/**
 * GET /api/lawyers/verification/status
 * Get verification status and progress - SIMPLIFIED
 */
router.get('/verification/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const lawyer = await fetchLawyerProfile(userId);

    if (!ensureLawyerAccess(lawyer)) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const profile = lawyer!.lawyerProfile!;

    res.json({
      currentStatus: profile.verificationStatus,
      canReceiveAppointments: profile.verificationStatus === VerificationStatus.VERIFIED,
      verification: toVerificationSummary(profile)
    });
  } catch (error) {
    console.error('Verification status error:', error);
    res.status(500).json({ error: 'Failed to get verification status' });
  }
});

export default router;