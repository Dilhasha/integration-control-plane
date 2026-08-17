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

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { IconButton, Tooltip } from '@wso2/oxygen-ui';
import { Check, Copy } from '@wso2/oxygen-ui-icons-react';

// Mirrors devant's EndpointUrlsPanel CopyButton — same 2s "Copied!" revert and icon sizing.
// Shared by EntryPoints.tsx and TestConsole.tsx so copy-to-clipboard affordances look identical.
export default function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const handleCopy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [value]);
  return (
    <Tooltip title={copied ? 'Copied!' : `Copy ${label}`}>
      <IconButton size="small" onClick={handleCopy} sx={{ p: 0.25, flexShrink: 0 }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </IconButton>
    </Tooltip>
  );
}
