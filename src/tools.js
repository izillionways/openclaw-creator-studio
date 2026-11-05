const string = { type: 'string' };
const strings = { type: 'array', items: string };
const versionFields = {
  articleId: { type: 'string', pattern: '^cs-[a-f0-9]{20}$' },
  version: { type: 'integer', minimum: 1 },
};

export const documentSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'language', 'blocks', 'sources', 'claims'],
  properties: {
    title: { type: 'string', maxLength: 200 },
    summary: { type: 'string', maxLength: 1000 },
    language: string, platform: string,
    blocks: {
      type: 'array', minItems: 1, maxItems: 150,
      items: {
        type: 'object', additionalProperties: false, required: ['type'],
        properties: {
          type: { type: 'string', enum: ['heading', 'paragraph', 'list', 'code', 'image'] },
          text: string, items: strings, assetId: string,
        },
      },
    },
    sources: {
      type: 'array', minItems: 1, maxItems: 40,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'url', 'title', 'checkedAt', 'kind', 'excerpt'],
        properties: {
          id: string, url: string, title: string, checkedAt: string,
          kind: { type: 'string', enum: ['primary', 'secondary'] }, excerpt: string,
        },
      },
    },
    claims: {
      type: 'array', minItems: 1, maxItems: 60,
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'sourceIds'],
        properties: { text: string, sourceIds: strings },
      },
    },
    assets: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'path', 'alt', 'kind'],
        properties: {
          id: string, path: string, alt: string,
          kind: { type: 'string', enum: ['screenshot', 'illustration'] },
          role: { type: 'string', enum: ['cover', 'body'] },
          sourceId: string, capturedAt: string,
        },
      },
    },
  },
};

const versionParameters = {
  type: 'object', additionalProperties: false,
  required: ['articleId', 'version'], properties: versionFields,
};

export const tools = [
  {
    name: 'creator_article',
    description: 'Create, revise, read or list evidence-backed articles. Revisions invalidate approval. Import images only from configured assetRoots. No tool can grant human approval.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'revise', 'get', 'list'] },
        ...versionFields, topicKey: string, runKey: string, document: documentSchema,
      },
    },
    invoke: (studio, context, params) => studio.article(context, params),
  },
  {
    name: 'creator_review',
    description: 'Run deterministic checks and an independent, isolated editorial review of an exact version. Requires operator opt-in and an explicit supported runtime. Calls count toward provider usage.',
    parameters: versionParameters,
    invoke: (studio, context, params, signal) => studio.review(context, params, signal),
  },
  {
    name: 'creator_submit',
    description: 'Get the private preview URL for a reviewed current version and, only when configured, notify the fixed destination. Never publish. Uncertain sends are not automatically retried.',
    parameters: versionParameters,
    invoke: (studio, context, params, signal) => studio.submit(context, params, signal),
  },
  {
    name: 'creator_export',
    description: 'Export the human-approved current version as HTML, Markdown, evidence metadata and local images for manual publication.',
    parameters: versionParameters,
    invoke: (studio, context, params) => studio.export(context, params),
  },
];
