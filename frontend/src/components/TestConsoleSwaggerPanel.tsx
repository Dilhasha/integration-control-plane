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

import { useEffect, useMemo, useRef, type JSX } from 'react';
import { Alert, Box } from '@wso2/oxygen-ui';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';
import { swaggerMethodColorSx } from '../constants/methodBadgeStyles';
import { getAccessToken } from '../auth/tokenManager';

// Hides SwaggerUI's own info/server/scheme/authorize chrome — the Test Console renders its own
// invoke URL and header inputs above the operation list, so this keeps just the "try it out"
// forms and avoids showing a redundant (and non-editable, since we override it below) server
// picker.
const HideTopPlugin = () => ({
  components: {
    InfoContainer: () => null,
    Info: () => null,
    Servers: () => null,
    ServersContainer: () => null,
    SchemesContainer: () => null,
    // Per-operation server/scheme picker shown inside each expanded operation block — same
    // reasoning as SchemesContainer above, just the per-operation copy of it.
    OperationServers: () => null,
    AuthorizeBtn: () => null,
    AuthorizeBtnContainer: () => null,
  },
});

const panelSx = {
  bgcolor: 'background.paper',
  '& .swagger-ui .wrapper': { padding: 0, maxWidth: 'none' },
  '& .swagger-ui .topbar': { display: 'none' },
  // Belt-and-suspenders for the global and per-operation scheme pickers: the HideTopPlugin
  // component overrides above null out their content, but swagger-ui's own hardcoded
  // `.scheme-container { background: #fff }` wrapper div can still render around them (and
  // shows as a stray white box in dark mode) — hide the wrapper itself too.
  '& .swagger-ui .scheme-container, & .swagger-ui .opblock-schemes': { display: 'none' },
  ...swaggerMethodColorSx,
};

export interface TestConsoleSwaggerPanelProps {
  spec: object;
  invokeUrl: string;
  headerName: string;
  headerValue: string;
}

// The swagger-ui-react-heavy half of the Test Console — split into its own file so pages/TestConsole.tsx
// can lazy-load it, keeping swagger-ui-react (~1.3MB gzipped) out of the main bundle (matching the
// EntryPoints.tsx / OpenApiDefinitionsDrawer.tsx pattern already used for the read-only API docs viewer).
export default function TestConsoleSwaggerPanel({ spec, invokeUrl, headerName, headerValue }: TestConsoleSwaggerPanelProps): JSX.Element {
  // Override the packed spec's servers with the actual invoke URL so "Try it out" executes
  // against the real runtime instead of whatever (if anything) ballerina-to-openapi inferred.
  const specWithServer = useMemo(() => {
    if (!invokeUrl) return spec;
    return { ...(spec as Record<string, unknown>), servers: [{ url: invokeUrl }] };
  }, [spec, invokeUrl]);

  // requestInterceptor is read by swagger-ui-react's internal (non-React) core, which doesn't
  // reliably pick up a freshly-closed-over function on every render — read the latest
  // header name/value through a ref instead to avoid sending stale values.
  const headerRef = useRef({ name: headerName, value: headerValue });
  useEffect(() => {
    headerRef.current = { name: headerName, value: headerValue };
  }, [headerName, headerValue]);

  if (!invokeUrl) {
    return (
      <Alert severity="warning" sx={{ m: 2 }}>
        Could not determine an invoke URL for this service (no running runtime instance or listener port reported yet) — requests sent from "Try it out" won't have anywhere to land.
      </Alert>
    );
  }

  return (
    <Box sx={panelSx}>
      <SwaggerUI
        spec={specWithServer}
        plugins={[HideTopPlugin]}
        docExpansion="list"
        requestInterceptor={(request) => {
          // Authenticates the request to icp_server's Try-It proxy itself (validated by its
          // own @http:ServiceConfig JWT auth) — distinct from the target service's own auth
          // header below, which travels as an envelope so the two can't collide even when the
          // target's header also happens to be named "Authorization".
          const token = getAccessToken();
          if (token) {
            request.headers['Authorization'] = `Bearer ${token}`;
          }
          const { name, value } = headerRef.current;
          if (name.trim() && value) {
            request.headers['X-Tryit-Header-Name'] = name.trim();
            request.headers['X-Tryit-Header-Value'] = value;
          }
          return request;
        }}
      />
    </Box>
  );
}
