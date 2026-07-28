/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useMemo, useState, type JSX } from 'react';
import { Alert, Box, CircularProgress, Dialog, IconButton, Stack, Tab, Tabs, Typography } from '@wso2/oxygen-ui';
import { X } from '@wso2/oxygen-ui-icons-react';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';
import { useOpenApiDefinitionsByRuntime, type GqlOpenApiDefinition } from '../api/queries';
import { HTTP_METHOD_BADGE_COLORS, DEFAULT_METHOD_BADGE_COLOR, METHOD_BADGE_TEXT_SX, RESOURCE_LABEL_TEXT_SX } from '../constants/methodBadgeStyles';

function SwaggerSpecView({ definition }: { definition: GqlOpenApiDefinition }): JSX.Element {
  const parsed = useMemo(() => {
    try {
      return { spec: JSON.parse(definition.definition) as object, error: null };
    } catch {
      return { spec: null, error: 'Could not parse this OpenAPI definition as JSON.' };
    }
  }, [definition.definition]);

  if (parsed.error || !parsed.spec) {
    return (
      <Alert severity="warning" sx={{ m: 2 }}>
        {parsed.error}
      </Alert>
    );
  }

  return <SwaggerUI spec={parsed.spec} docExpansion="list" />;
}

// Mirrors the swagger-pack compiler plugin's uniqueFileName() (icp-runtime-bridge): each packed
// file is named `<module>_<normalizedBasePath>_openapi.json` (or just `<normalizedBasePath>_...`
// for the default module), where normalizedBasePath strips leading slashes and collapses
// `/{}` into `_`. There's no explicit foreign key from a Service artifact to its packed file, so
// matching by this same normalization is the best available correlation.
function normalizeBasePath(basePath: string): string {
  const stripped = basePath.replace(/^\/+/, '').replace(/[/{}]+/g, '_');
  return stripped || 'root';
}

function matchesServiceBasePath(fileName: string, basePath: string): boolean {
  const normalized = normalizeBasePath(basePath);
  const withoutSuffix = fileName.replace(/_openapi\.json$/, '');
  return withoutSuffix === normalized || withoutSuffix.endsWith(`_${normalized}`);
}

const dialogSx = {
  '& .MuiDialog-paper': {
    width: '90vw',
    maxWidth: 1100,
    minWidth: 600,
    height: '85vh',
    maxHeight: 900,
    m: 2,
  },
};

const headerSx = {
  px: 2,
  py: 1.5,
  borderBottom: '1px solid',
  borderColor: 'divider',
};

// Swagger UI's own per-method classes (opblock-get, opblock-post, ...) — recolor and reformat
// them to match ArtifactTabs' ResourceRow (getMethodBadgeSx / RESOURCE_LABEL_SX), so a service's
// resources look the same whether viewed in the Artifacts tab or in this OpenAPI viewer.
const ALL_HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'];
const swaggerMethodColorSx = Object.fromEntries(
  ALL_HTTP_METHODS.map((method) => {
    const color = HTTP_METHOD_BADGE_COLORS[method.toUpperCase()] ?? DEFAULT_METHOD_BADGE_COLOR;
    return [
      `& .swagger-ui .opblock.opblock-${method}`,
      {
        borderColor: color,
        background: `${color}1a`,
        '& .opblock-summary': { borderColor: color },
        '& .opblock-summary-method': { ...METHOD_BADGE_TEXT_SX, background: color },
        '& .opblock-summary-path, & .opblock-summary-path__deprecated': { ...RESOURCE_LABEL_TEXT_SX, fontFamily: 'inherit', color: 'text.primary' },
      },
    ];
  }),
);

// Scope the (otherwise globally-styled) Swagger UI CSS to this container and keep it from
// fighting the surrounding oxygen-ui chrome (dialog background, font, max-width centering).
const swaggerContainerSx = {
  flex: 1,
  overflow: 'auto',
  bgcolor: 'background.paper',
  '& .swagger-ui .wrapper': { padding: '0 16px 0 32px', maxWidth: 'none' },
  '& .swagger-ui .info': { margin: '16px 0' },
  ...swaggerMethodColorSx,
};

interface OpenApiDefinitionsDrawerProps {
  runtimeId: string;
  onClose: () => void;
  /** When set, only show the packed definition(s) matching this service's base path. */
  serviceBasePath?: string;
}

export function OpenApiDefinitionsDrawer({ runtimeId, onClose, serviceBasePath }: OpenApiDefinitionsDrawerProps): JSX.Element {
  const { data: allDefinitions = [], isLoading, error } = useOpenApiDefinitionsByRuntime(runtimeId);
  const definitions = useMemo(() => (serviceBasePath ? allDefinitions.filter((d) => matchesServiceBasePath(d.fileName, serviceBasePath)) : allDefinitions), [allDefinitions, serviceBasePath]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = definitions[Math.min(selectedIndex, definitions.length - 1)];

  return (
    <Dialog open onClose={onClose} maxWidth={false} sx={dialogSx}>
      <Stack sx={{ height: '100%' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={headerSx}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            API Docs - {runtimeId}
          </Typography>
          <IconButton size="small" aria-label="close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </Stack>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error" sx={{ m: 2 }}>
            Failed to load OpenAPI definitions for this runtime.
          </Alert>
        ) : definitions.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
            {allDefinitions.length === 0 ? 'No OpenAPI definitions packed for this runtime.' : 'No OpenAPI definition packed for this service.'}
          </Typography>
        ) : (
          <>
            {definitions.length > 1 && (
              <Tabs value={Math.min(selectedIndex, definitions.length - 1)} onChange={(_, v) => setSelectedIndex(v)} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
                {definitions.map((d) => (
                  <Tab key={d.fileName} label={d.fileName} sx={{ textTransform: 'none' }} />
                ))}
              </Tabs>
            )}
            <Box sx={swaggerContainerSx}>{selected && <SwaggerSpecView definition={selected} />}</Box>
          </>
        )}
      </Stack>
    </Dialog>
  );
}
