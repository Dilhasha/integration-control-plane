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

import { createContext, useContext, type JSX, type ReactNode } from 'react';

export interface LayoutState {
  /** Current width (px) of the left navigation sidebar; changes with its collapsed/expanded state. */
  sidebarWidth: number;
}

// Default 0 so consumers rendered outside AppLayout (e.g. public pages) fall back to full width.
const LayoutContext = createContext<LayoutState>({ sidebarWidth: 0 });

export function LayoutProvider({ value, children }: { value: LayoutState; children: ReactNode }): JSX.Element {
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

/** Reads layout metrics (currently the live sidebar width) shared by AppLayout. */
// eslint-disable-next-line react-refresh/only-export-components
export const useLayout = (): LayoutState => useContext(LayoutContext);
