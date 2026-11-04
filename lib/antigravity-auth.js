import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

// agy uses go-keyring: service "gemini", account "antigravity".
// Read only that entry; never enumerate credentials or write back to agy's store.
export function keyringCommand(osPlatform = platform()) {
  if (osPlatform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./read-antigravity-keyring.ps1', import.meta.url))],
    };
  }
  if (osPlatform === 'darwin') {
    return { file: '/usr/bin/security', args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'] };
  }
  return { file: 'secret-tool', args: ['lookup', 'service', 'gemini', 'username', 'antigravity'] };
}

export function parseAntigravityCliCredential(text) {
  let value = String(text || '').trim().replace(/^\uFEFF/, '');
  // go-keyring encodes macOS passwords before storing them.
  if (value.startsWith('go-keyring-base64:')) value = Buffer.from(value.slice(18), 'base64').toString('utf8');
  else if (value.startsWith('go-keyring-encoded:')) value = Buffer.from(value.slice(19), 'hex').toString('utf8');
  if (!value) return null;
  let profile;
  try { profile = JSON.parse(value); } catch { throw new Error('Invalid agy CLI keyring credential. Run agy and sign in again.'); }
  if (!profile || typeof profile !== 'object') {
    throw new Error('Invalid agy CLI keyring credential. Run agy and sign in again.');
  }
  if (profile.auth_method !== 'consumer') {
    throw new Error('agy CLI uses enterprise authentication; personal subscription quota requires a consumer Google sign-in.');
  }
  const token = profile.token;
  if (!token || (token.access_token != null && typeof token.access_token !== 'string')
    || (token.refresh_token != null && typeof token.refresh_token !== 'string')
    || (!token.access_token && !token.refresh_token)) {
    throw new Error('No OAuth token in agy CLI keyring. Run agy and sign in again.');
  }
  const expiry = Date.parse(token.expiry);
  if (token.expiry && !Number.isFinite(expiry)) {
    throw new Error('Invalid agy CLI token expiry. Run agy and sign in again.');
  }
  return {
    accessToken: typeof token.access_token === 'string' ? token.access_token : '',
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : '',
    expirySeconds: Number.isFinite(expiry) ? expiry / 1000 : null,
  };
}

export async function readAntigravityCliCredential({ osPlatform = platform(), run = execFile } = {}) {
  const { file, args } = keyringCommand(osPlatform);
  const value = await new Promise((resolve, reject) => {
    run(file, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      // security uses 44 for a missing item; secret-tool returns 1 with no stderr.
      if ((osPlatform === 'darwin' && error.code === 44)
        || (osPlatform === 'linux' && error.code === 1 && !String(stderr || '').trim())) return resolve('');
      // Do not propagate child-process output: it can contain the secret.
      reject(new Error(osPlatform === 'linux' && error.code === 'ENOENT'
        ? 'Cannot read agy CLI keyring: install secret-tool (libsecret-tools) and unlock your desktop keyring.'
        : 'Cannot read agy CLI system keyring. Run TokensLeft as the same OS user as agy and unlock the keyring.'));
    });
  });
  return parseAntigravityCliCredential(value);
}
