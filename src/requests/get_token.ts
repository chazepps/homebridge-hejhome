import ky, { HTTPError } from 'ky';
import validator from 'validator';
import { HejhomePlatform } from '../platform.js';

export const HEJ_CLIENT_ID = '62f4020744ca4510827d3b4a4d2c7e7f';
export const HEJ_CLIENT_SECRET = 'fcd4302cece447a9ab009296f649d2c0';

/**
 * Generates a Basic Auth string from the provided credentials.
 * @param {string} id - The client ID.
 * @param {string} pw - The client secret.
 * @returns {string} - The Basic Auth string.
 */
const makeAuth = (id: string, pw: string): string => {
  return `Basic ${btoa(`${id}:${pw}`)}`;
};

/**
 * Retrieves the JSESSIONID from the authentication response.
 * @param {string} auth - The Basic Auth string.
 * @returns {Promise<string | undefined>} - The JSESSIONID.
 */
const getJSessionId = async (auth: string): Promise<string | undefined> => {
  const response = await ky.post(
    'https://square.hej.so/oauth/login?vendor=shop',
    {
      headers: {
        authorization: auth,
      },
    },
  );

  const setCookieHeader = response.headers.get('set-cookie');
  return setCookieHeader?.match(/JSESSIONID=([^;]+)/)?.[1];
};

/**
 * Retrieves the authorization code using the provided cookie.
 * @param {string} cookie - The cookie string.
 * @returns {Promise<string | null>} - The authorization code.
 */
const getAuthorizationCode = async (cookie: string): Promise<string | null> => {
  let code: string | null = null;
  try {
    await ky.get(
      `https://square.hej.so/oauth/authorize?client_id=${HEJ_CLIENT_ID}` +
      '&redirect_uri=https%3A%2F%2Fsquare.hej.so%2Flist&response_type=code&scope=shop',
      {
        headers: {
          cookie,
        },
        redirect: 'manual',
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const location = (error as HTTPError).response.headers.get('location');
    const codeMatch = location?.match(/code=([^&]+)/);
    code = codeMatch ? codeMatch[1] : null;
  }
  return code;
};

/**
 * Retrieves the token response using the provided authorization code.
 * @param {string} code - The authorization code.
 * @returns {Promise<Response>} - The token response.
 */
const getTokenResponse = async (code: string): Promise<Response> => {
  return await fetch('https://square.hej.so/oauth/token', {
    headers: {
      authorization: makeAuth(HEJ_CLIENT_ID, HEJ_CLIENT_SECRET),
      'content-type': 'application/x-www-form-urlencoded',
    },
    referrer: `https://square.hej.so/list?code=${code}`,
    referrerPolicy: 'strict-origin-when-cross-origin',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: HEJ_CLIENT_ID,
      redirect_uri: 'https://square.hej.so/list',
    }).toString(),
    method: 'POST',
    mode: 'cors',
    credentials: 'include',
  });
};

/**
 * Retrieves the access token for the platform.
 * @param {HejhomePlatform} platform - The platform instance.
 * @returns {Promise<string | undefined>} - The access token.
 */
export const getToken = async (
  platform: HejhomePlatform,
): Promise<string | undefined> => {
  const { email, password } = platform.config.credentials || {};

  if (!email || !password) {
    platform.log.error('Email and password are required');
    return;
  }

  if (!validator.isEmail(email)) {
    platform.log.error('Invalid email');
    return;
  }

  if (password.length < 4) {
    platform.log.error('Password must be at least 4 characters');
    return;
  }

  const auth = makeAuth(email, password);

  const jsessionId = await getJSessionId(auth);
  if (!jsessionId) {
    platform.log.error('Failed to retrieve JSESSIONID');
    return;
  }

  const username = encodeURIComponent(email);
  const cookie = `username=${username}; JSESSIONID=${jsessionId}`;
  const code = await getAuthorizationCode(cookie);
  if (!code) {
    platform.log.error('Failed to retrieve authorization code');
    return;
  }

  const tokenResponse = await getTokenResponse(code);
  const {
    access_token: accessToken,
  } = await tokenResponse.json();

  return accessToken;
};
