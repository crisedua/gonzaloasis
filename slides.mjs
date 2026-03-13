/**
 * slides.mjs — Google Slides API helpers
 *
 * Creates presentations from structured slide data and moves them
 * to the configured Drive folder ("AI Assistant" by default).
 *
 * Exports:
 *   createPresentation(title, slides)  → { id, url }
 */

import { google } from 'googleapis';
import { getAuthClient } from './google-auth.mjs';

// ─── Internal helpers ──────────────────────────────────────────────────────────

function getSlides(auth) {
  return google.slides({ version: 'v1', auth });
}

function getDrive(auth) {
  return google.drive({ version: 'v3', auth });
}

const DRIVE_FOLDER_NAME = process.env.DRIVE_FOLDER || 'AI Assistant';

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

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a Google Slides presentation with the given title and slides.
 *
 * @param {string} title - Presentation title
 * @param {Array<{ title: string, bullets: string[] }>} slides - Slide content
 *   First element is the cover slide (title only, bullets can be empty).
 * @returns {{ id: string, url: string }}
 */
export async function createPresentation(title, slides) {
  const auth     = await getAuthClient();
  const slidesApi = getSlides(auth);
  const drive    = getDrive(auth);

  // 1. Create blank presentation
  const { data: pres } = await slidesApi.presentations.create({
    requestBody: { title },
  });
  const presentationId = pres.presentationId;

  // The new presentation has one blank slide by default — we'll use it for the cover
  const defaultSlideId = pres.slides[0].objectId;

  // 2. Build batch update requests
  const requests = [];

  // --- Cover slide: insert title text into the default slide's title placeholder ---
  const coverTitleShape = findPlaceholder(pres.slides[0], 'CENTERED_TITLE') ||
                          findPlaceholder(pres.slides[0], 'TITLE');
  if (coverTitleShape && slides.length > 0) {
    requests.push({
      insertText: {
        objectId: coverTitleShape.objectId,
        text: slides[0].title,
        insertionIndex: 0,
      },
    });

    // If cover has subtitle placeholder and there are bullets, add them
    const coverSubtitle = findPlaceholder(pres.slides[0], 'SUBTITLE');
    if (coverSubtitle && slides[0].bullets && slides[0].bullets.length > 0) {
      requests.push({
        insertText: {
          objectId: coverSubtitle.objectId,
          text: slides[0].bullets.join('\n'),
          insertionIndex: 0,
        },
      });
    }
  }

  // --- Content slides (skip the first which is the cover) ---
  for (let i = 1; i < slides.length; i++) {
    const slide = slides[i];
    const slideId = `slide_${i}`;

    // Create new slide with TITLE_AND_BODY layout
    requests.push({
      createSlide: {
        objectId: slideId,
        insertionIndex: i,
        slideLayoutReference: {
          predefinedLayout: 'TITLE_AND_BODY',
        },
        placeholderIdMappings: [
          {
            layoutPlaceholder: { type: 'TITLE', index: 0 },
            objectId: `${slideId}_title`,
          },
          {
            layoutPlaceholder: { type: 'BODY', index: 0 },
            objectId: `${slideId}_body`,
          },
        ],
      },
    });

    // Insert title text
    requests.push({
      insertText: {
        objectId: `${slideId}_title`,
        text: slide.title,
        insertionIndex: 0,
      },
    });

    // Insert bullet points as body text
    if (slide.bullets && slide.bullets.length > 0) {
      requests.push({
        insertText: {
          objectId: `${slideId}_body`,
          text: slide.bullets.join('\n'),
          insertionIndex: 0,
        },
      });
    }
  }

  // 3. Execute batch update
  if (requests.length > 0) {
    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    });
  }

  // 4. Move to AI Assistant folder
  const folderId = await findOrCreateFolder(auth);
  await drive.files.update({
    fileId: presentationId,
    addParents: folderId,
    fields: 'id',
  });

  return {
    id: presentationId,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
  };
}

// ─── Helper ────────────────────────────────────────────────────────────────────

/**
 * Find a placeholder shape in a slide by type.
 */
function findPlaceholder(slide, type) {
  if (!slide || !slide.pageElements) return null;
  for (const el of slide.pageElements) {
    if (el.shape?.placeholder?.type === type) {
      return el;
    }
  }
  return null;
}
