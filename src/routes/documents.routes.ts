import express, { Request, Response } from 'express';
import Joi from 'joi';
import multer from 'multer';
import { AccessLevel, TemplateCategory } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';

// Import services
import documentService from '../services/document.service';
import folderService from '../services/folder.service';
import versionControlService from '../services/version-control.service';
import documentSharingService from '../services/document-sharing.service';
import documentSearchService from '../services/document-search.service';
import digitalSignatureService from '../services/digital-signature.service';
import documentTemplatesService from '../services/document-templates.service';
import collaborativeEditingService from '../services/collaborative-editing.service';
import legalComplianceService from '../services/legal-compliance.service';

const router = express.Router();

// Configure multer for document uploads
const upload = documentService.getMulterConfig();

// Validation schemas
const uploadDocumentSchema = Joi.object({
  folderId: Joi.string().optional(),
  category: Joi.string().valid('CONTRACT', 'LEGAL_BRIEF', 'COURT_FILING', 'EVIDENCE', 'CORRESPONDENCE', 'GENERAL').required(),
  securityLevel: Joi.string().valid('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGH', 'RESTRICTED').required(),
  description: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  isTemplate: Joi.boolean().optional()
});

const createFolderSchema = Joi.object({
  name: Joi.string().required().min(1).max(255),
  description: Joi.string().optional(),
  parentId: Joi.string().optional(),
  folderType: Joi.string().valid('GENERAL', 'CASE_FILES', 'CLIENT_DOCUMENTS', 'LEGAL_RESEARCH', 'CONTRACT', 'EVIDENCE', 'TEMPLATE').required(),
  securityLevel: Joi.string().valid('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGH', 'RESTRICTED').required(),
  tags: Joi.array().items(Joi.string()).optional()
});

const shareDocumentSchema = Joi.object({
  sharedWithUserId: Joi.string().optional(),
  sharedWithEmail: Joi.string().email().optional(),
  accessLevel: Joi.string().valid('VIEW', 'COMMENT', 'EDIT', 'READ').required(),
  message: Joi.string().optional(),
  expiresAt: Joi.date().optional(),
  allowDownload: Joi.boolean().optional(),
  allowPrint: Joi.boolean().optional(),
  allowCopy: Joi.boolean().optional()
}).or('sharedWithUserId', 'sharedWithEmail');

const searchDocumentsSchema = Joi.object({
  query: Joi.string().required().min(1),
  documentType: Joi.string().optional(),
  category: Joi.string().optional(),
  securityLevel: Joi.array().items(Joi.string()).optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  folderId: Joi.string().optional(),
  sortBy: Joi.string().valid('relevance', 'date', 'name', 'size').optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
  limit: Joi.number().min(1).max(100).optional(),
  offset: Joi.number().min(0).optional()
});

const addCommentSchema = Joi.object({
  content: Joi.string().required().min(1),
  parentId: Joi.string().optional(),
  position: Joi.object({
    page: Joi.number().required(),
    x: Joi.number().required(),
    y: Joi.number().required(),
    width: Joi.number().optional(),
    height: Joi.number().optional()
  }).optional(),
  selectedText: Joi.string().optional(),
  commentType: Joi.string().valid('general', 'annotation', 'suggestion', 'approval').required(),
  isPrivate: Joi.boolean().optional(),
  mentionedUsers: Joi.array().items(Joi.string()).optional()
});

// Document Management Routes

/**
 * POST /api/documents/upload
 * Upload new document
 */
router.post('/upload',
  requireAuth,
  upload.single('document'),
  validateRequest(uploadDocumentSchema, 'body'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      const result = await documentService.processDocument(req.file, {
        userId: req.auth!.userId,
        folderId: req.body.folderId,
        category: req.body.category,
        securityLevel: req.body.securityLevel,
        description: req.body.description,
        tags: req.body.tags,
        isTemplate: req.body.isTemplate
      });

      if (result.success) {
        res.json({
          success: true,
          data: result.document,
          processingDetails: result.processingDetails
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
          processingDetails: result.processingDetails
        });
      }

    } catch (error) {
      console.error('Document upload error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to upload document'
      });
    }
  }
);

/**
 * GET /api/documents/:documentId
 * Get document details
 */
router.get('/:documentId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const document = await documentService.getDocument(req.params.documentId, req.auth!.userId);

      if (!document) {
        return res.status(404).json({
          success: false,
          error: 'Document not found'
        });
      }

      res.json({
        success: true,
        data: document
      });

    } catch (error) {
      console.error('Get document error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get document'
      });
    }
  }
);

/**
 * DELETE /api/documents/:documentId
 * Delete document
 */
router.delete('/:documentId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const success = await documentService.deleteDocument(req.params.documentId, req.auth!.userId);

      if (success) {
        res.json({
          success: true,
          message: 'Document deleted successfully'
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Document not found or no permission to delete'
        });
      }

    } catch (error) {
      console.error('Delete document error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete document'
      });
    }
  }
);

// Folder Management Routes

/**
 * POST /api/documents/folders
 * Create new folder
 */
router.post('/folders',
  requireAuth,
  validateRequest(createFolderSchema),
  async (req: Request, res: Response) => {
    try {
      const folder = await folderService.createFolder({
        ...(typeof req.body === "object" ? req.body : {}),
        userId: req.auth!.userId
      });

      if (folder) {
        res.status(201).json({
          success: true,
          data: folder
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to create folder'
        });
      }

    } catch (error) {
      console.error('Create folder error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create folder'
      });
    }
  }
);

/**
 * GET /api/documents/folders
 * Get folder hierarchy
 */
router.get('/folders',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const parentId = req.query.parentId as string;
      const maxDepth = parseInt(req.query.maxDepth as string) || 5;

      const folders = await folderService.getFolderHierarchy(
        req.auth!.userId,
        parentId,
        maxDepth
      );

      res.json({
        success: true,
        data: folders
      });

    } catch (error) {
      console.error('Get folders error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get folders'
      });
    }
  }
);

/**
 * PUT /api/documents/folders/:folderId/move
 * Move folder
 */
router.put('/folders/:folderId/move',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const success = await folderService.moveFolder({
        folderId: req.params.folderId,
        newParentId: req.body.newParentId,
        userId: req.auth!.userId
      });

      if (success) {
        res.json({
          success: true,
          message: 'Folder moved successfully'
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to move folder'
        });
      }

    } catch (error) {
      console.error('Move folder error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to move folder'
      });
    }
  }
);

// Version Control Routes

/**
 * POST /api/documents/:documentId/versions
 * Create new version
 */
router.post('/:documentId/versions',
  requireAuth,
  upload.single('document'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      const version = await versionControlService.createVersion({
        documentId: req.params.documentId,
        userId: req.auth!.userId,
        file: req.file,
        changeNotes: req.body.changeNotes || '',
        isMinorChange: req.body.isMinorChange,
        extractedText: req.body.extractedText
      });

      if (version) {
        res.status(201).json({
          success: true,
          data: version
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to create version'
        });
      }

    } catch (error) {
      console.error('Create version error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create version'
      });
    }
  }
);

/**
 * GET /api/documents/:documentId/versions
 * Get version history
 */
router.get('/:documentId/versions',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await versionControlService.getVersionHistory(
        req.params.documentId,
        req.auth!.userId,
        limit,
        offset
      );

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error('Get version history error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get version history'
      });
    }
  }
);

/**
 * POST /api/documents/:documentId/versions/:createdAt/rollback
 * Rollback to version
 */
router.post('/:documentId/versions/:createdAt/rollback',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const success = await versionControlService.rollbackToVersion({
        documentId: req.params.documentId,
        targetVersionNumber: parseInt(req.params.createdAt),
        userId: req.auth!.userId,
        reason: req.body.reason || 'User requested rollback',
        createBackup: req.body.createBackup
      });

      if (success) {
        res.json({
          success: true,
          message: 'Document rolled back successfully'
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to rollback document'
        });
      }

    } catch (error) {
      console.error('Rollback version error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to rollback document'
      });
    }
  }
);

// Document Sharing Routes

/**
 * POST /api/documents/:documentId/share
 * Share document
 */
router.post('/:documentId/share',
  requireAuth,
  validateRequest(shareDocumentSchema),
  async (req: Request, res: Response) => {
    try {
      const share = await documentSharingService.shareDocument({
        documentId: req.params.documentId,
        ownerId: req.auth!.userId,
        ...req.body
      });

      if (share) {
        res.status(201).json({
          success: true,
          data: share
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to share document'
        });
      }

    } catch (error) {
      console.error('Share document error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to share document'
      });
    }
  }
);

/**
 * GET /api/documents/:documentId/shares
 * Get document shares
 */
router.get('/:documentId/shares',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const shares = await documentSharingService.getDocumentShares(
        req.params.documentId,
        req.auth!.userId
      );

      res.json({
        success: true,
        data: shares
      });

    } catch (error) {
      console.error('Get shares error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get shares'
      });
    }
  }
);

/**
 * POST /api/documents/:documentId/share-link
 * Create public share link
 */
router.post('/:documentId/share-link',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const requestedAccess = req.body.accessLevel as AccessLevel | undefined;
      const validAccessLevels = Object.values(AccessLevel) as AccessLevel[];
      const accessLevel = requestedAccess && validAccessLevels.includes(requestedAccess)
        ? requestedAccess
        : AccessLevel.READ;

      const result = await documentSharingService.createShareLink({
        documentId: req.params.documentId,
        ownerId: req.auth!.userId,
        accessLevel,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
        maxAccessCount: typeof req.body.maxAccessCount === 'number' ? req.body.maxAccessCount : undefined,
        requiresPassword: Boolean(req.body.requiresPassword),
        password: req.body.password,
        notifyOnAccess: req.body.notifyOnAccess
      });

      if (result) {
        res.json({
          success: true,
          data: result
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to create share link'
        });
      }

    } catch (error) {
      console.error('Create share link error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create share link'
      });
    }
  }
);

// Search Routes

/**
 * POST /api/documents/search
 * Search documents
 */
router.post('/search',
  requireAuth,
  validateRequest(searchDocumentsSchema),
  async (req: Request, res: Response) => {
    try {
      const results = await documentSearchService.searchDocuments({
        ...(typeof req.body === "object" ? req.body : {}),
        userId: req.auth!.userId
      });

      res.json({
        success: true,
        data: results
      });

    } catch (error) {
      console.error('Search documents error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to search documents'
      });
    }
  }
);

/**
 * GET /api/documents/:documentId/similar
 * Find similar documents
 */
router.get('/:documentId/similar',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const results = await documentSearchService.findSimilarDocuments(
        req.params.documentId,
        req.auth!.userId,
        limit
      );

      res.json({
        success: true,
        data: results
      });

    } catch (error) {
      console.error('Find similar documents error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to find similar documents'
      });
    }
  }
);

// Digital Signature Routes

/**
 * POST /api/documents/:documentId/signature-request
 * Create signature request
 */
router.post('/:documentId/signature-request',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const signatureRequest = await digitalSignatureService.createSignatureRequest({
        documentId: req.params.documentId,
        requestedBy: req.auth!.userId,
        ...req.body
      });

      if (signatureRequest) {
        res.status(201).json({
          success: true,
          data: signatureRequest
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to create signature request'
        });
      }

    } catch (error) {
      console.error('Create signature request error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create signature request'
      });
    }
  }
);

/**
 * POST /api/documents/signatures/:requestId/sign
 * Sign document
 */
router.post('/signatures/:requestId/sign',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const success = await digitalSignatureService.signDocument({
        signatureRequestId: req.params.requestId,
        signerId: req.auth!.userId,
        signatureData: {
          ...req.body.signatureData,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent') || ''
        },
        comments: req.body.comments
      });

      if (success) {
        res.json({
          success: true,
          message: 'Document signed successfully'
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to sign document'
        });
      }

    } catch (error) {
      console.error('Sign document error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to sign document'
      });
    }
  }
);

// Template Routes

/**
 * POST /api/documents/templates
 * Create document template
 */
router.post('/templates',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const template = await documentTemplatesService.createTemplate({
        ...(typeof req.body === "object" ? req.body : {}),
        createdBy: req.auth!.userId
      });

      if (template) {
        res.status(201).json({
          success: true,
          data: template
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to create template'
        });
      }

    } catch (error) {
      console.error('Create template error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create template'
      });
    }
  }
);

/**
 * GET /api/documents/templates
 * List templates
 */
router.get('/templates',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const listResult = await documentTemplatesService.listTemplates(
        req.auth!.userId,
        {
          category: req.query.category as TemplateCategory | undefined,
          practiceArea: req.query.practiceArea as string | undefined,
          isPublic: typeof req.query.isPublic === 'string' ? req.query.isPublic === 'true' : undefined,
          search: req.query.search as string | undefined
        },
        {
          limit: parseInt(req.query.limit as string, 10) || 20,
          offset: parseInt(req.query.offset as string, 10) || 0
        }
      );

      res.json({
        success: true,
        data: listResult
      });

    } catch (error) {
      console.error('List templates error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list templates'
      });
    }
  }
);

/**
 * POST /api/documents/templates/:templateId/generate
 * Generate document from template
 */
router.post('/templates/:templateId/generate',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const generatedDocument = await documentTemplatesService.generateDocument({
        templateId: req.params.templateId,
        userId: req.auth!.userId,
        folderId: req.body.folderId,
        fileName: req.body.fileName,
        variables: req.body.variables,
        format: req.body.format
      });

      if (generatedDocument) {
        res.status(201).json({
          success: true,
          data: generatedDocument
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to generate document'
        });
      }

    } catch (error) {
      console.error('Generate document error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate document'
      });
    }
  }
);

// Collaboration Routes

/**
 * POST /api/documents/:documentId/comments
 * Add comment
 */
router.post('/:documentId/comments',
  requireAuth,
  validateRequest(addCommentSchema),
  async (req: Request, res: Response) => {
    try {
      const comment = await collaborativeEditingService.addComment({
        documentId: req.params.documentId,
        userId: req.auth!.userId,
        ...req.body
      });

      if (comment) {
        res.status(201).json({
          success: true,
          data: comment
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to add comment'
        });
      }

    } catch (error) {
      console.error('Add comment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to add comment'
      });
    }
  }
);

/**
 * GET /api/documents/:documentId/comments
 * Get document comments
 */
router.get('/:documentId/comments',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const comments = await collaborativeEditingService.getDocumentComments(
        req.params.documentId,
        req.auth!.userId,
        {
          status: req.query.status as any,
          commentType: req.query.commentType as string,
          includePrivate: req.query.includePrivate === 'true'
        }
      );

      res.json({
        success: true,
        data: comments
      });

    } catch (error) {
      console.error('Get comments error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get comments'
      });
    }
  }
);

/**
 * GET /api/documents/:documentId/collaborators
 * Get active collaborators
 */
router.get('/:documentId/collaborators',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const collaborators = await collaborativeEditingService.getActiveCollaborators(
        req.params.documentId,
        req.auth!.userId
      );

      res.json({
        success: true,
        data: collaborators
      });

    } catch (error) {
      console.error('Get collaborators error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get collaborators'
      });
    }
  }
);

// Compliance Routes

/**
 * GET /api/documents/:documentId/compliance
 * Get compliance report
 */
router.get('/:documentId/compliance',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const report = await legalComplianceService.generateComplianceReport(
        req.params.documentId,
        req.auth!.userId
      );

      if (report) {
        res.json({
          success: true,
          data: report
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Document not found or no access'
        });
      }

    } catch (error) {
      console.error('Get compliance report error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get compliance report'
      });
    }
  }
);

/**
 * POST /api/documents/compliance/audit
 * Perform compliance audit
 */
router.post('/compliance/audit',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const result = await legalComplianceService.performComplianceAudit(
        req.body.scope || {},
        req.body.auditType || 'comprehensive',
        req.auth!.userId
      );

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error('Compliance audit error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to perform compliance audit'
      });
    }
  }
);

export default router;