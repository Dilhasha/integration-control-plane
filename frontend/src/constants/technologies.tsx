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

import type { ReactNode } from 'react';
import IntegratorIcon from '../assets/icons/IntegratorIcon';

export type Technology = 'MI' | 'BI';

/**
 * The runtimes an integration can be built on. `id` is the value persisted as
 * `componentType`; the labels match the devant integration-create flow so both
 * products name the same runtime the same way.
 */
export const TECH_OPTIONS: { id: Technology; label: string; icon: ReactNode }[] = [
  {
    id: 'BI',
    label: 'WSO2 Integrator',
    icon: <IntegratorIcon width={20} height={20} />,
  },
  {
    id: 'MI',
    label: 'WSO2 Integrator: MI',
    icon: <IntegratorIcon width={20} height={20} />,
  },
];

/**
 * Display label for a persisted `componentType`. Falls back to the raw value so a
 * runtime added server-side still renders something meaningful.
 */
export function technologyLabel(componentType: string): string {
  return TECH_OPTIONS.find((opt) => opt.id === componentType)?.label ?? componentType;
}
