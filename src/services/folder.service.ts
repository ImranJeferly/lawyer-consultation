import { DocumentFolder, DocumentFolderType, SecurityLevel, DocumentStatus, Prisma } from '@prisma/client';
import prisma from '../config/database';

interface CreateFolderOptions {
  name: string;
  description?: string;
  parentId?: string;
  folderType: DocumentFolderType;
  securityLevel: SecurityLevel;
  userId: string;
}

interface FolderHierarchy {
  id: string;
  name: string;
  path: string;
  depth: number;
  folderType: DocumentFolderType;
  securityLevel: SecurityLevel;
  documentCount: number;
  subfolderCount: number;
  children: FolderHierarchy[];
  canEdit: boolean;
  canDelete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface MoveFolderOptions {
  folderId: string;
  newParentId?: string;
  userId: string;
}

class FolderService {

  /**
   * Create new folder with proper hierarchy management
   */
  async createFolder(options: CreateFolderOptions): Promise<DocumentFolder | null> {
    try {
      let parentFolder: DocumentFolder | null = null;

      if (options.parentId) {
        parentFolder = await prisma.documentFolder.findFirst({
          where: {
            id: options.parentId,
            ownerId: options.userId,
            isActive: true,
            isArchived: false
          }
        });

        if (!parentFolder) {
          throw new Error('Parent folder not found or inaccessible');
        }

        if (parentFolder.depth >= 10) {
          throw new Error('Maximum folder depth exceeded');
        }

        if (this.getSecurityLevelValue(options.securityLevel) < this.getSecurityLevelValue(parentFolder.securityLevel)) {
          throw new Error('Folder security level cannot be lower than parent folder');
        }
      }

      const path = parentFolder ? `${parentFolder.path}/${options.name}` : options.name;
      const depth = parentFolder ? parentFolder.depth + 1 : 0;

      const existingFolder = await prisma.documentFolder.findFirst({
        where: {
          name: options.name,
          parentId: parentFolder ? parentFolder.id : null,
          ownerId: options.userId,
          isActive: true,
          isArchived: false
        }
      });

      if (existingFolder) {
        throw new Error('Folder with this name already exists in the same location');
      }

      const folder = await prisma.documentFolder.create({
        data: {
          name: options.name,
          description: options.description,
          parentId: options.parentId ?? null,
          path,
          depth,
          ownerId: options.userId,
          createdBy: options.userId,
          folderType: options.folderType,
          securityLevel: options.securityLevel
        }
      });

      return folder;

    } catch (error) {
      console.error('Failed to create folder:', error);
      return null;
    }
  }

  /**
   * Get folder hierarchy for a user
   */
  async getFolderHierarchy(
    userId: string,
    parentId?: string,
    maxDepth: number = 5
  ): Promise<FolderHierarchy[]> {
    const folders = await prisma.documentFolder.findMany({
      where: {
        parentId: parentId ?? null,
        ownerId: userId,
        isActive: true,
        isArchived: false
      },
      include: {
        _count: {
          select: {
            documents: {
              where: {
                status: { not: DocumentStatus.DELETED }
              }
            },
            children: true
          }
        }
      },
      orderBy: [
        { folderType: 'asc' },
        { name: 'asc' }
      ]
    });

    const hierarchy: FolderHierarchy[] = [];

    for (const folder of folders) {
      const children =
        folder.depth < maxDepth
          ? await this.getFolderHierarchy(userId, folder.id, maxDepth)
          : [];

      hierarchy.push({
        id: folder.id,
        name: folder.name,
        path: folder.path,
        depth: folder.depth,
        folderType: folder.folderType,
        securityLevel: folder.securityLevel,
        documentCount: folder._count.documents,
        subfolderCount: folder._count.children,
        children,
        canEdit: true,
        canDelete: true,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt
      });
    }

    return hierarchy;
  }

  /**
   * Move folder to new parent with validation
   */
  async moveFolder(options: MoveFolderOptions): Promise<boolean> {
    try {
      // Get the folder to move
      const folder = await prisma.documentFolder.findFirst({
        where: {
          id: options.folderId,
          ownerId: options.userId,
          isActive: true,
          isArchived: false
        }
      });

      if (!folder) {
        throw new Error('Folder not found or no access');
      }

      let newParentFolder: DocumentFolder | null = null;
      let newPath = folder.name;
      let newDepth = 0;

      // Validate new parent if specified
      if (options.newParentId) {
        // Check if trying to move folder into itself or its children
        if (options.newParentId === options.folderId) {
          throw new Error('Cannot move folder into itself');
        }

        newParentFolder = await prisma.documentFolder.findFirst({
          where: {
            id: options.newParentId,
            ownerId: options.userId,
            isActive: true,
            isArchived: false
          }
        });

        if (!newParentFolder) {
          throw new Error('Target parent folder not found');
        }

        // Check if target is a child of the folder being moved
        if (await this.isChildFolder(options.newParentId, options.folderId)) {
          throw new Error('Cannot move folder into its own child folder');
        }

        // Check depth limit
        if (newParentFolder.depth >= 9) { // Leave room for the folder being moved
          throw new Error('Maximum folder depth would be exceeded');
        }

        newPath = `${newParentFolder.path}/${folder.name}`;
        newDepth = newParentFolder.depth + 1;

        // Security level validation
        if (this.getSecurityLevelValue(folder.securityLevel) < this.getSecurityLevelValue(newParentFolder.securityLevel)) {
          throw new Error('Cannot move folder to location with higher security requirement');
        }
      }

      // Check for name conflicts in new location
      const existingFolder = await prisma.documentFolder.findFirst({
        where: {
          name: folder.name,
          parentId: options.newParentId || null,
          ownerId: options.userId,
          isActive: true,
          isArchived: false,
          id: { not: options.folderId }
        }
      });

      if (existingFolder) {
        throw new Error('Folder with this name already exists in the target location');
      }

      // Perform the move operation
      await prisma.$transaction(async (tx) => {
        // Update the folder
        await tx.documentFolder.update({
          where: { id: options.folderId },
          data: {
            parentId: options.newParentId,
            path: newPath,
            depth: newDepth,
            updatedAt: new Date()
          }
        });

        if (folder.parentId) {
          await tx.documentFolder.update({
            where: { id: folder.parentId },
            data: { updatedAt: new Date() }
          });
        }

        if (options.newParentId) {
          await tx.documentFolder.update({
            where: { id: options.newParentId },
            data: { updatedAt: new Date() }
          });
        }

        // Update paths of all child folders recursively
        await this.updateChildFolderPaths(tx, options.folderId, newPath, newDepth);
      });

      return true;

    } catch (error) {
      console.error('Failed to move folder:', error);
      return false;
    }
  }

  private getSecurityLevelValue(level: SecurityLevel): number {
    switch (level) {
      case SecurityLevel.PUBLIC:
        return 1;
      case SecurityLevel.STANDARD:
        return 2;
      case SecurityLevel.CONFIDENTIAL:
        return 3;
      case SecurityLevel.RESTRICTED:
        return 4;
      case SecurityLevel.TOP_SECRET:
        return 5;
      default:
        return 1;
    }
  }

  private async isChildFolder(potentialChildId: string, parentId: string): Promise<boolean> {
    if (potentialChildId === parentId) {
      return true;
    }

    const folder = await prisma.documentFolder.findUnique({
      where: { id: potentialChildId },
      select: { parentId: true }
    });

    if (!folder?.parentId) {
      return false;
    }

    if (folder.parentId === parentId) {
      return true;
    }

    return this.isChildFolder(folder.parentId, parentId);
  }

  private async updateChildFolderPaths(
    tx: Prisma.TransactionClient,
    folderId: string,
    newBasePath: string,
    baseDepth: number
  ): Promise<void> {
    const childFolders = await tx.documentFolder.findMany({
      where: {
        parentId: folderId,
        isActive: true,
        isArchived: false
      },
      select: { id: true, name: true }
    });

    for (const child of childFolders) {
      const childPath = `${newBasePath}/${child.name}`;
      const childDepth = baseDepth + 1;

      await tx.documentFolder.update({
        where: { id: child.id },
        data: {
          path: childPath,
          depth: childDepth,
          updatedAt: new Date()
        }
      });

      await this.updateChildFolderPaths(tx, child.id, childPath, childDepth);
    }
  }
}

export default new FolderService();
export { FolderService, CreateFolderOptions, FolderHierarchy, MoveFolderOptions };