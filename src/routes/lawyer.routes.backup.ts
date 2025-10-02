import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.middleware';
import prisma from '../config/database';
import verificationWorkflowService from '../services/verificationWorkflow.service';
import documentUploadService from '../services/documentUpload.service';
import { VerificationStatus, DocumentType, UserRole } from '@prisma/client';

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// Rate limiting
const standardLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per window
  message: 'Too many requests from this IP'
});

const uploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 uploads per hour
  message: 'Too many file uploads from this IP'
});

// Apply rate limiting to all lawyer routes
router.use(standardLimit);

/**
 * GET /api/lawyers/profile
 * Get lawyer's complete profile with verification status
 */
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        lawyerProfile: {
          include: {
            verificationDocuments: {
              orderBy: { uploadedAt: 'desc' }
            },
            availability: {
              orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
            },
            unavailability: {
              where: {
                endDate: { gte: new Date() }
              },
              orderBy: { startDate: 'asc' }
            }
          }
        },
        preferences: true,
        privacySettings: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    // Get verification progress and next steps
    const verificationProgress = verificationWorkflowService.getVerificationProgress(user.lawyerProfile);
    const nextSteps = verificationWorkflowService.getNextSteps(user.lawyerProfile);
    const statusInfo = verificationWorkflowService.getStatusDisplayInfo(
      user.lawyerProfile?.verificationStatus || VerificationStatus.PENDING
    );

    const response = {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        profileImageThumbnail: user.profileImageThumbnail,
        timezone: user.timezone,
        preferredLanguage: user.preferredLanguage,
        isVerified: user.isVerified,
        lastActiveAt: user.lastActiveAt
      },
      lawyerProfile: user.lawyerProfile,
      verificationStatus: {
        current: user.lawyerProfile?.verificationStatus || VerificationStatus.PENDING,
        ...statusInfo,
        progress: verificationProgress,
        nextSteps,
        canReceiveAppointments: verificationWorkflowService.canReceiveAppointments(
          user.lawyerProfile?.verificationStatus || VerificationStatus.PENDING
        )
      },
      preferences: user.preferences,
      privacySettings: user.privacySettings
    };

    res.json(response);
  } catch (error) {
    console.error('Get lawyer profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * PUT /api/lawyers/profile
 * Update lawyer profile information
 */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const {
      // Basic profile fields
      bio,
      timezone,
      preferredLanguage,
      // Lawyer-specific fields
      licenseNumber,
      practiceAreas,
      experience,
      hourlyRate,
      barAdmissionDate,
      barAdmissionState,
      professionalLiabilityInsurance,
      insuranceProvider,
      insurancePolicyNumber,
      educationBackground,
      professionalAchievements,
      specialCertifications,
      languagesSpoken,
      consultationTypes,
      minimumConsultationDuration,
      maximumConsultationDuration,
      advanceBookingDays,
      cancellationPolicy
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    // Update basic user fields
    const userUpdateData: any = {};
    if (bio !== undefined) userUpdateData.bio = bio;
    if (timezone !== undefined) userUpdateData.timezone = timezone;
    if (preferredLanguage !== undefined) userUpdateData.preferredLanguage = preferredLanguage;

    if (Object.keys(userUpdateData).length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: userUpdateData
      });
    }

    // Update lawyer profile fields
    const lawyerUpdateData: any = {};
    if (licenseNumber !== undefined) lawyerUpdateData.licenseNumber = licenseNumber;
    if (practiceAreas !== undefined) lawyerUpdateData.practiceAreas = practiceAreas;
    if (experience !== undefined) lawyerUpdateData.experience = experience;
    if (hourlyRate !== undefined) lawyerUpdateData.hourlyRate = hourlyRate;
    if (barAdmissionDate !== undefined) lawyerUpdateData.barAdmissionDate = new Date(barAdmissionDate);
    if (barAdmissionState !== undefined) lawyerUpdateData.barAdmissionState = barAdmissionState;
    if (professionalLiabilityInsurance !== undefined) lawyerUpdateData.professionalLiabilityInsurance = professionalLiabilityInsurance;
    if (insuranceProvider !== undefined) lawyerUpdateData.insuranceProvider = insuranceProvider;
    if (insurancePolicyNumber !== undefined) lawyerUpdateData.insurancePolicyNumber = insurancePolicyNumber;
    if (educationBackground !== undefined) lawyerUpdateData.educationBackground = educationBackground;
    if (professionalAchievements !== undefined) lawyerUpdateData.professionalAchievements = professionalAchievements;
    if (specialCertifications !== undefined) lawyerUpdateData.specialCertifications = specialCertifications;
    if (languagesSpoken !== undefined) lawyerUpdateData.languagesSpoken = languagesSpoken;
    if (consultationTypes !== undefined) lawyerUpdateData.consultationTypes = consultationTypes;
    if (minimumConsultationDuration !== undefined) lawyerUpdateData.minimumConsultationDuration = minimumConsultationDuration;
    if (maximumConsultationDuration !== undefined) lawyerUpdateData.maximumConsultationDuration = maximumConsultationDuration;
    if (advanceBookingDays !== undefined) lawyerUpdateData.advanceBookingDays = advanceBookingDays;
    if (cancellationPolicy !== undefined) lawyerUpdateData.cancellationPolicy = cancellationPolicy;

    let updatedProfile;
    if (user.lawyerProfile) {
      // Update existing profile
      if (Object.keys(lawyerUpdateData).length > 0) {
        updatedProfile = await prisma.lawyerProfile.update({
          where: { id: user.lawyerProfile.id },
          data: lawyerUpdateData,
          include: {
            verificationDocuments: true,
            availability: true,
            unavailability: true
          }
        });
      } else {
        updatedProfile = user.lawyerProfile;
      }
    } else {
      // Create new lawyer profile
      updatedProfile = await prisma.lawyerProfile.create({
        data: {
          userId: userId,
          ...lawyerUpdateData
        },
        include: {
          verificationDocuments: true,
          availability: true,
          unavailability: true
        }
      });
    }

    res.json({
      message: 'Profile updated successfully',
      lawyerProfile: updatedProfile
    });
  } catch (error) {
    console.error('Update lawyer profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * POST /api/lawyers/verification/upload
 * Upload verification document
 */
router.post('/verification/upload', requireAuth, uploadLimit, upload.single('document'), async (req, res) => {
  try {
    const userId = req.user?.id;
    const { documentType, expirationDate } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (!documentType || !Object.values(DocumentType).includes(documentType)) {
      return res.status(400).json({ error: 'Invalid document type' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    if (!user.lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found. Please complete your profile first.' });
    }

    // Check if document type already exists and delete old one
    const existingDoc = await prisma.verificationDocument.findFirst({
      where: {
        lawyerId: user.lawyerProfile.id,
        documentType: documentType
      }
    });

    if (existingDoc) {
      await documentUploadService.deleteDocument(existingDoc.id, userId || '');
    }

    // Upload new document
    const uploadResult = await documentUploadService.uploadVerificationDocument(
      file.buffer,
      {
        originalName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        lawyerId: user.lawyerProfile.id,
        documentType: documentType,
        expirationDate: expirationDate ? new Date(expirationDate) : undefined,
        isRequired: ['BAR_LICENSE', 'STATE_ID'].includes(documentType)
      }
    );

    if (!uploadResult.success) {
      return res.status(400).json({ error: uploadResult.error });
    }

    res.json({
      message: 'Document uploaded successfully',
      document: {
        id: uploadResult.documentId,
        storageUrl: uploadResult.storageUrl,
        documentType,
        uploadedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Document upload error:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

/**
 * GET /api/lawyers/verification/documents
 * Get lawyer's verification documents
 */
router.get('/verification/documents', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        lawyerProfile: {
          include: {
            verificationDocuments: {
              orderBy: { uploadedAt: 'desc' }
            }
          }
        }
      }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const documents = user.lawyerProfile?.verificationDocuments || [];

    // Add upload requirements for each document type
    const documentsWithRequirements = Object.values(DocumentType).map(docType => {
      const existingDoc = documents.find((doc: any) => doc.documentType === docType);
      const requirements = documentUploadService.getUploadRequirements(docType as any); // Cast to handle type mismatch

      return {
        documentType: docType,
        uploaded: !!existingDoc,
        document: existingDoc || null,
        requirements
      };
    });

    res.json({
      documents: documentsWithRequirements,
      totalUploaded: documents.length,
      requiredDocuments: documentsWithRequirements.filter(doc => doc.requirements.required),
      verificationStatus: user.lawyerProfile?.verificationStatus || VerificationStatus.PENDING
    });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: 'Failed to get documents' });
  }
});

/**
 * DELETE /api/lawyers/verification/documents/:documentId
 * Delete verification document
 */
router.delete('/verification/documents/:documentId', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { documentId } = req.params;

    const deleteResult = await documentUploadService.deleteDocument(documentId, userId || '');

    if (!deleteResult.success) {
      return res.status(400).json({ error: deleteResult.error });
    }

    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

/**
 * POST /api/lawyers/verification/submit
 * Submit profile for verification
 */
router.post('/verification/submit', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const lawyerProfile = await prisma.lawyerProfile.findUnique({
      where: { userId: userId }
    });

    if (!lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    // Simplified verification: just set to verified if pending
    const currentStatus = lawyerProfile.verificationStatus;
    let targetStatus: VerificationStatus;

    if (currentStatus === VerificationStatus.PENDING) {
      targetStatus = VerificationStatus.VERIFIED;
    } else {
      return res.status(400).json({
        error: `Cannot submit from current status: ${currentStatus}`
      });
    }

    const transitionResult = await verificationWorkflowService.transitionStatus(
      lawyerProfile.id,
      targetStatus,
      '', // No admin ID for self-submission
      'Profile submitted for verification by lawyer'
    );

    if (!transitionResult.success) {
      return res.status(400).json({
        error: transitionResult.message,
        requiredActions: transitionResult.requiredActions
      });
    }

    res.json({
      message: 'Profile submitted for verification successfully',
      newStatus: transitionResult.newStatus,
      nextSteps: verificationWorkflowService.getNextSteps(lawyerProfile)
    });
  } catch (error) {
    console.error('Submit verification error:', error);
    res.status(500).json({ error: 'Failed to submit for verification' });
  }
});

/**
 * GET /api/lawyers/verification/status
 * Get verification status and progress
 */
router.get('/verification/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        lawyerProfile: {
          include: {
            verificationDocuments: true
          }
        }
      }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    if (!user.lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    const progress = verificationWorkflowService.getVerificationProgress(user.lawyerProfile);
    const nextSteps = verificationWorkflowService.getNextSteps(user.lawyerProfile);
    const statusInfo = verificationWorkflowService.getStatusDisplayInfo(user.lawyerProfile.verificationStatus);
    const availableTransitions = verificationWorkflowService.getAvailableTransitions(user.lawyerProfile.verificationStatus);

    res.json({
      currentStatus: user.lawyerProfile.verificationStatus,
      statusInfo,
      progress,
      nextSteps,
      availableTransitions: availableTransitions.map(t => t.to),
      canReceiveAppointments: verificationWorkflowService.canReceiveAppointments(user.lawyerProfile.verificationStatus),
      verificationNotes: user.lawyerProfile.verificationNotes,
      createdAt: user.lawyerProfile.verificationSubmittedAt,
      completedAt: user.lawyerProfile.verificationCompletedAt
    });
  } catch (error) {
    console.error('Get verification status error:', error);
    res.status(500).json({ error: 'Failed to get verification status' });
  }
});

// TEMPORARILY COMMENTED OUT - AVAILABILITY ROUTES
/*
router.get('/availability', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        lawyerProfile: {
          include: {
            availability: {
              orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
            },
            unavailability: {
              where: {
                endDate: { gte: new Date() }
              },
              orderBy: { startDate: 'asc' }
            }
          }
        }
      }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    if (!user.lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    res.json({
      availability: user.lawyerProfile.availability,
      unavailability: user.lawyerProfile.unavailability,
      timezone: user.lawyerProfile.timezone,
      minimumConsultationDuration: user.lawyerProfile.minimumConsultationDuration,
      maximumConsultationDuration: user.lawyerProfile.maximumConsultationDuration,
      advanceBookingDays: user.lawyerProfile.advanceBookingDays
    });
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json({ error: 'Failed to get availability' });
  }
});

/**
 * PUT /api/lawyers/availability
 * Update lawyer's regular availability schedule
 */
router.put('/availability', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { availability, timezone, minimumConsultationDuration, maximumConsultationDuration, advanceBookingDays } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    if (!user.lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    // Validate availability data
    if (availability && !Array.isArray(availability)) {
      return res.status(400).json({ error: 'Availability must be an array' });
    }

    if (availability) {
      for (const slot of availability) {
        if (!slot.dayOfWeek || slot.dayOfWeek < 0 || slot.dayOfWeek > 6) {
          return res.status(400).json({ error: 'Invalid day of week (0-6 required)' });
        }
        if (!slot.startTime || !slot.endTime) {
          return res.status(400).json({ error: 'Start time and end time are required' });
        }
        // Validate time format (HH:MM)
        if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(slot.startTime) ||
            !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(slot.endTime)) {
          return res.status(400).json({ error: 'Invalid time format. Use HH:MM' });
        }
      }
    }

    // Update lawyer profile settings
    const profileUpdateData: any = {};
    if (timezone) profileUpdateData.timezone = timezone;
    if (minimumConsultationDuration) profileUpdateData.minimumConsultationDuration = minimumConsultationDuration;
    if (maximumConsultationDuration) profileUpdateData.maximumConsultationDuration = maximumConsultationDuration;
    if (advanceBookingDays) profileUpdateData.advanceBookingDays = advanceBookingDays;

    if (Object.keys(profileUpdateData).length > 0) {
      await prisma.lawyerProfile.update({
        where: { id: user.lawyerProfile.id },
        data: profileUpdateData
      });
    }

    // Update availability schedule
    if (availability) {
      // Delete existing availability
      await prisma.lawyerAvailability.deleteMany({
        where: { lawyerId: user.lawyerProfile.id }
      });

      // Create new availability entries
      if (availability.length > 0) {
        await prisma.lawyerAvailability.createMany({
          data: availability.map((slot: any) => ({
            lawyerId: user.lawyerProfile!.id,
            dayOfWeek: slot.dayOfWeek,
            startTime: slot.startTime,
            endTime: slot.endTime,
            isAvailable: slot.isAvailable !== false,
            effectiveFrom: slot.effectiveFrom ? new Date(slot.effectiveFrom) : null,
            effectiveUntil: slot.effectiveUntil ? new Date(slot.effectiveUntil) : null
          }))
        });
      }
    }

    // Get updated availability
    const updatedAvailability = await prisma.lawyerAvailability.findMany({
      where: { lawyerId: user.lawyerProfile.id },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
    });

    res.json({
      message: 'Availability updated successfully',
      availability: updatedAvailability
    });
  } catch (error) {
    console.error('Update availability error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

/**
 * POST /api/lawyers/unavailability
 * Add unavailability period (vacation, court, etc.)
 */
router.post('/unavailability', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { startDate, endDate, startTime, endTime, reason, description, isRecurring, recurrencePattern } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    if (!user.lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (start >= end) {
      return res.status(400).json({ error: 'End date must be after start date' });
    }

    if (start < new Date()) {
      return res.status(400).json({ error: 'Cannot set unavailability in the past' });
    }

    // Create unavailability period
    const unavailability = await prisma.lawyerUnavailability.create({
      data: {
        lawyerId: user.lawyerProfile.id,
        startDate: start,
        endDate: end,
        startTime: startTime || null,
        endTime: endTime || null,
        reason: reason || null,
        description: description || null,
        isRecurring: isRecurring || false,
        recurrencePattern: recurrencePattern || null
      }
    });

    res.json({
      message: 'Unavailability period added successfully',
      unavailability
    });
  } catch (error) {
    console.error('Add unavailability error:', error);
    res.status(500).json({ error: 'Failed to add unavailability period' });
  }
});

/**
 * PUT /api/lawyers/unavailability/:unavailabilityId
 * Update unavailability period
 */
router.put('/unavailability/:unavailabilityId', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { unavailabilityId } = req.params;
    const { startDate, endDate, startTime, endTime, reason, description } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    // Check if unavailability belongs to this lawyer
    const existingUnavailability = await prisma.lawyerUnavailability.findFirst({
      where: {
        id: unavailabilityId,
        lawyerId: user.lawyerProfile?.id
      }
    });

    if (!existingUnavailability) {
      return res.status(404).json({ error: 'Unavailability period not found' });
    }

    // Build update data
    const updateData: any = {};
    if (startDate) updateData.startDate = new Date(startDate);
    if (endDate) updateData.endDate = new Date(endDate);
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (reason !== undefined) updateData.reason = reason;
    if (description !== undefined) updateData.description = description;

    // Validate dates if both are provided
    if (updateData.startDate && updateData.endDate && updateData.startDate >= updateData.endDate) {
      return res.status(400).json({ error: 'End date must be after start date' });
    }

    const updatedUnavailability = await prisma.lawyerUnavailability.update({
      where: { id: unavailabilityId },
      data: updateData
    });

    res.json({
      message: 'Unavailability period updated successfully',
      unavailability: updatedUnavailability
    });
  } catch (error) {
    console.error('Update unavailability error:', error);
    res.status(500).json({ error: 'Failed to update unavailability period' });
  }
});

/**
 * DELETE /api/lawyers/unavailability/:unavailabilityId
 * Delete unavailability period
 */
router.delete('/unavailability/:unavailabilityId', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { unavailabilityId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    // Check if unavailability belongs to this lawyer
    const existingUnavailability = await prisma.lawyerUnavailability.findFirst({
      where: {
        id: unavailabilityId,
        lawyerId: user.lawyerProfile?.id
      }
    });

    if (!existingUnavailability) {
      return res.status(404).json({ error: 'Unavailability period not found' });
    }

    await prisma.lawyerUnavailability.delete({
      where: { id: unavailabilityId }
    });

    res.json({ message: 'Unavailability period deleted successfully' });
  } catch (error) {
    console.error('Delete unavailability error:', error);
    res.status(500).json({ error: 'Failed to delete unavailability period' });
  }
});

/*
// GET /api/lawyers/availability/slots
// Get available time slots for booking
router.get('/availability/slots', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { date, duration = '30' } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        lawyerProfile: {
          include: {
            availability: true,
            unavailability: {
              where: {
                startDate: { lte: new Date(date as string) },
                endDate: { gte: new Date(date as string) }
              }
            },
            appointments: {
              where: {
                startTime: {
                  gte: new Date(date as string),
                  lt: new Date(new Date(date as string).getTime() + 24 * 60 * 60 * 1000)
                },
                status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] }
              }
            }
          }
        }
      }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    if (!user.lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    const requestedDate = new Date(date as string);
    const dayOfWeek = requestedDate.getDay();
    const durationMinutes = parseInt(duration as string) || 30;

    // Get availability for this day of week
    const dayAvailability = user.lawyerProfile.availability.filter(
      (slot: any) => slot.dayOfWeek === dayOfWeek && slot.isAvailable
    );

    if (dayAvailability.length === 0) {
      return res.json({ slots: [], message: 'No availability on this day' });
    }

    // Check for unavailability periods
    const isUnavailable = user.lawyerProfile.unavailability.length > 0;

    if (isUnavailable) {
      return res.json({ slots: [], message: 'Unavailable on this date' });
    }

    // Generate time slots
    const slots: string[] = [];

    for (const availability of dayAvailability) {
      const startTime = availability.startTime;
      const endTime = availability.endTime;

      // Convert time strings to minutes
      const startMinutes = timeToMinutes(startTime);
      const endMinutes = timeToMinutes(endTime);

      // Generate slots within this availability window
      for (let currentMinutes = startMinutes; currentMinutes + durationMinutes <= endMinutes; currentMinutes += durationMinutes) {
        const slotTime = minutesToTime(currentMinutes);
        const slotDateTime = new Date(requestedDate);
        const [hours, minutes] = slotTime.split(':').map(Number);
        slotDateTime.setHours(hours, minutes, 0, 0);

        // Check if slot conflicts with existing appointments
        const hasConflict = user.lawyerProfile.appointments.some((appointment: any) => {
          const appointmentStart = appointment.startTime;
          const appointmentEnd = appointment.endTime;
          const slotEnd = new Date(slotDateTime.getTime() + durationMinutes * 60 * 1000);

          return (slotDateTime < appointmentEnd && slotEnd > appointmentStart);
        });

        if (!hasConflict) {
          slots.push(slotTime);
        }
      }
    }

    res.json({
      date: date,
      dayOfWeek,
      duration: durationMinutes,
      slots: slots.sort(),
      timezone: user.lawyerProfile.timezone
    });
  } catch (error) {
    console.error('Get available slots error:', error);
    res.status(500).json({ error: 'Failed to get available slots' });
  }
});

// Helper functions for time conversion
function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}
*/
// END COMMENTED OUT AVAILABILITY ROUTES

export default router;