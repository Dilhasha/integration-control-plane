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

import { useState } from 'react';
import type { JSX } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@wso2/oxygen-ui';
import { useAuth } from '../auth/AuthContext';
import { clearNotAuthorized, getNotAuthorized } from '../auth/tokenManager';
import { loginUrl } from '../paths';

const FALLBACK_MESSAGE = 'Your account is not authorized to access this instance. ' + 'Contact your administrator to have your identity provider groups mapped.';

interface NotAuthorizedProps {
  /** Server message. Omitted when rendered as a route, where it comes from storage. */
  message?: string;
  /** The identity the user just authenticated as, so they can quote it to their admin. */
  username?: string;
}

/**
 * Terminal state for "authenticated, but not authorized to use this instance".
 *
 * Deliberately not framed as an error: nothing is broken, and retrying always
 * fails. The IdP session is still valid, so signing in again would silently
 * re-authenticate and land straight back here — which is why signing out is the
 * primary action rather than a retry.
 */
export default function NotAuthorized({ message, username }: NotAuthorizedProps): JSX.Element {
  const { logout } = useAuth();
  const [stored] = useState(() => (message === undefined ? getNotAuthorized() : null));
  const [signingOut, setSigningOut] = useState(false);

  const shownMessage = message ?? stored?.message ?? FALLBACK_MESSAGE;
  const shownUsername = username ?? stored?.username;

  const handleSignOut = async () => {
    setSigningOut(true);
    clearNotAuthorized();
    await logout();
    window.location.href = loginUrl();
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default', p: 3 }}>
      <Box sx={{ maxWidth: 520, textAlign: 'center' }}>
        <Typography variant="h5" sx={{ mb: 2 }}>
          You&apos;re signed in, but you don&apos;t have access to this instance yet.
        </Typography>
        <Alert severity="warning" sx={{ mb: 3, textAlign: 'left' }}>
          {shownMessage}
        </Alert>
        {shownUsername && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Signed in as <strong>{shownUsername}</strong>
          </Typography>
        )}
        <Stack direction="row" spacing={2} justifyContent="center">
          <Button variant="contained" onClick={handleSignOut} disabled={signingOut}>
            Sign out
          </Button>
          <Button variant="outlined" href={loginUrl()}>
            Return to Login
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
