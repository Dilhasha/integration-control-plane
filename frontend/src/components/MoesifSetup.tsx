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
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Accordion, AccordionDetails, AccordionSummary, Typography } from '@wso2/oxygen-ui';
import { ChevronDown } from '@wso2/oxygen-ui-icons-react';
import type { JSX } from 'react';

// Pieces shared by the two Moesif setup views — the metrics landing/config view
// (MetricsMoesif) and the logs setup view (RuntimeLogs). Both introduce Moesif
// with the same wording, link the same guides and lay their instructions out as
// the same accordion, so the copy and the step component live here to keep the
// two flows from drifting apart.

// Short description shown when introducing Moesif. The leading "Moesif" is
// rendered in bold at the call site.
export const MOESIF_DESCRIPTION = ' (a WSO2 company) allows you to observe your service integrations with real-time monitoring, behavioral analytics, and AI-powered insights into API adoption and usage.';

// Documentation guide for setting up Moesif-backed observability, referenced
// from the Moesif intro.
export const MOESIF_SETUP_GUIDE = 'https://wso2.com/integration-platform/docs/manage/icp/observability-setup';

// Documentation guides for setting up OpenSearch-backed observability, offered
// as an alternative. The guide differs by runtime technology: MI (Micro
// Integrator) has its own docs, while other runtimes (BI) use the general ICP
// observability setup guide.
export const OPENSEARCH_SETUP_GUIDE_DEFAULT = 'https://wso2.com/integration-platform/docs/manage/icp/observability-setup';
export const OPENSEARCH_SETUP_GUIDE_MI = 'https://mi.docs.wso2.com/en/latest/install-and-setup/install/adding-observability-for-icp/';

// A collapsible step section. Each main step from the observability user story is
// rendered as an accordion so the setup flow stays compact; the first step is
// expanded by default.
export function MoesifStep({ title, defaultExpanded, children }: { title: string; defaultExpanded?: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <Accordion defaultExpanded={defaultExpanded} disableGutters sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 1.5, '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ChevronDown size={18} />} sx={{ bgcolor: 'action.hover', '&:hover': { bgcolor: 'action.selected' } }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 2 }}>{children}</AccordionDetails>
    </Accordion>
  );
}
