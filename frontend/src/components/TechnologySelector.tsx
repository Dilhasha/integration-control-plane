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

import { Box, Card, CardContent, Typography } from '@wso2/oxygen-ui';
import { useRef, type JSX } from 'react';
import { TECH_OPTIONS, type Technology } from '../constants/technologies';

interface TechnologySelectorProps {
  selected: Technology;
  onSelect: (tech: Technology) => void;
}

/**
 * Card picker for the integration runtime, mirroring the devant integration-create
 * flow. Exposed as a radio group so the choice is reachable by keyboard and
 * addressable by role in tests — the cards are not native inputs.
 *
 * Keyboard model is the standard radio-group one: a roving tabIndex puts a single
 * stop in the tab order, and the arrow keys move the selection between options.
 */
export default function TechnologySelector({ selected, onSelect }: TechnologySelectorProps): JSX.Element {
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  const moveSelection = (from: number, delta: number) => {
    const next = (from + delta + TECH_OPTIONS.length) % TECH_OPTIONS.length;
    onSelect(TECH_OPTIONS[next].id);
    cardRefs.current[next]?.focus();
  };

  return (
    <Box role="radiogroup" aria-label="Technology" sx={{ display: 'flex', gap: 2 }}>
      {TECH_OPTIONS.map((opt, index) => {
        const isActive = selected === opt.id;
        return (
          <Card
            key={opt.id}
            ref={(el: HTMLDivElement | null) => {
              cardRefs.current[index] = el;
            }}
            role="radio"
            aria-checked={isActive}
            aria-label={opt.label}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(opt.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(opt.id);
                return;
              }
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                moveSelection(index, 1);
                return;
              }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                moveSelection(index, -1);
              }
            }}
            sx={{
              width: '25%',
              minWidth: 180,
              border: 2,
              borderColor: isActive ? 'primary.main' : 'divider',
              bgcolor: isActive ? 'primary.50' : 'background.paper',
              cursor: 'pointer',
              transition: 'border-color 0.15s, background-color 0.15s',
              '&:hover': { borderColor: isActive ? 'primary.main' : 'primary.light' },
            }}>
            <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ display: 'flex', color: isActive ? 'primary.main' : 'text.secondary', flexShrink: 0 }}>{opt.icon}</Box>
                <Typography variant="body2" fontWeight={600} sx={{ color: isActive ? 'primary.main' : 'text.primary' }}>
                  {opt.label}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        );
      })}
    </Box>
  );
}
