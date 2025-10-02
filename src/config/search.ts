import { MeiliSearch, Index } from 'meilisearch';

export type DocumentSearchIndex = Index<Record<string, any>>;

let meilisearchClient: MeiliSearch | null = null;
let documentIndexPromise: Promise<DocumentSearchIndex | null> | null = null;

const getClient = (): MeiliSearch | null => {
  if (meilisearchClient) {
    return meilisearchClient;
  }

  const host = process.env.MEILISEARCH_HOST;

  if (!host) {
    return null;
  }

  try {
    meilisearchClient = new MeiliSearch({
      host,
      apiKey: process.env.MEILISEARCH_API_KEY,
    });
  } catch (error) {
    console.error('Failed to initialize Meilisearch client:', error);
    return null;
  }

  return meilisearchClient;
};

const configureDocumentIndex = async (index: DocumentSearchIndex): Promise<DocumentSearchIndex> => {
  await index.updateSettings({
    searchableAttributes: [
      'title',
      'description',
      'fileName',
      'searchableText',
      'tags',
    ],
    filterableAttributes: [
      'allowedUserIds',
      'ownerId',
      'documentType',
      'category',
      'securityLevel',
      'tags',
      'folderId',
      'practiceArea',
      'createdAt',
      'updatedAt',
    ],
    sortableAttributes: [
      'createdAt',
      'updatedAt',
      'fileSize',
      'title',
    ],
    displayedAttributes: [
      'id',
      'title',
      'description',
      'fileName',
      'documentType',
      'category',
      'securityLevel',
      'tags',
      'ownerId',
      'folderId',
      'practiceArea',
      'createdAt',
      'updatedAt',
      'allowedUserIds',
      'searchableText',
    ],
    pagination: {
      maxTotalHits: 1000,
    },
  });

  return index;
};

export const ensureDocumentSearchIndex = async (): Promise<DocumentSearchIndex | null> => {
  if (!documentIndexPromise) {
    documentIndexPromise = (async () => {
      const client = getClient();
      if (!client) {
        return null;
      }

      try {
        try {
          const existingIndex = await client.getIndex('documents');
          return configureDocumentIndex(existingIndex as unknown as DocumentSearchIndex);
        } catch (error: any) {
          if (error?.code !== 'index_not_found') {
            throw error;
          }

          const task = await client.createIndex('documents', { primaryKey: 'id' });
          await client.waitForTask(task.taskUid);

          const createdIndex = await client.getIndex('documents');
          return configureDocumentIndex(createdIndex as unknown as DocumentSearchIndex);
        }
      } catch (error) {
        console.error('Failed to create or configure Meilisearch index:', error);
        return null;
      }
    })();
  }

  return documentIndexPromise;
};

export const getDocumentSearchClient = (): MeiliSearch | null => getClient();
