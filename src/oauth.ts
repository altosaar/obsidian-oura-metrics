/**
 * Oura OAuth2, client-side (implicit) flow.
 *
 * Personal access tokens were retired in December 2025; every token now comes
 * from an OAuth application. The user registers their own application and
 * gives the plugin only its client ID. The implicit flow (`response_type=token`)
 * returns the access token straight in the redirect's fragment, so no client
 * secret is ever stored in the vault. The trade-off is that the flow issues no
 * refresh token: the access token lasts about 30 days, and then the user
 * reconnects.
 *
 * Free of Obsidian imports, like `oura.ts`, so it is testable in plain Node.
 */

export const AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';

/**
 * Oura sends the browser back to this after consent, and Obsidian routes it to the
 * plugin's protocol handler. It must be registered on the user's application.
 */
export const PROTOCOL_ACTION = 'oura-metrics';
export const REDIRECT_URI = `obsidian://${PROTOCOL_ACTION}`;

/**
 * Every scope the API documents except `email`, requested up front so a metric
 * added later doesn't need the user to widen access first. Only `daily` — sleep,
 * daily_sleep, daily_activity and daily_readiness — is read today; the user may
 * decline the rest on the consent page.
 */
export const SCOPES = [
	'daily',
	'personal',
	'heartrate',
	'workout',
	'tag',
	'session',
	'spo2',
	'heart_health',
];

export interface OuraGrant {
	accessToken: string;
	/** Epoch ms after which the token is dead, or 0 when Oura didn't say. */
	expiresAt: number;
}

export function authorizeUrl(clientId: string, state: string): string {
	const params = new URLSearchParams({
		response_type: 'token',
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(' '),
		state,
	});
	return `${AUTHORIZE_URL}?${params}`;
}

/** An unguessable `state`, tying the redirect to the authorization we started. */
export function newState(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The response fields from Obsidian's protocol handler. The implicit flow puts
 * them in the fragment, which Obsidian hands over raw as `hash`; an error may
 * arrive in the query instead, which Obsidian decodes into top-level params.
 */
export function fieldsFromProtocol(params: Record<string, string>): URLSearchParams {
	const fields = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (key !== 'action' && key !== 'hash') fields.set(key, value);
	}
	for (const [key, value] of new URLSearchParams(params.hash ?? '')) {
		fields.set(key, value);
	}
	return fields;
}

/**
 * Validate an implicit-grant response (RFC 6749 §4.2.2) and turn it into a grant,
 * or throw why not. Oura's fragment carries `access_token`, `token_type=bearer`,
 * `expires_in` (seconds; 2591999, about 30 days), `state` and `scope`, plus
 * `claims` and `iss`, which we don't need.
 *
 * `scope` is deliberately not checked. Oura's value doesn't read as the RFC's
 * space-separated list, and a token that truly lacks `daily` is caught anyway:
 * the API answers 403, which `OuraClient` explains.
 */
export function parseAuthorizationResponse(
	fields: URLSearchParams,
	expectedState: string,
	now: number,
): OuraGrant {
	const error = fields.get('error');
	if (error) {
		const detail = fields.get('error_description');
		throw new Error(
			error === 'access_denied'
				? 'Access was denied on the Oura consent page.'
				: `Oura returned “${error}”${detail ? `: ${detail}` : ''}.`,
		);
	}

	const accessToken = fields.get('access_token');
	if (!accessToken) {
		throw new Error('Oura’s reply had no access token. Click Connect again.');
	}

	// Without this, anything able to open an obsidian:// link could plant a token.
	if (!expectedState) {
		throw new Error('No connection is in progress. Click Connect first.');
	}
	if (fields.get('state') !== expectedState) {
		throw new Error('That response doesn’t match the connection started here. Click Connect again.');
	}

	// Every API call sends `Authorization: Bearer …`, so no other kind will do.
	const tokenType = fields.get('token_type');
	if (tokenType !== null && tokenType.toLowerCase() !== 'bearer') {
		throw new Error(`Oura issued a “${tokenType}” token; only bearer tokens are supported.`);
	}

	const expiresIn = Number(fields.get('expires_in'));
	return {
		accessToken,
		expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0,
	};
}

export function isExpired(expiresAt: number, now: number): boolean {
	return expiresAt > 0 && now >= expiresAt;
}
