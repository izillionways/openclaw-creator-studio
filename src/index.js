import path from 'node:path';
import { manifest, normalizeConfig } from './config.js';
import { CreatorStudio } from './studio.js';
import { startPreview } from './preview.js';
import { tools } from './tools.js';

export default {
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  configSchema: { jsonSchema: manifest.configSchema, parse: normalizeConfig },
  register(api) {
    const mode = api.registrationMode ?? 'full';
    if (!['full', 'tool-discovery'].includes(mode)) return;
    const config = normalizeConfig(api.pluginConfig ?? {});
    let studio;
    let server;
    const getStudio = () => {
      if (!studio) {
        const stateDirectory = api.runtime.state.resolveStateDir(process.env);
        studio = new CreatorStudio(api, config,
          config.dataDir ?? path.join(stateDirectory, 'creator-studio'),
          config.assetRoots.length ? config.assetRoots : [path.join(stateDirectory, 'media')]);
      }
      return studio;
    };
    for (const definition of tools) {
      api.registerTool({
        contextVersion: 2,
        create(context) {
          if (!context.agentId || !config.allowedAgents.includes(context.agentId)) return null;
          return {
            name: definition.name,
            label: 'Creator Studio',
            description: definition.description,
            parameters: definition.parameters,
            async execute(_id, params, signal) {
              try {
                context.assertInvocationCurrent();
                signal?.throwIfAborted();
                const details = await definition.invoke(getStudio(), context, params, signal);
                context.assertInvocationCurrent();
                return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Creator Studio operation failed.';
                return { isError: true, content: [{ type: 'text', text: message }], details: { error: message } };
              }
            },
          };
        },
      }, { name: definition.name, optional: true, workspaceAccess: false });
    }
    if (mode !== 'full') return;
    api.registerCommand({
      name: 'creator',
      description: 'Review a specific article version: status, approve, reject, revise, or confirm manual publication.',
      acceptsArgs: true,
      requireAuth: true,
      handler(context) {
        try {
          const article = getStudio().command(context);
          const url = getStudio().previewUrl(article);
          return { text: [
            article.document.title, article.id + ' v' + article.version,
            article.version === article.currentVersion ? article.state : 'superseded', 'SHA-256: ' + article.hash,
            url ?? 'Private external preview is not configured.',
            'Approval never triggers platform publication.',
          ].join('\n') };
        } catch (error) {
          return { text: error instanceof Error ? error.message : 'Creator Studio command failed.' };
        }
      },
    });
    api.registerService({
      id: 'creator-studio',
      async start() {
        if (config.preview.enabled) {
          server = await startPreview(getStudio(), process.env[config.preview.passwordEnv]);
        }
      },
      async stop() {
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          server = undefined;
        }
        studio?.close();
      },
    });
  },
};
