#!/usr/bin/env node
/**
 * One-time Google Calendar OAuth helper for BBL Studio booking.
 *
 * Prerequisites (about 5 minutes):
 * 1. Open https://console.cloud.google.com/ and create/select a project
 * 2. Enable "Google Calendar API"
 * 3. APIs & Services → OAuth consent screen → External → add your Google account as a test user
 * 4. Credentials → Create Credentials → OAuth client ID → Application type: Desktop app
 * 5. Copy Client ID and Client Secret
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-calendar-auth.mjs
 *
 * The script opens a local callback, prints GOOGLE_REFRESH_TOKEN for Vercel.
 * Never commit tokens. Never put them in client-side code.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const port = Number(process.env.BOOKING_OAUTH_PORT || 8765);
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment first.');
  process.exit(1);
}

const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar');
const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&response_type=code` +
  `&scope=${scope}` +
  `&access_type=offline` +
  `&prompt=consent`;

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true });
  else if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  else spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
}

console.log('\nAdd this Authorized redirect URI to the OAuth client if prompted:');
console.log(`  ${redirectUri}`);
console.log('\nOpening Google consent in your browser…\n');
console.log(authUrl);
console.log('');

openBrowser(authUrl);

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const value = url.searchParams.get('code');
      if (error || !value) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Authorization failed. You can close this tab.');
        server.close();
        reject(new Error(error || 'missing_code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p>Authorization received. Return to the terminal. You can close this tab.</p>');
      server.close();
      resolve(value);
    } catch (err) {
      reject(err);
    }
  });
  server.listen(port, '127.0.0.1');
  setTimeout(() => {
    server.close();
    reject(new Error('Timed out waiting for Google OAuth callback (5 minutes).'));
  }, 5 * 60 * 1000);
});

const body = new URLSearchParams({
  code,
  client_id: clientId,
  client_secret: clientSecret,
  redirect_uri: redirectUri,
  grant_type: 'authorization_code',
});

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
});

const data = await response.json();
if (!response.ok || !data.refresh_token) {
  console.error('Token exchange failed:', data.error || data);
  if (data.access_token && !data.refresh_token) {
    console.error(
      'Google returned no refresh_token. Remove prior access for this app at https://myaccount.google.com/permissions and retry.',
    );
  }
  process.exit(1);
}

console.log('\nSuccess. Add these to Vercel → Project → Settings → Environment Variables (Production):\n');
console.log(`GOOGLE_CLIENT_ID=${clientId}`);
console.log('GOOGLE_CLIENT_SECRET=<your client secret>');
console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
console.log('GOOGLE_CALENDAR_ID=primary');
console.log('\nOptional:');
console.log('BOOKING_HOST_EMAIL=hello@bbl.studio');
console.log('BOOKING_EMAIL_MODE=send   # only if you want Resend confirmation emails');
console.log('\nDo not commit these values. Do not put them in frontend code.\n');
