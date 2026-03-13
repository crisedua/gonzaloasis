/**
 * drive.mjs — Google Drive API helpers
 *
 * All functions auto-obtain an authenticated client via google-auth.mjs.
 *
 * Exports:
 *   listRecent(maxResults)              → array of file summaries
 *   searchFiles(query, maxResults)      → array of file summaries
 *   readFile(fileId)                    → { name, mimeType, content }
 *   createDoc(title, content)           → file id
 *   updateDoc(fileId, content)          → void
 *   getDriveContext(maxResults)         → formatted string for Claude context
 */

import { google } from 'googleapis';
import { getAuthClient } from './google-auth.mjs';

// ─── Internal helpers ──────────────────────────────────────────────────────────

function getDrive(auth) {
  return google.drive({ version: 'v3', auth });
}

function getDocs(auth) {
  return google.docs({ version: 'v1', auth });
}

const DRIVE_FOLDER_NAME = process.env.DRIVE_FOLDER || 'AI Assistant';

/** Finds an existing folder by name or creates one. Returns folder ID. */
async function findOrCreateFolder(auth) {
  const drive = getDrive(auth);
  const q = `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  if (data.files && data.files.length > 0) return data.files[0].id;

  const { data: folder } = await drive.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  return folder.id;
}

const READABLE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the most recently modified files from Drive.
 * Excludes folders and binary files.
 */
export async function listRecent(maxResults = 10) {
  const auth  = await getAuthClient();
  const drive = getDrive(auth);

  const { data } = await drive.files.list({
    pageSize: maxResults,
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
  });

  return data.files ?? [];
}

/**
 * Searches Drive by file name or full-text query.
 * @param {string} query  Search string (Drive query syntax supported)
 */
export async function searchFiles(query, maxResults = 10) {
  const auth  = await getAuthClient();
  const drive = getDrive(auth);

  // Build a query that searches name and full text
  const driveQuery = `(name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}') and trashed = false`;

  const { data } = await drive.files.list({
    pageSize: maxResults,
    q: driveQuery,
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });

  return data.files ?? [];
}

/**
 * Reads file content. Supports Google Docs (exports as plain text) and
 * plain text files. Returns truncated content capped at 8000 chars.
 */
export async function readFile(fileId) {
  const auth  = await getAuthClient();
  const drive = getDrive(auth);

  // Get file metadata first
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType',
  });

  let content = '';

  if (meta.mimeType === 'application/vnd.google-apps.document') {
    // Export Google Doc as plain text
    const { data } = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    });
    content = typeof data === 'string' ? data : JSON.stringify(data);
  } else if (READABLE_MIME_TYPES.has(meta.mimeType)) {
    // Download directly
    const { data } = await drive.files.get({ fileId, alt: 'media' });
    content = typeof data === 'string' ? data : JSON.stringify(data);
  } else {
    content = `[Binary file — cannot display content for ${meta.mimeType}]`;
  }

  return {
    id:       meta.id,
    name:     meta.name,
    mimeType: meta.mimeType,
    content:  content.slice(0, 8000),
  };
}

/**
 * Creates a new Google Doc with the given title and plain-text content.
 * Returns the new file's id.
 */
export async function createDoc(title, content) {
  const auth = await getAuthClient();
  const drive = getDrive(auth);
  const docs = getDocs(auth);
  const folderId = await findOrCreateFolder(auth);

  // Create empty doc inside the folder
  const { data: doc } = await docs.documents.create({
    requestBody: { title },
  });

  const docId = doc.documentId;

  // Move into the target folder
  await drive.files.update({
    fileId: docId,
    addParents: folderId,
    fields: 'id',
  });

  // Insert content
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: content,
          },
        },
      ],
    },
  });

  return docId;
}

/**
 * Replaces all content in an existing Google Doc with new plain-text content.
 * Only works on Google Docs (not arbitrary Drive files).
 */
export async function updateDoc(fileId, content) {
  const auth = await getAuthClient();
  const docs = getDocs(auth);

  // Get current end index so we can clear the document
  const { data: doc } = await docs.documents.get({ documentId: fileId });
  const endIndex = doc.body?.content?.at(-1)?.endIndex ?? 2;

  const requests = [];

  // Delete all existing content (leave index 1 untouched — it's the newline sentinel)
  if (endIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 },
      },
    });
  }

  // Insert new content
  requests.push({
    insertText: {
      location: { index: 1 },
      text: content,
    },
  });

  await docs.documents.batchUpdate({
    documentId: fileId,
    requestBody: { requests },
  });
}

/**
 * Returns a formatted string of recent Drive files for Claude context.
 */
export async function getDriveContext(maxResults = 5) {
  const files = await listRecent(maxResults);
  if (files.length === 0) return '*Google Drive — no recent files*';

  const lines = [`*Google Drive — ${files.length} recent files*`, ''];
  for (const f of files) {
    const modified = f.modifiedTime ? f.modifiedTime.slice(0, 10) : '';
    lines.push(`• *${f.name}* (${f.mimeType.split('.').pop()}) — ${modified}`);
    if (f.webViewLink) lines.push(`  ${f.webViewLink}`);
  }

  return lines.join('\n');
}
